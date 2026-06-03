import { generarRespuesta } from './claude.js';
import { estaAbierto, mensajeCerrado } from './horario.js';

const HISTORY_MAX_TURNS = parseInt(process.env.HISTORY_MAX_TURNS ?? '12', 10);
const JITTER_MIN = parseInt(process.env.JITTER_MIN_MS ?? '800', 10);
const JITTER_MAX = parseInt(process.env.JITTER_MAX_MS ?? '3000', 10);

const histories = new Map();

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
  if (msg.key.fromMe) return;
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  const userText = extractText(msg);
  if (!userText) {
    logger.debug({ jid }, 'mensaje sin texto, ignorado');
    return;
  }

  const senderName = msg.pushName ?? 'cliente';
  logger.info({ jid, senderName, len: userText.length }, 'mensaje entrante');

  if (!estaAbierto(menu)) {
    await sleep(jitterDelay());
    await sock.sendMessage(jid, { text: mensajeCerrado() });
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
  await sock.sendMessage(jid, { text: respuesta });
  pushHistory(jid, 'assistant', respuesta);
  logger.info({ jid, len: respuesta.length }, 'respuesta enviada');
}
