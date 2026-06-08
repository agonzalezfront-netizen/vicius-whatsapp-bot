import { getNotifPendientes, marcarNotificado } from './pedidos-client.js';
import { sendBotMessage } from './handlers.js';

const POLL_MS = parseInt(process.env.NOTIF_POLL_MS ?? '10000', 10);

// MSG-2 (spec gestor de pedidos): pago validado → pasa a cocina.
function msgValidado() {
  return '¡Pago confirmado! ✅\n\nTu pedido ya entró a cocina 🍽️ Está listo en unos *15-20 minutos*. Te aviso cuando vaya en camino.';
}

// MSG-3: pago rechazado → con la razón que eligió la dueña.
function msgRechazado(razon) {
  const r = (razon || 'hubo un inconveniente con el comprobante').trim();
  return `Hola 🙂 Tuvimos un problema con tu comprobante:\n\n_${r}_\n\n¿Podés revisarlo y reenviarlo? Si tenés alguna duda, Carla y César te ayudan enseguida 🙏`;
}

// Arranca el loop que consulta las notificaciones que la dueña generó en la app
// (validar/rechazar) y manda el mensaje saliente al cliente por WhatsApp.
// getSock() devuelve el socket Baileys vigente (puede cambiar en reconexiones) o
// null si el bot todavía no está conectado.
export function startNotifPoller({ getSock, logger }) {
  async function tick() {
    const sock = getSock();
    if (!sock) return; // sin conexión, reintenta en el próximo ciclo
    let pendientes;
    try {
      pendientes = await getNotifPendientes();
    } catch (err) {
      logger.warn({ err: err.message }, 'notif-poller: no pude consultar pendientes');
      return;
    }
    for (const p of pendientes) {
      if (!p.cliente_jid) {
        // Sin jid no podemos avisar; limpiamos el flag para no loopear.
        await marcarNotificado(p.id).catch(() => {});
        continue;
      }
      const texto = p.tipo === 'validado' ? msgValidado() : msgRechazado(p.razon);
      try {
        await sendBotMessage(sock, p.cliente_jid, { text: texto });
        await marcarNotificado(p.id);
        logger.info({ pedidoId: p.id, jid: p.cliente_jid, tipo: p.tipo }, '📤 notif enviada al cliente');
      } catch (err) {
        // No marcamos notificado → se reintenta en el próximo ciclo.
        logger.warn({ pedidoId: p.id, err: err.message }, 'notif-poller: fallo al enviar, reintenta luego');
      }
    }
  }

  // setInterval no se solapa porque tick es corto; igual envolvemos en guard.
  let corriendo = false;
  const timer = setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      await tick();
    } finally {
      corriendo = false;
    }
  }, POLL_MS);
  logger.info({ pollMs: POLL_MS }, '🔁 notif-poller arrancado (gestor de pedidos)');
  return () => clearInterval(timer);
}
