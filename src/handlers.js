import { generarRespuesta, derivacionVerbal } from './claude.js';
import { estaAbierto, mensajeCerrado } from './horario.js';
import { crearPedido, subirComprobante, buscarPedidoEsperandoComprobante, estadoUltimoPedido } from './pedidos-client.js';
import { getActiveMenu } from './active-menu.js';
import { calcularPedido, construirResumen } from './precios.js';
import { registrarMensaje, botPausado, escalarAHumano } from './comunicaciones-client.js';
import { enviarPushEquipo } from './push.js';
import { manejarTurnoBotones } from './flujo-botones-router.js';

// Sección Comunicaciones (handoff v1). Flag OFF por default → comportamiento idéntico
// al actual (cero riesgo al deployar). ON cuando el wizard tenga los endpoints + la UI:
// el bot persiste cada mensaje in/out en la bandeja y respeta la pausa durable.
const COMUNICACIONES = (process.env.COMUNICACIONES_ENABLED ?? 'false') === 'true';
// Tier básico: si MODE=buttons, el bot toma pedidos 100% por botones SIN LLM (máquina de estados
// determinista). Default '' → flujo LLM de prod intacto (aislado, innegociable #1).
const MODE_BUTTONS = (process.env.MODE ?? '') === 'buttons';

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

// jid → firma (items+método+tipo) del último pedido CREADO en el wizard. El <<PEDIDO>>
// ahora se emite en varios mensajes (al mostrar el resumen y al confirmar el pago), así
// que el pedido se crea SOLO cuando hay método de pago y la firma cambió → evita
// recrear el mismo pedido si el LLM lo re-emite, y permite un 2º pedido distinto.
const ultimaFirmaCreada = new Map();

// jid → último array de items VÁLIDO (todas las proteínas presentes) emitido en la
// conversación. En multi-turno el LLM a veces re-emite el <<PEDIDO>> degradado
// (proteina:null — bug 2026-06-11: la sopa de gallina perdía su nombre y precios.js
// caía al precio del menú $7.000 en vez del propio $6.500). Carry-forward: si el
// PEDIDO nuevo trae items rotos, usamos los items del último válido (mismo patrón
// que el fix del total $0 del 10-jun).
const ultimosItemsValidos = new Map();

function itemsValidos(items) {
  return Array.isArray(items) && items.length > 0 &&
    items.every((it) => typeof it?.proteina === 'string' && it.proteina.trim());
}

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

export async function sendBotMessage(sock, jid, payload) {
  const sent = await sock.sendMessage(jid, payload);
  rememberBotSentId(sent?.key?.id);
  // Comunicaciones (handoff v1): registrar el saliente del bot en la bandeja
  // (fire-and-forget, best-effort). Estado inicial 'enviando'; el webhook de estados
  // lo avanza a sent/delivered/read después.
  if (COMUNICACIONES && payload?.text) {
    registrarMensaje({
      cliente_jid: jid, wa_message_id: sent?.key?.id, direction: 'out', sender: 'bot',
      type: 'text', text: payload.text, status: 'enviando',
    }).catch(() => {});
  }
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

// Instrumentación (encargo política general 2026-06-22): una línea PARSEABLE por CADA derivación a
// humano, con su motivo. Permite medir la TASA de derivación del piloto (grep 'DERIVACION') —el dato
// que necesitamos antes de amplificar la visibilidad y para saber qué cargar a INFO DEL LOCAL—.
// Motivos: marcador | deteccion-verbal | fuera-horario | freno:<submotivo>.
function logDerivacion(jid, motivo, logger) {
  logger.info({ jid, derivacion: motivo }, '📊 DERIVACION');
}

// Activa un freno: pausa el bot para ese jid (deriva al humano) y devuelve el
// mensaje de derivación a enviar (una sola vez). El freno ES una derivación → también marca
// requiere_humano para que aparezca en la bandeja de Comunicaciones (igual que el resto).
function dispararFreno(jid, motivo, logger) {
  pausedJids.set(jid, Date.now());
  logger.warn({ jid, motivo }, '🛑 freno disparado — bot pausado, derivado a humano');
  logDerivacion(jid, 'freno:' + motivo, logger);
  if (COMUNICACIONES) escalarAHumano(jid, 'freno:' + motivo).catch((e) => logger.warn({ jid, err: e.message }, 'escalar freno falló (no crítico)'));
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
// Aquí sumamos el array, reemplazamos {{TOTAL}}, recortamos el bloque, y
// devolvemos { limpio, total } (total = número o null si no hubo <<CALC>>).
export function procesarCalc(texto) {
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
// Mensaje sintético que refleja un estado de pedido avanzado por el PANEL (que el
// poller envió al cliente pero NUNCA entró al historial del chat). Se inyecta como
// último turno del asistente para que la conversación que ve Claude sea coherente
// con el estado real. Devuelve null para estados donde el historial YA es coherente
// (esperando_comprobante: el chat ya quedó esperando; rechazado: se maneja por prompt).
function mensajeEstadoSintetico(status) {
  switch (status) {
    case 'pendiente_validacion':
      return '¡Recibí tu comprobante! 🙌 Tu pago quedó en revisión, te aviso apenas Carla y César lo confirmen.';
    case 'en_cocina':
      return '¡Pago confirmado! ✅ Tu pedido ya entró a cocina 🍽️ Te aviso cuando vaya en camino.';
    case 'en_camino':
      return '¡Tu pedido va en camino! 🛵 Llega en un ratito. ¡Que lo disfrutes!';
    case 'listo':
      return '¡Tu pedido está listo! 🏠 Te esperamos para retirarlo cuando quieras.';
    case 'entregado':
      return '¡Tu pedido fue entregado! 🙂 Que lo disfrutes. ¡Gracias por elegir a El Sazón de Carla y César!';
    case 'retirado':
      return '¡Gracias por pasar a retirar tu pedido! 🙂 Que lo disfrutes.';
    default:
      return null;
  }
}

export function extraerPedido(texto) {
  const m = texto.match(/<<PEDIDO>>([\s\S]*?)<<FIN>>/);
  if (!m) return { limpio: texto, pedido: null, parseError: null };
  const limpio = texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/, '').trim();
  try {
    return { limpio, pedido: JSON.parse(m[1].trim()), parseError: null };
  } catch (e) {
    // FIX A (observabilidad): antes este catch era silencioso → no sabíamos si Haiku
    // emitea el bloque con JSON malformado. Ahora devolvemos el bloque crudo + el error
    // para loguearlo en el caller (bug 2026-06-08: pedido no creado, causa indistinguible).
    return { limpio, pedido: null, parseError: { raw: m[1].trim(), err: e.message } };
  }
}

// Marcador de máquina <<ESCALAR>>: el bot lo emite cuando deriva a la pareja (Comunicaciones
// handoff v1). Lo recortamos (el cliente NO lo ve) y devolvemos si estaba presente para que
// el caller marque la conversación como requiere_humano.
export function extraerEscalar(texto) {
  const escalar = /<<ESCALAR>>/.test(texto);
  const limpio = texto.replace(/<<ESCALAR>>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { limpio, escalar };
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

  // ── Tier básico (MODE=buttons): ruteo determinista por botones, SIN LLM. Aislado del flujo premium. ──
  if (MODE_BUTTONS) {
    if (!estaAbierto(menu)) { await sendBotMessage(sock, jid, { text: mensajeCerrado() }); return; }
    if (msg.message?.imageMessage) {
      // Comprobante de transferencia: subirlo al pedido esperando_comprobante del jid → el backend lo
      // pasa a 'pendiente_validacion' → aparece en el board "Por validar". Reusa la infra del flujo LLM
      // (sin IA). Antes escalaba sin subir → el pedido transferencia quedaba invisible (BUG3 2026-06-29).
      try {
        const pedidoId = await buscarPedidoEsperandoComprobante(jid);
        if (pedidoId) {
          const buffer = await sock.downloadImage(msg);
          await subirComprobante(pedidoId, buffer, msg.message.imageMessage.mimetype ?? 'image/jpeg');
          await sendBotMessage(sock, jid, { text: '¡Recibí tu comprobante! 🙂 El local lo valida y te confirma enseguida.' });
        } else {
          escalarAHumano(jid, 'comprobante-tier-basico').catch(() => {});
          await sendBotMessage(sock, jid, { text: 'Gracias 🙂. Si es un comprobante de pago, avisanos y lo validamos.' });
        }
      } catch (e) {
        // ESENCIAL (comprobante): NO fingir éxito. subirComprobante ya reintentó ante 5xx; si igual
        // falló, avisamos honesto + escalamos (el local lo toma a mano) — un comprobante "perdido" en
        // silencio es peor que pedir reenvío (encargo resiliencia integral 2026-06-29).
        logger.error({ jid, err: e.message }, 'tier básico: subir comprobante FALLA → aviso honesto + escalo');
        escalarAHumano(jid, 'comprobante-tier-basico').catch(() => {});
        await sendBotMessage(sock, jid, { text: 'Recibí tu imagen pero tuve un problema al guardarla 😕. Le avisé al local para que la revise; si no aparece, reenviámela en un ratito 🙂' });
      }
      return;
    }
    await manejarTurnoBotones({ sock, jid, senderName: msg.pushName ?? 'cliente', btnId: msg._btnId ?? null, texto: extractText(msg), logger });
    return;
  }

  // ── Comunicaciones (handoff v1): registrar el entrante + respetar pausa durable ──
  if (COMUNICACIONES) {
    const tipoEntrante = msg.message?.imageMessage ? 'image' : (msg.message?.audioMessage ? 'audio' : 'text');
    // Persistir para la bandeja (fire-and-forget, best-effort: no agrega latencia ni rompe).
    registrarMensaje({
      cliente_jid: jid, cliente_nombre: msg.pushName, wa_message_id: msg.key.id,
      direction: 'in', sender: 'cliente', type: tipoEntrante, text: extractText(msg) ?? '',
    }).catch((e) => logger.warn({ jid, err: e.message }, 'registrar mensaje entrante falló (no crítico)'));
    // Pausa durable: si un humano está atendiendo (en_atencion_humana en el wizard), el bot
    // NO responde en paralelo. Fail-open: si el wizard no responde, el bot sigue.
    if (await botPausado(jid)) {
      logger.info({ jid }, '⏸️ conversación en atención humana — bot pausado, no responde');
      return;
    }
  }

  // ¿Es una imagen? Puede ser el comprobante de transferencia. El link jid→pedidoId
  // (pedidosEnCurso) es in-memory y se PIERDE en cada redeploy de Railway → si el
  // cliente manda la foto después de un redeploy, el link desaparece y la imagen no
  // se asociaba (bug 2026-06-08). Fix: si no lo tenemos local, lo reconstruimos
  // preguntando al wizard (DB persistente) por el pedido más reciente de este jid que
  // sigue esperando comprobante. Así sobrevive redeploys.
  if (msg.message?.imageMessage) {
    let pedidoId = pedidosEnCurso.get(jid);
    if (!pedidoId) {
      try {
        pedidoId = await buscarPedidoEsperandoComprobante(jid);
        if (pedidoId) logger.info({ jid, pedidoId }, '🔁 link comprobante recuperado del wizard (pedidosEnCurso vacío tras redeploy)');
      } catch (err) {
        logger.warn({ jid, err: err.message }, 'no pude consultar pedido esperando comprobante en el wizard');
      }
    }
    if (!pedidoId) {
      // FIX C (red de seguridad): no había pedido en esperando_comprobante (Haiku no emitió
      // el <<PEDIDO>>, o el JSON no parseó). Creamos un pedido MÍNIMO ahora para que el
      // comprobante NUNCA se pierda: entra al panel con el jid + la foto; la dueña completa
      // los detalles con el cliente si faltan. (bug 2026-06-08: comprobante huérfano.)
      try {
        const res = await crearPedido({
          cliente_jid: jid, cliente_nombre: null, items: [], total: null,
          metodo_pago: 'transferencia', vuelto: null, tipo: null, direccion: null,
          status: 'esperando_comprobante',
        });
        pedidoId = res.id;
        logger.warn({ jid, pedidoId }, '🛟 red de seguridad: pedido mínimo creado al recibir comprobante (no había pedido emitido)');
      } catch (err) {
        logger.error({ jid, err: err.message }, 'red de seguridad: no pude crear el pedido mínimo para el comprobante');
      }
    }
    if (pedidoId) {
      try {
        // Descarga transport-agnostic: el sock (Baileys o Cloud API) provee downloadImage.
        const buffer = await sock.downloadImage(msg);
        const mime = msg.message.imageMessage.mimetype ?? 'image/jpeg';
        await subirComprobante(pedidoId, buffer, mime);
        pedidosEnCurso.delete(jid);
        lastInteraction.set(jid, Date.now());
        await sock.readMessages([msg.key]);
        await sleep(jitterDelay());
        // B1: el bot NO confirma el pago. Queda pendiente de validación humana.
        // MSG-1 (spec gestor de pedidos): "en proceso de confirmación", NO "entró a cocina".
        await sendBotMessage(sock, jid, {
          text: '¡Recibí tu comprobante! 🙌\n\nTu pago quedó *en revisión*. Carla y César lo confirman a mano y, apenas esté validado, te aviso aquí y tu pedido entra a cocina.\n\nEs un ratito 🙂',
        });
        logger.info({ jid, pedidoId }, '🧾 comprobante subido → pendiente_validacion (NO confirmado, espera validación humana)');
      } catch (err) {
        logger.error({ jid, pedidoId, err: err.message }, 'subirComprobante FALLA');
        await sendBotMessage(sock, jid, {
          text: 'Recibí tu imagen pero tuve un problema al procesarla 😕 Déjame avisarle a Carla y César y te ayudan enseguida.',
        });
      }
      return;
    }
    // Imagen sin ningún pedido esperando comprobante (ni local ni en el wizard) →
    // no es un comprobante esperado. Cae al flujo normal (Claude) más abajo.
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
    // Handoff v1 Fase 3: fuera de horario el bot no atiende → la conversación queda en
    // cola para que Carla/César la vean al abrir (requiere_humano, priorizada en la bandeja).
    if (COMUNICACIONES) {
      escalarAHumano(jid, 'fuera-horario').catch((e) => logger.warn({ jid, err: e.message }, 'escalar fuera-de-horario falló (no crítico)'));
    }
    logDerivacion(jid, 'fuera-horario', logger);
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
        text: 'Sobre el precio ya está todo dicho 🙂 Le aviso a Carla y César que querías hablarlo; si surge algo, te escriben. Por aquí te ayudo con tu pedido al precio del menú cuando quieras.',
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

  // Estado del último pedido del cliente → contexto para que el bot responda coherente
  // (ej. no pedir comprobante de un pedido ya entregado). Best-effort: si el wizard no
  // responde, seguimos sin el contexto (mejor responder sin estado que no responder).
  let estadoPedido = null;
  try {
    estadoPedido = await estadoUltimoPedido(jid);
  } catch (err) {
    logger.warn({ jid, err: err.message }, 'no pude consultar el estado del último pedido (no crítico)');
  }

  // El historial del chat NO incluye los avisos que el poller mandó al avanzar el
  // pedido por el panel (validado/en_camino/entregado...), así que queda ANCLADO en
  // el último turno conversacional (típicamente esperando el comprobante). Eso hacía
  // que el bot contradijera el estado real — bug 2026-06-10: dia "espero el
  // comprobante" con el pedido YA entregado, y el system prompt solo NO alcanzaba a
  // overridearlo (reproducido 12/12). Inyectamos un turno sintético del asistente con
  // el estado real para que la conversación que ve Claude sea coherente con la realidad.
  let historyAug = history;
  if (estadoPedido?.status) {
    const sint = mensajeEstadoSintetico(estadoPedido.status);
    if (sint) historyAug = [...history, { role: 'assistant', content: sint }];
  }

  let respuesta;
  try {
    const result = await generarRespuesta({ menu, history: historyAug, userMessage: userText, sesion, estadoPedido });
    respuesta = result.texto;
    logger.info({ jid, in: result.usage?.input_tokens, out: result.usage?.output_tokens }, 'claude OK');
  } catch (err) {
    logger.error({ jid, err: err.message }, 'claude FALLA');
    respuesta = 'Disculpa, tuve un problema técnico. Déjame consultarle a la pareja y vuelvo en un ratito.';
  }

  // El cliente NO debe ver el bloque <<PEDIDO>>. Recortarlo siempre.
  const { limpio, pedido, parseError } = extraerPedido(respuesta);
  respuesta = limpio;

  // Handoff v1: el bot emite <<ESCALAR>> cuando deriva a la pareja → recortarlo (el cliente
  // no lo ve) y marcar la conversación como requiere_humano (fire-and-forget, flag-gated).
  const esc = extraerEscalar(respuesta);
  respuesta = esc.limpio;
  // Red de seguridad determinista (bug 2026-06-22 + política general 2026-06-22): el bot a veces
  // deriva EN EL TEXTO ("déjame consultarle a la pareja") sin emitir <<ESCALAR>> → quedaba sin marcar
  // y seguía respondiendo. Detectamos la frase y marcamos requiere_humano igual. Mejor marcar de más.
  // Ya NO condicionamos a !pedido: la malla excluye por diseño el flujo de transferencia ("validar con
  // la pareja y te confirmo enseguida" NO matchea), así que una consulta fuera-de-flujo que caiga
  // DURANTE el pago también se atrapa (cierra el hueco §2 del encargo de política general).
  const derivoVerbal = derivacionVerbal(respuesta);
  const motivoDeriv = esc.escalar ? 'marcador' : (derivoVerbal ? 'deteccion-verbal' : null);
  if (motivoDeriv) {
    if (COMUNICACIONES) {
      escalarAHumano(jid, motivoDeriv).catch((e) => logger.warn({ jid, err: e.message }, 'escalarAHumano falló (no crítico)'));
      logger.info({ jid, via: motivoDeriv }, '🙋 conversación marcada requiere_humano');
    }
    logDerivacion(jid, motivoDeriv, logger);  // medir tasa de derivación aun si el flag está off
  }
  if (parseError) {
    logger.error(
      { jid, raw: parseError.raw?.slice(0, 600), err: parseError.err },
      '⚠️ <<PEDIDO>> emitido por Haiku pero el JSON NO parsea → resumen/pedido NO armado. Revisar el formato.',
    );
  }

  if (pedido) {
    // CARRY-FORWARD de items: si el <<PEDIDO>> re-emitido viene degradado (algún item
    // sin proteína), usamos los items del último PEDIDO válido de la conversación —
    // el LLM solo suele agregar metodo_pago/tipo en el último turno, los items ya
    // estaban bien en la emisión del resumen.
    if (itemsValidos(pedido.items)) {
      ultimosItemsValidos.set(jid, pedido.items);
    } else if (ultimosItemsValidos.has(jid)) {
      logger.warn({ jid, itemsRotos: JSON.stringify(pedido.items).slice(0, 200) },
        '⚠️ <<PEDIDO>> re-emitido con items degradados → carry-forward de los items del último PEDIDO válido');
      pedido.items = ultimosItemsValidos.get(jid);
    }

    // 🚨 CÁLCULO Y RESUMEN POR CÓDIGO (determinista) — directriz de Alberto 2026-06-10.
    // El LLM solo dice QUÉ pidió el cliente (items/extras/bebida); el CÓDIGO pone los
    // precios (config del menú), suma, y arma el texto del resumen. Así el total y el
    // desglose SIEMPRE cuadran — no depende de que Claude sume/redacte (fue la causa del
    // total $0 y del desglose que no cerraba). Ver precios.js.
    const calc = calcularPedido(pedido.items, pedido.tipo, getActiveMenu(), menu);
    // El LLM escribe {{RESUMEN}} donde va el resumen; lo reemplazamos por el de código.
    if (respuesta.includes('{{RESUMEN}}')) {
      respuesta = respuesta.replace(/\{\{RESUMEN\}\}/g, construirResumen(calc));
    }

    // FRENO 4 — defensa en profundidad: validar ítems contra el menú habilitado (loguea).
    const fuera = validarItemsPedido(pedido.items);
    if (fuera.length) logger.warn({ jid, fuera }, '⚠️ pedido con ítems posiblemente fuera del menú (revisar)');

    // CREAR el pedido en el wizard SOLO cuando hay método de pago (etapa de pago). El
    // <<PEDIDO>> también se emite al mostrar el resumen (sin pago) → ahí NO se crea.
    // Dedup por firma (items+método+tipo): no recrea si el LLM re-emite el mismo pedido.
    const firma = JSON.stringify({ i: pedido.items, m: pedido.metodo_pago, t: pedido.tipo });
    if (pedido.metodo_pago && ultimaFirmaCreada.get(jid) !== firma) {
      try {
        const res = await crearPedido({
          cliente_jid: jid,
          cliente_nombre: senderName,
          items: pedido.items,
          total: calc.total, // total por CÓDIGO, no del LLM
          // Desglose calculado por código (precios.js) persistido con el pedido: el
          // panel del gestor renderiza ESTE desglose (misma fuente que el resumen de
          // WhatsApp → consistentes por construcción) y los precios quedan congelados
          // al momento del pedido (consistente aunque el menú cambie después).
          desglose: calc,
          metodo_pago: pedido.metodo_pago,
          vuelto: pedido.vuelto ?? null,
          tipo: pedido.tipo,
          direccion: pedido.direccion ?? null,
          // efectivo/en_local: pago resuelto presencialmente (sin comprobante que validar) →
          // entra DIRECTO a cocina. Antes mandaba 'validado', pero ese status quedaba FUERA del
          // filtro del board (PEDIDO_ESTADOS_ACTIVOS) → el pedido era invisible para la cocina
          // (bug latente que afectaba efectivo y retiro local, hallado 2026-06-26). 'en_cocina' es
          // el status canónico de "pagado, a cocina" (el backend ya colapsa validado→en_cocina).
          status: pedido.metodo_pago === 'transferencia' ? 'esperando_comprobante' : 'en_cocina',
        });
        ultimaFirmaCreada.set(jid, firma);
        // Pedido creado: limpiar el carry-forward para que estos items no se filtren
        // a un PRÓXIMO pedido del mismo cliente.
        ultimosItemsValidos.delete(jid);
        // Si es transferencia, guardamos el link jid→pedidoId para asociar el comprobante.
        if (pedido.metodo_pago === 'transferencia') pedidosEnCurso.set(jid, res.id);
        logger.info({ jid, pedidoId: res.id, status: res.status, total: calc.total }, '🧾 pedido creado en wizard');
        // Pieza 3 (plan retiro local 2026-06-26) — avisar al dueño/cocina que ENTRÓ un pedido.
        // Push tipo "pedido-nuevo" (distinto de requiere_humano), tag único por pedido para que
        // ninguno se pise/colapse, y abre el board /pedidos al tocarlo. Aplica a delivery Y retiro:
        // la modalidad va BIEN VISIBLE en el título (texto confirmado por Alberto). Best-effort:
        // nunca rompe el flujo del cliente (si el push falla, el pedido ya quedó creado igual).
        const modalidad = pedido.tipo === 'delivery' ? 'DELIVERY' : 'RETIRO LOCAL';
        const itemsTxt = calc.lineas.map((l) => l.proteina).join(', ') || `${pedido.items.length} ítem(s)`;
        const ref = String(res.id).slice(-4).toUpperCase();
        enviarPushEquipo(
          {
            title: `🧾 Nuevo pedido — ${modalidad}`,
            body: `#${ref} · ${itemsTxt} · Total $${calc.total.toLocaleString('es-CL')}`,
            url: 'pedidos',
            tag: `pedido-nuevo-${res.id}`,
          },
          logger,
        ).catch(() => {});
      } catch (err) {
        // ESENCIAL (pedido): NO fingir éxito. crearPedido ya reintentó ante 5xx; si igual falló,
        // REEMPLAZAMOS la confirmación del LLM por un aviso honesto + escalamos (el local lo toma a
        // mano). Un pedido "perdido" en silencio es peor que pedir un momento (encargo 2026-06-29).
        // No seteamos ultimaFirmaCreada → el próximo mensaje reintenta crearlo.
        logger.error({ jid, err: err.message }, 'crearPedido FALLA → aviso honesto al cliente + escalo (NO finjo éxito)');
        escalarAHumano(jid, 'crear-pedido-falla').catch(() => {});
        respuesta = 'Uy, tuve un problema al registrar tu pedido 😕. Le avisé a Carla y César para que lo tomen a mano y te confirman en un momento. Disculpá la demora 🙏';
      }
    }
  }
  // Defensa: limpiar cualquier placeholder/bloque de máquina remanente que el cliente
  // no debe ver (por si el LLM dejó un {{RESUMEN}} sin <<PEDIDO>>, o un <<CALC>> viejo).
  respuesta = respuesta
    .replace(/<<CALC>>[\s\S]*?<<FIN>>/g, '')
    .replace(/\{\{RESUMEN\}\}/g, '')
    .replace(/\{\{TOTAL\}\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  await sleep(jitterDelay());
  await sock.sendPresenceUpdate('paused', jid);
  await sendBotMessage(sock, jid, { text: respuesta });
  pushHistory(jid, 'assistant', respuesta);
  logger.info({ jid, len: respuesta.length }, 'respuesta enviada');
}
