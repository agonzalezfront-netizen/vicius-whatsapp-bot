import { salientesPendientes, marcarSalienteEnviado, barrerTimeouts } from './comunicaciones-client.js';

// Handoff v1 Fase 2 — poller del saliente del HUMANO. Espejo del notif-poller: consulta
// las respuestas que el humano escribió en la bandeja (status 'enviando') y las manda al
// cliente por el número del bot (Cloud API), luego las marca 'sent' con el wa_message_id
// (de ahí los estados de entrega siguen por el webhook). Flag-gated: solo arranca si
// COMUNICACIONES_ENABLED=true (lo decide index.js al montarlo).
//
// IMPORTANTE: envía con sock.sendMessage DIRECTO (no sendBotMessage) porque el mensaje YA
// está persistido por el endpoint /responder — sendBotMessage lo re-registraría como 'bot'.

const POLL_MS = parseInt(process.env.COMUNICACIONES_POLL_MS ?? '8000', 10);

export function startComunicacionesPoller({ getSock, logger }) {
  async function tick() {
    const sock = getSock();
    if (!sock) return;
    let pendientes;
    try {
      pendientes = await salientesPendientes();
    } catch (err) {
      logger.warn?.({ err: err.message }, 'comunicaciones-poller: no pude consultar salientes');
      return;
    }
    for (const p of pendientes) {
      if (!p.cliente_jid || !p.text) {
        // dato inválido → marcar enviado sin wa id para no loopear (no se puede mandar).
        await marcarSalienteEnviado(p.id, null).catch(() => {});
        continue;
      }
      try {
        const sent = await sock.sendMessage(p.cliente_jid, { text: p.text });
        await marcarSalienteEnviado(p.id, sent?.key?.id ?? null);
        logger.info?.({ id: p.id, jid: p.cliente_jid }, '📤 respuesta del humano enviada al cliente');
      } catch (err) {
        // no marcamos → se reintenta en el próximo ciclo.
        logger.warn?.({ id: p.id, err: err.message }, 'comunicaciones-poller: fallo al enviar, reintenta luego');
      }
    }
    // Fase 3: barrido de timeouts (reactivación automática al bot tras ~25min). Best-effort.
    try {
      const b = await barrerTimeouts();
      if (b?.devueltas?.length) logger.info?.({ devueltas: b.devueltas }, '⏱️ timeout: conversación(es) devuelta(s) al bot');
    } catch (err) {
      logger.warn?.({ err: err.message }, 'comunicaciones-poller: barrer-timeouts falló');
    }
  }

  let corriendo = false;
  const timer = setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try { await tick(); } finally { corriendo = false; }
  }, POLL_MS);
  logger.info?.({ pollMs: POLL_MS }, '🔁 comunicaciones-poller arrancado (saliente humano)');
  return () => clearInterval(timer);
}
