import { generarRespuesta } from './claude.js';
import { estaAbierto, mensajeCerrado } from './horario.js';
import { crearPedido, subirComprobante } from './pedidos-client.js';
import { getActiveMenu } from './active-menu.js';

const HISTORY_MAX_TURNS = parseInt(process.env.HISTORY_MAX_TURNS ?? '12', 10);
const JITTER_MIN = parseInt(process.env.JITTER_MIN_MS ?? '800', 10);
const JITTER_MAX = parseInt(process.env.JITTER_MAX_MS ?? '3000', 10);
// Cuánto tiempo el bot queda en silencio para un cliente después de que el
// dueño intervino manualmente desde el teléfono. Tras este lapso sin nueva
// intervención humana, el bot retoma la conversación.
const OWNER_PAUSE_MS = parseInt(process.env.OWNER_PAUSE_MS ?? String(60 * 60 * 1000), 10);
// Sesión conversacional: tras este gap (mismo día) el bot re-saluda suave sin
// reenviar el menú completo. En un cruce de día se hace reset total.
const SESSION_MS = parseInt(process.env.SESSION_MS ?? String(45 * 60 * 1000), 10);
const TZ = process.env.TZ ?? 'America/Santiago';

// ── FRENOS anti-loop / anti-abuso / anti-regateo (todos en código, no LLM) ──
// Tope de turnos del bot por sesión: tras esto, derivar a humano. Anti-loop/troll.
const MAX_TURNS_SESSION = parseInt(process.env.MAX_TURNS_SESSION ?? '30', 10);
// Menciones de descuento/regateo antes de cortar y derivar (resuelve regateo-terco).
const MAX_DESCUENTO = parseInt(process.env.MAX_DESCUENTO ?? '3', 10);
// Rate-limit por número: máx N mensajes en la ventana. Anti-abuso/DoS.
const RATE_MAX = parseInt(process.env.RATE_MAX ?? '12', 10);
const RATE_WINDOW_MS = parseInt(process.env.RATE_WINDOW_MS ?? String(60 * 1000), 10);
// Cuánto queda pausado el bot tras dispararse un freno (deriva al humano).
const FRENO_PAUSE_MS = parseInt(process.env.FRENO_PAUSE_MS ?? String(30 * 60 * 1000), 10);
// Detección heurística de regateo/pedido de descuento en el texto del cliente.
const REGATEO_RE = /descuent|rebaj|m[áa]s barat|mas barat|haceme precio|hacem[eé] un precio|me lo dej[áa]s?|baj[áa] el precio|menos plata|2x1|2 x 1|promo|oferta|regal|gratis el|precio especial|tarif/i;

const histories = new Map();

// jid → timestamp (ms) de la última interacción del cliente. Para gestión de sesión.
const lastInteraction = new Map();

// Frenos: contadores por jid (se resetean al cambiar de sesión/cruce de día).
const turnCount = new Map();       // turnos del bot en la sesión
const descuentoCount = new Map();  // menciones de descuento en la sesión
const rateLog = new Map();         // jid → timestamps de mensajes recientes (rate-limit)

// jid → pedidoId del pedido en curso esperando comprobante de transferencia.
// En memoria (v0.1): si el container reinicia entre "pedido confirmado" y "llega
// comprobante", se pierde el link. Ventana de minutos, aceptable para piloto.
const pedidosEnCurso = new Map();

// jid → timestamp (ms) de la última intervención manual del dueño en ese chat.
// Mientras Date.now() - ts < OWNER_PAUSE_MS, el bot NO responde a ese cliente.
const pausedJids = new Map();

// IDs de mensajes que el propio bot envió. Sirve para distinguir un eco de
// nuestro sendMessage (fromMe=true) de una intervención humana real
// (también fromMe=true, pero escrita a mano desde el teléfono del Business).
const botSentIds = new Set();
const BOT_SENT_IDS_MAX = 500;

export function clearAllHistories() {
  const n = histories.size;
  histories.clear();
  return n;
}

function getHistory(jid) {
  if (!histories.has(jid)) histories.set(jid, []);
  return histories.get(jid);
}

function pushHistory(jid, role, content) {
  const h = getHistory(jid);
  h.push({ role, content });
  while (h.length > HISTORY_MAX_TURNS * 2) h.shift();
}

function rememberBotSentId(id) {
  if (!id) return;
  botSentIds.add(id);
  if (botSentIds.size > BOT_SENT_IDS_MAX) {
    // Drop el más viejo (Set mantiene orden de inserción).
    const oldest = botSentIds.values().next().value;
    botSentIds.delete(oldest);
  }
}

function isOwnerPaused(jid) {
  const ts = pausedJids.get(jid);
  if (!ts) return false;
  if (Date.now() - ts >= OWNER_PAUSE_MS) {
    pausedJids.delete(jid);
    return false;
  }
  return true;
}

async function sendBotMessage(sock, jid, payload) {
  const sent = await sock.sendMessage(jid, payload);
  rememberBotSentId(sent?.key?.id);
  return sent;
}

function jitterDelay() {
  return JITTER_MIN + Math.floor(Math.random() * (JITTER_MAX - JITTER_MIN));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fechaLocal(ts) {
  // YYYY-MM-DD en la TZ del local, para detectar cruce de día.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts));
}

// Evalúa el estado de sesión para este cliente. Devuelve 'nueva' (cruce de día o
// primer contacto → reset + menú), 'continua' (gap ≤ 45min) o 'resaludo' (mismo
// día pero gap > 45min → re-saludo suave sin menú completo).
function evaluarSesion(jid, now) {
  const prev = lastInteraction.get(jid);
  lastInteraction.set(jid, now);
  if (!prev) {
    resetFrenos(jid);
    return 'nueva';
  }
  if (fechaLocal(prev) !== fechaLocal(now)) {
    // cruce de día: el menú de ayer ya no existe → reset (incluye frenos)
    histories.delete(jid);
    resetFrenos(jid);
    return 'nueva';
  }
  if (now - prev > SESSION_MS) {
    // sesión nueva tras gap largo → reset de contadores de frenos
    resetFrenos(jid);
    return 'resaludo';
  }
  return 'continua';
}

function resetFrenos(jid) {
  turnCount.set(jid, 0);
  descuentoCount.set(jid, 0);
}

// Rate-limit por número: registra el mensaje y devuelve true si está dentro del
// límite, false si lo excede (en esa ventana móvil).
function pasaRateLimit(jid, now) {
  const arr = (rateLog.get(jid) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateLog.set(jid, arr);
  return arr.length <= RATE_MAX;
}

// Activa un freno: pausa el bot para ese jid (deriva al humano) y devuelve el
// mensaje de derivación a enviar (una sola vez).
function dispararFreno(jid, motivo, logger) {
  pausedJids.set(jid, Date.now());
  logger.warn({ jid, motivo }, '🛑 freno disparado — bot pausado, derivado a humano');
}

const normaliza = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

// Defensa en profundidad (Fix 1): devuelve la lista de nombres de ítems del
// pedido que NO matchean el menú activo habilitado (proteínas, agregados,
// extras, especiales). Normaliza acentos/mayúsculas. Si no hay menú activo,
// no valida (devuelve []). Es telemetría — no bloquea el pedido.
function validarItemsPedido(items) {
  const menu = getActiveMenu();
  if (!menu || !Array.isArray(items)) return [];
  const proteinas = new Set((menu.proteinas_dia ?? []).map((p) => normaliza(p.nombre)));
  const agregados = new Set((menu.agregados_incluidos ?? []).map(normaliza));
  const extras = new Set((menu.extras_pagados ?? []).map((e) => normaliza(e.nombre)));
  const especiales = new Set((menu.platos_especiales ?? []).map((e) => normaliza(e.nombre)));
  const fuera = [];
  for (const it of items) {
    const prot = normaliza(it.proteina);
    if (prot && !proteinas.has(prot) && !especiales.has(prot)) fuera.push(it.proteina);
    for (const a of it.agregados ?? []) {
      if (a && !agregados.has(normaliza(a))) fuera.push(a);
    }
    for (const x of it.extras ?? []) {
      if (x && !extras.has(normaliza(x))) fuera.push(x);
    }
  }
  return fuera;
}

function formatCLP(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

// CÁLCULO DETERMINISTA: el LLM no suma. Declara las líneas de precio en
// <<CALC>>[7000,2000,...]<<FIN>> y escribe "{{TOTAL}}" donde va el monto.
// Acá sumamos el array, reemplazamos {{TOTAL}}, recortamos el bloque, y
// devolvemos { limpio, total } (total = número o null si no hubo <<CALC>>).
function procesarCalc(texto) {
  const m = texto.match(/<<CALC>>([\s\S]*?)<<FIN>>/);
  let total = null;
  let limpio = texto;
  if (m) {
    try {
      const arr = JSON.parse(m[1].trim());
      if (Array.isArray(arr)) {
        total = arr.reduce((a, x) => a + (Number(x) || 0), 0);
      }
    } catch {
      total = null;
    }
    limpio = limpio.replace(/<<CALC>>[\s\S]*?<<FIN>>/g, '').trim();
  }
  // Reemplazar el placeholder {{TOTAL}} por el monto (o quitarlo si no hay cálculo).
  if (total !== null) {
    limpio = limpio.replace(/\{\{TOTAL\}\}/g, formatCLP(total));
  } else {
    limpio = limpio.replace(/\{\{TOTAL\}\}/g, '').trim();
  }
  // Colapsar saltos de línea triples que deja el bloque recortado.
  limpio = limpio.replace(/\n{3,}/g, '\n\n');
  return { limpio, total };
}

// Recorta el bloque <<PEDIDO>>...<<FIN>> del texto (el cliente NO lo ve) y
// devuelve { limpio, pedido } con el JSON parseado (o null si no hay/no parsea).
function extraerPedido(texto) {
  const m = texto.match(/<<PEDIDO>>([\s\S]*?)<<FIN>>/);
  if (!m) return { limpio: texto, pedido: null };
  const limpio = texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/, '').trim();
  try {
    return { limpio, pedido: JSON.parse(m[1].trim()) };
  } catch {
    return { limpio, pedido: null };
  }
}

function extractText(msg) {
  return (
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    msg.message?.imageMessage?.caption ??
    msg.message?.videoMessage?.caption ??
    null
  );
}

export async function handleMessage({ sock, logger, menu, msg }) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  // fromMe=true → o es un eco de lo que el bot mandó, o es el dueño escribiendo
  // a mano desde el teléfono. Si el id NO está en botSentIds, es intervención
  // humana: pausamos el bot para ese cliente.
  if (msg.key.fromMe) {
    const id = msg.key.id;
    if (id && botSentIds.has(id)) {
      botSentIds.delete(id); // eco propio, lo consumimos
      return;
    }
    pausedJids.set(jid, Date.now());
    logger.info({ jid }, '👤 intervención manual del dueño — bot en pausa para este cliente');
    return;
  }

  if (isOwnerPaused(jid)) {
    logger.info({ jid }, 'cliente en pausa por intervención del dueño / freno — bot no responde');
    return;
  }

  // FRENO 3 — rate-limit por número (anti-abuso/DoS). Si el cliente excede el
  // límite en la ventana, el bot deja de responderle (silencioso) hasta que baje.
  if (!pasaRateLimit(jid, Date.now())) {
    logger.warn({ jid }, '🛑 rate-limit excedido — mensaje ignorado');
    return;
  }

  // ¿Es una imagen y hay un pedido en curso esperando comprobante? Subirla.
  if (msg.message?.imageMessage && pedidosEnCurso.has(jid)) {
    const pedidoId = pedidosEnCurso.get(jid);
    try {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const mime = msg.message.imageMessage.mimetype ?? 'image/jpeg';
      await subirComprobante(pedidoId, buffer, mime);
      pedidosEnCurso.delete(jid);
      lastInteraction.set(jid, Date.now());
      await sock.readMessages([msg.key]);
      await sleep(jitterDelay());
      // B1: el bot NO confirma el pago. Queda pendiente de validación humana.
      // MSG-1 (spec gestor de pedidos): "en proceso de confirmación", NO "entró a cocina".
      await sendBotMessage(sock, jid, {
        text: '¡Recibí tu comprobante! 🙌 Tu pago está en proceso de confirmación. Apenas la pareja lo valide te aviso y tu pedido entra a cocina. Es un ratito 🙂',
      });
      logger.info({ jid, pedidoId }, '🧾 comprobante subido → pendiente_validacion (NO confirmado, espera validación humana)');
    } catch (err) {
      logger.error({ jid, pedidoId, err: err.message }, 'subirComprobante FALLA');
      await sendBotMessage(sock, jid, {
        text: 'Recibí tu imagen pero tuve un problema al procesarla. Déjame consultarle a la pareja.',
      });
    }
    return;
  }

  const userText = extractText(msg);
  if (!userText) {
    logger.debug({ jid }, 'mensaje sin texto, ignorado');
    return;
  }

  const senderName = msg.pushName ?? 'cliente';
  logger.info({ jid, senderName, len: userText.length }, 'mensaje entrante');

  if (!estaAbierto(menu)) {
    await sleep(jitterDelay());
    await sendBotMessage(sock, jid, { text: mensajeCerrado() });
    logger.info({ jid }, 'fuera de horario, respondido con mensaje de cierre');
    return;
  }

  await sock.readMessages([msg.key]);
  await sock.sendPresenceUpdate('composing', jid);

  const sesion = evaluarSesion(jid, Date.now());
  logger.info({ jid, sesion }, 'estado de sesión');

  // FRENO 1 — contador de regateo. Si el cliente insiste con descuentos más de
  // MAX_DESCUENTO veces, el bot deriva al humano y se pausa (el prompt solo no
  // alcanza: el juez del QA exige una derivación formal "del sistema").
  if (REGATEO_RE.test(userText)) {
    const n = (descuentoCount.get(jid) ?? 0) + 1;
    descuentoCount.set(jid, n);
    if (n > MAX_DESCUENTO) {
      dispararFreno(jid, 'regateo-insistente', logger);
      await sleep(jitterDelay());
      await sendBotMessage(sock, jid, {
        text: 'Sobre el precio ya está todo dicho 🙂. Le aviso a Carla y César que querías hablar de eso y, si surge algo, te escriben. Por acá te ayudo con tu pedido al precio del menú cuando quieras.',
      });
      logger.info({ jid, descuento: n }, '🛑 freno regateo → derivado');
      return;
    }
  }

  // FRENO 2 — tope de turnos por sesión (anti-loop/troll). Tras MAX_TURNS_SESSION
  // respuestas del bot en la sesión, deriva al humano y se pausa.
  const turnos = (turnCount.get(jid) ?? 0) + 1;
  turnCount.set(jid, turnos);
  if (turnos > MAX_TURNS_SESSION) {
    dispararFreno(jid, 'tope-turnos', logger);
    await sleep(jitterDelay());
    await sendBotMessage(sock, jid, {
      text: 'Para no marearte con tantos mensajes, te dejo con Carla y César para que terminen tu pedido 🙂. Ya les avisé.',
    });
    logger.info({ jid, turnos }, '🛑 freno tope de turnos → derivado');
    return;
  }

  pushHistory(jid, 'user', userText);
  const history = getHistory(jid).slice(0, -1);

  let respuesta;
  try {
    const result = await generarRespuesta({ menu, history, userMessage: userText, sesion });
    respuesta = result.texto;
    logger.info({ jid, in: result.usage?.input_tokens, out: result.usage?.output_tokens }, 'claude OK');
  } catch (err) {
    logger.error({ jid, err: err.message }, 'claude FALLA');
    respuesta = 'Disculpa, tuve un problema técnico. Déjame consultarle a la pareja y vuelvo en un ratito.';
  }

  // CÁLCULO DETERMINISTA: sumar el <<CALC>> y reemplazar {{TOTAL}} ANTES de
  // mostrar nada al cliente (el LLM no suma — ver claude.js). totalCalc es el
  // total real del carrito según el código, no según el modelo.
  const calc = procesarCalc(respuesta);
  respuesta = calc.limpio;

  // El cliente NO debe ver el bloque <<PEDIDO>>. Recortarlo siempre.
  const { limpio, pedido } = extraerPedido(respuesta);
  respuesta = limpio;
  if (pedido) {
    // El total del pedido es el calculado por código (si hubo <<CALC>>), no el del LLM.
    const totalPedido = calc.total !== null ? calc.total : pedido.total;
    // FRENO 4 — defensa en profundidad: validar ítems del pedido contra el menú
    // habilitado. NO bloquea (el matching de strings es frágil), pero loguea si
    // el LLM dejó pasar algo fuera de menú, para detectar fugas de la regla dura.
    const fuera = validarItemsPedido(pedido.items);
    if (fuera.length) logger.warn({ jid, fuera }, '⚠️ pedido con ítems posiblemente fuera del menú (revisar)');
    try {
      const res = await crearPedido({
        cliente_jid: jid,
        cliente_nombre: senderName,
        items: pedido.items,
        total: totalPedido,
        metodo_pago: pedido.metodo_pago,
        vuelto: pedido.vuelto ?? null,
        tipo: pedido.tipo,
        direccion: pedido.direccion ?? null,
        status: pedido.metodo_pago === 'transferencia' ? 'esperando_comprobante' : 'validado',
      });
      // Si es transferencia, guardamos el link jid→pedidoId para asociar el comprobante entrante.
      if (pedido.metodo_pago === 'transferencia') pedidosEnCurso.set(jid, res.id);
      logger.info({ jid, pedidoId: res.id, status: res.status }, '🧾 pedido creado en wizard');
    } catch (err) {
      logger.error({ jid, err: err.message }, 'crearPedido FALLA (el cliente igual recibe su confirmación)');
    }
  }

  await sleep(jitterDelay());
  await sock.sendPresenceUpdate('paused', jid);
  await sendBotMessage(sock, jid, { text: respuesta });
  pushHistory(jid, 'assistant', respuesta);
  logger.info({ jid, len: respuesta.length }, 'respuesta enviada');
}
