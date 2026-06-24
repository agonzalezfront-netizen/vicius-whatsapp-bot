import { salientesPendientes, marcarSalienteEnviado, barrerTimeouts, relanzarPendientes, marcarRelanzado, listarConversaciones } from './comunicaciones-client.js';
import { sendBotMessage } from './handlers.js';
import { mensajeRelanzarFlujo } from './claude.js';
import { enviarPushEquipo } from './push.js';
import { estaAbierto } from './horario.js';

// Fase 5 (constancia): re-push cada N min mientras una conversación siga en requiere_humano SIN tomar.
const REPUSH_MIN = parseInt(process.env.PUSH_REPUSH_MIN ?? '3', 10);
const _lastRepush = new Map(); // cliente_jid → ts del último re-push de constancia (cooldown por jid)

// Selección pura (testeable): de las conversaciones que esperan, las "debidas" son las que esperaron
// al menos `repushMin` (no re-alertar una recién escalada — esa ya avisó en Fase 4) Y pasaron el
// cooldown desde su último re-push. `lastRepush` = Map jid→ts.
export function seleccionarDue(esperando, lastRepush, now, { repushMin, cooldownMs }) {
  return esperando.filter(
    (c) => (c.esperando_min ?? 0) >= repushMin && now - (lastRepush.get(c.cliente_jid) || 0) >= cooldownMs,
  );
}

// Re-pushea si hay conversaciones que esperaron >= REPUSH_MIN y pasaron su cooldown. Respeta el
// horario del local (no molestar de madrugada). Aditivo: su fallo NO afecta el resto del poller.
async function rePushConstancia(menu, logger) {
  const convs = await listarConversaciones();
  const esperando = convs.filter((c) => c.estado === 'requiere_humano'); // en_atencion_humana = ya tomada → fuera
  // Limpiar del cooldown los jids que ya no esperan (atendidos/resueltos).
  for (const jid of [..._lastRepush.keys()]) {
    if (!esperando.find((c) => c.cliente_jid === jid)) _lastRepush.delete(jid);
  }
  if (!esperando.length) return;
  // Fuera de horario no notificamos (BYPASS_HORARIO=true en staging → estaAbierto devuelve true igual).
  if (menu && !estaAbierto(menu)) return;
  const now = Date.now();
  const due = seleccionarDue(esperando, _lastRepush, now, { repushMin: REPUSH_MIN, cooldownMs: REPUSH_MIN * 60 * 1000 });
  if (!due.length) return;
  const n = esperando.length;
  const body = n === 1 ? 'Hay un cliente esperando atención hace rato.' : `Hay ${n} clientes esperando atención.`;
  const r = await enviarPushEquipo({ title: '🙋 Cliente sin atender', body }, logger);
  if (r?.sent) for (const c of due) _lastRepush.set(c.cliente_jid, now);
}

// Handoff v1 Fase 2 — poller del saliente del HUMANO. Espejo del notif-poller: consulta
// las respuestas que el humano escribió en la bandeja (status 'enviando') y las manda al
// cliente por el número del bot (Cloud API), luego las marca 'sent' con el wa_message_id
// (de ahí los estados de entrega siguen por el webhook). Flag-gated: solo arranca si
// COMUNICACIONES_ENABLED=true (lo decide index.js al montarlo).
//
// IMPORTANTE: envía con sock.sendMessage DIRECTO (no sendBotMessage) porque el mensaje YA
// está persistido por el endpoint /responder — sendBotMessage lo re-registraría como 'bot'.

const POLL_MS = parseInt(process.env.COMUNICACIONES_POLL_MS ?? '8000', 10);

export function startComunicacionesPoller({ getSock, logger, menu }) {
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
    // "Devolver al bot" MANUAL → relanzar el flujo activamente (Regla de Oro): saludo + menú del
    // día proactivo, para que el cliente concrete el pedido por el bot. El flag lo bajó la acción;
    // lo limpiamos al enviar para no re-disparar. El timeout automático NO entra acá (no marca flag).
    try {
      const jids = await relanzarPendientes();
      for (const jid of jids) {
        try {
          await sendBotMessage(sock, jid, { text: mensajeRelanzarFlujo(menu) });
          await marcarRelanzado(jid);
          logger.info?.({ jid }, '🔄 devuelto al bot (manual) → flujo relanzado con el menú');
        } catch (err) {
          logger.warn?.({ jid, err: err.message }, 'comunicaciones-poller: relanzar falló, reintenta luego');
        }
      }
    } catch (err) {
      logger.warn?.({ err: err.message }, 'comunicaciones-poller: relanzar-pendientes falló');
    }
    // Fase 3: barrido de timeouts (reactivación automática al bot tras ~25min). Best-effort.
    try {
      const b = await barrerTimeouts();
      if (b?.devueltas?.length) logger.info?.({ devueltas: b.devueltas }, '⏱️ timeout: conversación(es) devuelta(s) al bot');
    } catch (err) {
      logger.warn?.({ err: err.message }, 'comunicaciones-poller: barrer-timeouts falló');
    }
    // Fase 5 (Web Push, constancia): re-push mientras haya conversaciones sin atender. BLOQUE AISLADO
    // y ADITIVO: su fallo NO afecta salientes / relanzar / barrer-timeouts (el path de pedidos queda intacto).
    try {
      await rePushConstancia(menu, logger);
    } catch (err) {
      logger.warn?.({ err: err.message }, 'comunicaciones-poller: re-push constancia falló (no crítico)');
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
