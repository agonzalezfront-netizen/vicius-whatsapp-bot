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

export async function crearPedido(pedido) {
  const res = await fetch(`${WIZARD_BASE}/api/pedidos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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
  const res = await fetch(`${WIZARD_BASE}/api/menu-actual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`guardarMenuActual HTTP ${res.status}`);
  return res.json();
}

export async function cargarMenuActual() {
  const res = await fetch(`${WIZARD_BASE}/api/menu-actual`, {
    method: 'GET',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`cargarMenuActual HTTP ${res.status}`);
  const data = await res.json();
  return data.menu ?? null;
}

export async function subirComprobante(pedidoId, buffer, mime) {
  const form = new FormData();
  const ext = mime?.includes('png') ? 'png' : 'jpg';
  form.append('imagen', new Blob([buffer], { type: mime ?? 'image/jpeg' }), `comprobante.${ext}`);
  const res = await fetch(`${WIZARD_BASE}/api/pedidos/${pedidoId}/comprobante`, {
    method: 'POST',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
    body: form,
  });
  if (!res.ok) throw new Error(`subirComprobante HTTP ${res.status}`);
  return res.json();
}
