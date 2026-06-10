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

// Etapa en_camino (delivery): el pedido salió del local.
function msgEnCamino() {
  return '¡Tu pedido va en camino! 🛵 Llega en un ratito. ¡Que lo disfrutes!';
}

// Etapa listo (retiro): el pedido está pronto para retirar en el local.
function msgListo() {
  return '¡Tu pedido está listo! 🏠 Te esperamos para retirarlo cuando quieras.';
}

// Cierre (delivery): el pedido fue entregado. Mensaje cordial de despedida.
function msgEntregado() {
  return '¡Tu pedido fue entregado! 🙂 Que lo disfrutes. ¡Gracias por elegir a El Sazón de Carla y César! 🧡';
}

// Cierre (retiro): el pedido fue retirado en el local. Mensaje cordial de despedida.
function msgRetirado() {
  return '¡Gracias por pasar a retirar tu pedido! 🙂 Que lo disfrutes. ¡Te esperamos pronto en El Sazón de Carla y César! 🧡';
}

// Mapeo tipo de notificación (notif_pendiente del backend) → texto al cliente.
function textoPara(p) {
  switch (p.tipo) {
    case 'validado': return msgValidado();
    case 'rechazado': return msgRechazado(p.razon);
    case 'en_camino': return msgEnCamino();
    case 'listo': return msgListo();
    case 'entregado': return msgEntregado();
    case 'retirado': return msgRetirado();
    default: return null; // tipo desconocido → no mandamos (se limpia el flag)
  }
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
      // jid ausente o con formato inválido (ej. pedidos de prueba con "56988@...",
      // 5 dígitos) → enviar falla y se reintentaría en loop cada ciclo (spam de logs
      // 2026-06-08). Lo descartamos marcándolo notificado: no se puede avisar a un
      // número que no existe. Aceptamos AMBOS formatos de WhatsApp:
      //   - <8+ dígitos>@s.whatsapp.net (número clásico)
      //   - <8+ dígitos>@lid           (LinkedID, formato nuevo — clientes reales lo usan;
      //                                 el regex viejo solo aceptaba @s.whatsapp.net y por
      //                                 eso descartaba las notifs de esos clientes — bug 2026-06-08)
      if (!p.cliente_jid || !/^\d{8,}@(s\.whatsapp\.net|lid)$/.test(p.cliente_jid)) {
        logger.warn({ pedidoId: p.id, jid: p.cliente_jid }, 'notif-poller: jid ausente o inválido, descarto (no loopea)');
        await marcarNotificado(p.id).catch(() => {});
        continue;
      }
      const texto = textoPara(p);
      if (!texto) {
        // Tipo de notif desconocido: limpiamos el flag para no loopear y seguimos.
        logger.warn({ pedidoId: p.id, tipo: p.tipo }, 'notif-poller: tipo desconocido, se descarta');
        await marcarNotificado(p.id).catch(() => {});
        continue;
      }
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
