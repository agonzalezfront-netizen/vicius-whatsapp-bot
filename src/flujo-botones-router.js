// Tier básico (MODE=buttons) — ROUTER: pega la máquina de estados pura con persistencia + transporte +
// creación de pedido. SIN LLM. Aislado del flujo premium (handlers solo lo invoca si MODE=buttons).
//
// Cadena por turno: cargar estado (wizard) → procesar(input) → guardar estado → enviar salidas →
// si emite pedido: crearPedido + push al dueño + borrar estado.
import { procesar, estadoInicial, saludoInicial, renderMenuCliente, PASOS } from './flujo-botones.js';
import { getActiveMenu } from './active-menu.js';
import {
  getEstadoFlujo, setEstadoFlujo, borrarEstadoFlujo, crearPedido,
  crearSolicitudEspecial, getSolicitudEspecial,
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
    // Mejora UX-A: mostrar el menú COMPLETO en texto ANTES del 1er paso (el cliente ve el panorama).
    const menuTxt = renderMenuCliente(menu);
    if (menuTxt) await sock.sendMessage(jid, payloadDe(menuTxt));
    const r0 = procesar(estado, { tipo: 'init' }, menu); // input neutro → re-render del paso inicial (PROTEINA)
    await setEstadoFlujo(jid, r0.estado);
    await enviar(sock, jid, r0.salidas);
    return;
  }

  // RECONCILIACIÓN (pieza 2 FASE B, gap 1): si hay una solicitud fuera-de-carta PENDIENTE con id, consultamos
  // su estado en el wizard ANTES de procesar e INYECTAMOS el resultado en el estado → la máquina (pura)
  // renderiza el resumen actualizado (aplicado con costo / sigue pendiente). El efecto de red vive acá.
  if (estado?.solicitud?.id && estado.solicitud.status === 'pendiente') {
    try {
      const s = await getSolicitudEspecial(estado.solicitud.id);
      if (s && s.status === 'aplicado') {
        estado.solicitud = { ...estado.solicitud, status: 'aplicado', costo: s.costo, descripcion: s.descripcion ?? estado.solicitud.descripcion };
      }
    } catch (e) { logger?.warn?.({ jid, err: e.message }, 'reconciliar solicitud: falla (sigo pendiente)'); }
  }

  // La máquina maneja botón Y texto (intenta resolver el texto a una opción del paso; ver matchTexto).
  const input = btnId ? { tipo: 'button', id: btnId } : { tipo: 'text', texto };
  const r = procesar(estado, input, menu);

  // Nivel 2: la máquina pidió CREAR una solicitud fuera-de-carta → el router hace el POST (efecto de red) y
  // guarda el id devuelto en el estado para poder reconciliar después. Si falla, escala a humano (no se pierde).
  if (r.crearSolicitud) {
    try {
      const res = await crearSolicitudEspecial({ cliente_jid: jid, cliente_nombre: senderName ?? '', plato: r.crearSolicitud.plato, descripcion: r.crearSolicitud.descripcion });
      if (res?.id && r.estado?.solicitud) r.estado.solicitud.id = res.id;
    } catch (e) {
      logger?.error?.({ jid, err: e.message }, 'crearSolicitudEspecial FALLA → escalo');
      escalarAHumano(jid, 'pedido-especial-tier-basico').catch(() => {});
    }
  }

  await setEstadoFlujo(jid, r.estado);
  await enviar(sock, jid, r.salidas);
  // Si el cliente escribió algo no reconocido 2 veces seguidas → la máquina pide escalar (duda).
  if (r.escalar) {
    escalarAHumano(jid, 'consulta-tier-basico').catch(() => {});
    await sock.sendMessage(jid, { text: 'Si tenés una consulta, te conecto con el local 🙂. Para seguir tu pedido, tocá una opción o escribí su nombre 👇' });
  }
  if (r.pedido) await finalizar(jid, senderName, r.pedido, logger);
}
