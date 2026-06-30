// Cliente HTTP del wizard Flask (cPanel). El bot crea pedidos y sube comprobantes acá.
//
// IMPORTANTE — User-Agent: el WAF del hosting (Imunify360/LiteSpeed) bloquea con
// HTTP 400 los POST con body complejo cuando el User-Agent es genérico (curl, node).
// Verificado en prod 2026-06-04: mismo body pasa con UA de navegador, falla con curl.
// Por eso forzamos un UA de navegador en todas las requests.

// Credenciales del wizard: SIEMPRE por env var (no hardcodear secretos en el repo).
// Seteadas en Railway: WIZARD_USER, WIZARD_PASS. WIZARD_BASE tiene default público.
const WIZARD_BASE = process.env.WIZARD_BASE ?? 'https://viciusstudio.cl/wizard';
const WIZARD_AUTH =
  'Basic ' +
  Buffer.from(`${process.env.WIZARD_USER ?? ''}:${process.env.WIZARD_PASS ?? ''}`).toString('base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ViciusBot/1.0';

// Reintento ante 5xx en TODAS las llamadas al wizard (resiliencia integral 2026-06-29): el origen
// cPanel flapea bajo carga. La función SOLO reintenta; el manejo fatal/no-fatal lo decide cada caller
// según si el resultado es esencial para el cliente (crearPedido/comprobante → error visible) o no
// (persistir estado/notifs → no-fatal). Helper compartido en http-retry.js.
import { fetchConReintento } from './http-retry.js';

export async function crearPedido(pedido) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/pedidos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: WIZARD_AUTH,
      'User-Agent': UA,
    },
    body: JSON.stringify(pedido),
  });
  if (!res.ok) throw new Error(`crearPedido HTTP ${res.status}`);
  return res.json();
}

// Persistencia del menú activo: el bot guarda el payload publicado en el wizard
// (SQLite persistente) y lo recupera al arrancar, para sobrevivir redeploys de Railway.
export async function guardarMenuActual(payload) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/menu-actual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`guardarMenuActual HTTP ${res.status}`);
  return res.json();
}

// Gestor de pedidos: el bot consulta las notificaciones pendientes (validado/
// rechazado) que la dueña generó en la app, las manda al cliente y las marca.
export async function getNotifPendientes() {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/notif-pendientes`, {
    method: 'GET',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`getNotifPendientes HTTP ${res.status}`);
  const data = await res.json();
  return data.pendientes ?? [];
}

export async function marcarNotificado(pedidoId) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/pedidos/${pedidoId}/notificado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: '{}',
  });
  if (!res.ok) throw new Error(`marcarNotificado HTTP ${res.status}`);
  return res.json();
}

export async function cargarMenuActual() {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/menu-actual`, {
    method: 'GET',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`cargarMenuActual HTTP ${res.status}`);
  const data = await res.json();
  return data.menu ?? null;
}

// Fallback robusto: `pedidosEnCurso` (Map in-memory en handlers.js) se pierde en
// cada redeploy de Railway, así que si el cliente manda el comprobante después de
// un redeploy, el link jid→pedidoId desaparece. Acá lo reconstruimos preguntando
// al wizard (DB persistente) por el pedido MÁS RECIENTE de este jid que sigue
// esperando comprobante. El backend ya ordena por created_at DESC.
export async function buscarPedidoEsperandoComprobante(jid) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/pedidos?status=esperando_comprobante`, {
    method: 'GET',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`buscarPedidoEsperandoComprobante HTTP ${res.status}`);
  const data = await res.json();
  const delJid = (data.pedidos ?? []).filter((p) => p.cliente_jid === jid);
  return delJid.length ? delJid[0].id : null;
}

// Estado del pedido más reciente de un cliente (cualquier estado), para inyectar
// CONTEXTO al system prompt: así el bot, ante un "gracias" post-entrega, no responde
// "quedo atento al comprobante" — sabe que el pedido ya está entregado (bug 2026-06-09:
// el bot respondía con el historial conversacional, sin el estado real del pedido).
// Devuelve { id, status, total } del más reciente, o null si el cliente no tiene pedidos.
export async function estadoUltimoPedido(jid) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/pedidos`, {
    method: 'GET',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`estadoUltimoPedido HTTP ${res.status}`);
  const data = await res.json();
  const delJid = (data.pedidos ?? []).filter((p) => p.cliente_jid === jid);
  if (!delJid.length) return null;
  const p = delJid[0]; // el backend ordena por created_at DESC
  return { id: p.id, status: p.status, total: p.total };
}

// ── Tier básico (MODE=buttons): estado parcial del pedido por jid, persistido en el wizard ──
// (sobrevive redeploys de Railway — el pedido a medio armar no se pierde).
export async function getEstadoFlujo(jid) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/flujo-estado?jid=${encodeURIComponent(jid)}`, {
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`getEstadoFlujo HTTP ${res.status}`);
  return (await res.json()).estado ?? null;
}

export async function setEstadoFlujo(jid, estado) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/flujo-estado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: JSON.stringify({ cliente_jid: jid, estado }),
  });
  if (!res.ok) throw new Error(`setEstadoFlujo HTTP ${res.status}`);
  return res.json();
}

export async function borrarEstadoFlujo(jid) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/flujo-estado/borrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: JSON.stringify({ cliente_jid: jid }),
  });
  if (!res.ok) throw new Error(`borrarEstadoFlujo HTTP ${res.status}`);
  return res.json();
}

// ── Solicitudes "fuera de carta" (pieza 2 FASE B, Nivel 2 async) ──────────────────────────────
// El bot crea una solicitud PENDIENTE (no congela el pedido) y luego consulta su estado para reconciliar.
export async function crearSolicitudEspecial({ cliente_jid, cliente_nombre, plato, descripcion }) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/solicitud-especial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: JSON.stringify({ cliente_jid, cliente_nombre, plato, descripcion }),
  });
  if (!res.ok) throw new Error(`crearSolicitudEspecial HTTP ${res.status}`);
  return res.json(); // { ok, id }
}

export async function getSolicitudEspecial(id) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/solicitud-especial?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`getSolicitudEspecial HTTP ${res.status}`);
  return (await res.json()).solicitud ?? null; // { id, status, costo, descripcion, ... }
}

export async function subirComprobante(pedidoId, buffer, mime) {
  const form = new FormData();
  const ext = mime?.includes('png') ? 'png' : 'jpg';
  form.append('imagen', new Blob([buffer], { type: mime ?? 'image/jpeg' }), `comprobante.${ext}`);
  const res = await fetchConReintento(`${WIZARD_BASE}/api/pedidos/${pedidoId}/comprobante`, {
    method: 'POST',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: form,
  });
  if (!res.ok) throw new Error(`subirComprobante HTTP ${res.status}`);
  return res.json();
}
