// Tier básico (MODE=buttons) — ROUTER: pega la máquina de estados pura con persistencia + transporte +
// creación de pedido. SIN LLM. Aislado del flujo premium (handlers solo lo invoca si MODE=buttons).
//
// Cadena por turno: cargar estado (wizard) → procesar(input) → guardar estado → enviar salidas →
// si emite pedido: crearPedido + push al dueño + borrar estado.
import { procesar, estadoInicial, saludoInicial, PASOS } from './flujo-botones.js';
import { getActiveMenu } from './active-menu.js';
import {
  getEstadoFlujo, setEstadoFlujo, borrarEstadoFlujo, crearPedido,
} from './pedidos-client.js';
import { enviarPushEquipo } from './push.js';
import { escalarAHumano } from './comunicaciones-client.js';

// Traduce una "salida" abstracta de la máquina al payload de sock.sendMessage.
function payloadDe(salida) {
  if (salida.tipo === 'list') return { text: salida.text, sections: salida.sections, button: salida.button };
  if (salida.tipo === 'buttons') return { text: salida.text, buttons: salida.buttons };
  return { text: salida.text };
}
async function enviar(sock, jid, salidas) {
  for (const s of salidas) await sock.sendMessage(jid, payloadDe(s));
}

// Dispara el pedido creado al panel + push al dueño + limpia el estado.
async function finalizar(jid, senderName, pedido, logger) {
  try {
    const res = await crearPedido({ cliente_jid: jid, cliente_nombre: senderName ?? '', ...pedido });
    logger?.info?.({ jid, pedidoId: res?.id, total: pedido.total }, '🧾 pedido (tier básico) creado');
    const modalidad = pedido.tipo === 'delivery' ? 'DELIVERY' : 'RETIRO LOCAL';
    const ref = String(res?.id ?? '').slice(-4).toUpperCase();
    const items = (pedido.items ?? []).map((i) => i.proteina).join(', ') || `${(pedido.items ?? []).length} ítem(s)`;
    enviarPushEquipo(
      { title: `🧾 Nuevo pedido — ${modalidad}`, body: `#${ref} · ${items} · Total $${Number(pedido.total).toLocaleString('es-CL')}`, url: 'pedidos', tag: `pedido-nuevo-${res?.id}` },
      logger,
    ).catch(() => {});
  } catch (e) {
    logger?.error?.({ jid, err: e.message }, 'tier básico: crearPedido FALLA');
  }
  await borrarEstadoFlujo(jid).catch(() => {});
}

// Punto de entrada del tier básico. `btnId` = id crudo del botón/lista (o null); `texto` = texto libre.
export async function manejarTurnoBotones({ sock, jid, senderName, btnId, texto, logger }) {
  const menu = getActiveMenu();
  let estado = await getEstadoFlujo(jid).catch(() => null);

  // Primer contacto / sin estado → saludo + arranque del árbol (render del primer paso).
  if (!estado) {
    estado = estadoInicial();
    await sock.sendMessage(jid, payloadDe(saludoInicial()));
    const r0 = procesar(estado, { tipo: 'init' }, menu); // input neutro → re-render del paso inicial (PROTEINA)
    await setEstadoFlujo(jid, r0.estado);
    await enviar(sock, jid, r0.salidas);
    return;
  }

  // Texto libre en un paso que NO lo espera (solo DIRECCION lo espera) = DUDA → escalar a humano,
  // y re-mostrar el paso actual (no rompe el flujo). En el básico la IA no entra; la atiende el local.
  const esTexto = !btnId && !!(texto && texto.trim());
  if (esTexto && estado.paso !== PASOS.DIRECCION) {
    escalarAHumano(jid, 'consulta-tier-basico').catch(() => {});
    await sock.sendMessage(jid, { text: 'Para esa consulta te conecto con el local 🙂. Mientras, podés seguir tu pedido tocando los botones 👇' });
    const rr = procesar(estado, { tipo: 'noop' }, menu); // re-render del paso actual
    await enviar(sock, jid, rr.salidas);
    return;
  }

  const input = btnId ? { tipo: 'button', id: btnId } : { tipo: 'text', texto };
  const r = procesar(estado, input, menu);
  await setEstadoFlujo(jid, r.estado);
  await enviar(sock, jid, r.salidas);
  if (r.pedido) await finalizar(jid, senderName, r.pedido, logger);
}
