import { generarRespuesta } from './claude.js';
import { estaAbierto, mensajeCerrado } from './horario.js';
import { crearPedido, subirComprobante } from './pedidos-client.js';

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

const histories = new Map();

// jid → timestamp (ms) de la última interacción del cliente. Para gestión de sesión.
const lastInteraction = new Map();

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
  if (!prev) return 'nueva';
  if (fechaLocal(prev) !== fechaLocal(now)) {
    // cruce de día: el menú de ayer ya no existe → reset
    histories.delete(jid);
    return 'nueva';
  }
  if (now - prev > SESSION_MS) return 'resaludo';
  return 'continua';
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
    logger.info({ jid }, 'cliente en pausa por intervención del dueño — bot no responde');
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
      await sendBotMessage(sock, jid, {
        text: '¡Listo! Recibí tu comprobante. Tu pedido entró a preparación, tarda unos 15-20 minutos. Te aviso cuando esté en camino. 🍽️',
      });
      logger.info({ jid, pedidoId }, '🧾 comprobante subido + pedido a preparación');
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

  // El cliente NO debe ver el bloque <<PEDIDO>>. Recortarlo siempre.
  const { limpio, pedido } = extraerPedido(respuesta);
  respuesta = limpio;
  if (pedido) {
    try {
      const res = await crearPedido({
        cliente_jid: jid,
        cliente_nombre: senderName,
        items: pedido.items,
        total: pedido.total,
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
