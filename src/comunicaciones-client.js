// Cliente HTTP del wizard para la Sección Comunicaciones (handoff v1).
// El bot persiste cada mensaje (in/out) + estados de entrega, consulta si está
// pausado, y marca requiere_humano. Mismo patrón/auth que pedidos-client.js
// (UA de navegador obligatorio por el WAF; creds WIZARD_USER/WIZARD_PASS).
//
// TODO es best-effort desde el lado de quien llama: la comunicación con el wizard
// NO debe romper el flujo del bot si el wizard no responde (se loguea y sigue).

const WIZARD_BASE = process.env.WIZARD_BASE ?? 'https://viciusstudio.cl/wizard';
const WIZARD_AUTH =
  'Basic ' +
  Buffer.from(`${process.env.WIZARD_USER ?? ''}:${process.env.WIZARD_PASS ?? ''}`).toString('base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ViciusBot/1.0';

function _headers(json = true) {
  const h = { Authorization: WIZARD_AUTH, 'User-Agent': UA };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// Registra un mensaje (entrante o saliente). msg:
//   { cliente_jid, cliente_nombre?, wa_message_id?, direction: 'in'|'out',
//     sender: 'cliente'|'bot'|'humano', sender_nombre?, type?, text?, media_ref?, status?, ts? }
export async function registrarMensaje(msg) {
  const res = await fetch(`${WIZARD_BASE}/api/mensajes`, {
    method: 'POST', headers: _headers(), body: JSON.stringify(msg),
  });
  if (!res.ok) throw new Error(`registrarMensaje HTTP ${res.status}`);
  return res.json();
}

// Actualiza el estado de entrega de un saliente (sent/delivered/read/failed).
export async function actualizarEstadoMensaje(waMessageId, status, error = null) {
  const res = await fetch(`${WIZARD_BASE}/api/mensajes/${encodeURIComponent(waMessageId)}/estado`, {
    method: 'PATCH', headers: _headers(), body: JSON.stringify({ status, error }),
  });
  if (!res.ok) throw new Error(`actualizarEstadoMensaje HTTP ${res.status}`);
  return res.json();
}

// ¿El bot está pausado para este cliente? (humano lo está atendiendo).
// Best-effort: ante error, devuelve false (el bot sigue respondiendo — fail-open,
// mejor que dejar al cliente sin respuesta por un wizard caído).
export async function botPausado(jid) {
  try {
    const res = await fetch(`${WIZARD_BASE}/api/conversaciones/${encodeURIComponent(jid)}/bot-activo`, {
      headers: _headers(false),
      signal: AbortSignal.timeout(5000), // gate awaited: no debe colgar el flujo del bot
    });
    if (!res.ok) return false;
    const j = await res.json();
    return j.bot_pausado === true;
  } catch {
    return false; // fail-open: wizard lento/caído → el bot sigue respondiendo
  }
}

// Marca la conversación como requiere_humano (escalado). Idempotente en el wizard.
export async function escalarAHumano(jid) {
  const res = await fetch(`${WIZARD_BASE}/api/conversaciones/${encodeURIComponent(jid)}/estado`, {
    method: 'POST', headers: _headers(), body: JSON.stringify({ accion: 'requiere_humano' }),
  });
  if (!res.ok) throw new Error(`escalarAHumano HTTP ${res.status}`);
  return res.json();
}

// Devuelve la conversación al bot (timeout 25min / resolución). Idempotente.
export async function devolverAlBot(jid) {
  const res = await fetch(`${WIZARD_BASE}/api/conversaciones/${encodeURIComponent(jid)}/estado`, {
    method: 'POST', headers: _headers(), body: JSON.stringify({ accion: 'devolver_al_bot' }),
  });
  if (!res.ok) throw new Error(`devolverAlBot HTTP ${res.status}`);
  return res.json();
}
