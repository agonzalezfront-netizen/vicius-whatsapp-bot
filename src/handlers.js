import { generarRespuesta } from './claude.js';
import { estaAbierto, mensajeCerrado } from './horario.js';

const HISTORY_MAX_TURNS = parseInt(process.env.HISTORY_MAX_TURNS ?? '12', 10);
const JITTER_MIN = parseInt(process.env.JITTER_MIN_MS ?? '800', 10);
const JITTER_MAX = parseInt(process.env.JITTER_MAX_MS ?? '3000', 10);
// Cuánto tiempo el bot queda en silencio para un cliente después de que el
// dueño intervino manualmente desde el teléfono. Tras este lapso sin nueva
// intervención humana, el bot retoma la conversación.
const OWNER_PAUSE_MS = parseInt(process.env.OWNER_PAUSE_MS ?? String(60 * 60 * 1000), 10);

const histories = new Map();

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

  const userText = extractText(msg);
  if (!userText) {
    logger.debug({ jid }, 'mensaje sin texto, ignorado');
    return;
  }

  if (isOwnerPaused(jid)) {
    logger.info({ jid }, 'cliente en pausa por intervención del dueño — bot no responde');
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

  pushHistory(jid, 'user', userText);
  const history = getHistory(jid).slice(0, -1);

  let respuesta;
  try {
    const result = await generarRespuesta({ menu, history, userMessage: userText });
    respuesta = result.texto;
    logger.info({ jid, in: result.usage?.input_tokens, out: result.usage?.output_tokens }, 'claude OK');
  } catch (err) {
    logger.error({ jid, err: err.message }, 'claude FALLA');
    respuesta = 'Disculpa, tuve un problema técnico. Déjame consultarle a la pareja y vuelvo en un ratito.';
  }

  await sleep(jitterDelay());
  await sock.sendPresenceUpdate('paused', jid);
  await sendBotMessage(sock, jid, { text: respuesta });
  pushHistory(jid, 'assistant', respuesta);
  logger.info({ jid, len: respuesta.length }, 'respuesta enviada');
}
