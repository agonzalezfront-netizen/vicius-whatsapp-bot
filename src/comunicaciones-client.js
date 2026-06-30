// Cliente HTTP del wizard para la Sección Comunicaciones (handoff v1).
// El bot persiste cada mensaje (in/out) + estados de entrega, consulta si está
// pausado, y marca requiere_humano. Mismo patrón/auth que pedidos-client.js
// (UA de navegador obligatorio por el WAF; creds WIZARD_USER/WIZARD_PASS).
//
// TODO es best-effort desde el lado de quien llama: la comunicación con el wizard
// NO debe romper el flujo del bot si el wizard no responde (se loguea y sigue).

import { enviarPushEquipo } from './push.js';
import { fetchConReintento } from './http-retry.js';

const WIZARD_BASE = process.env.WIZARD_BASE ?? 'https://viciusstudio.cl/wizard';
const WIZARD_AUTH =
  'Basic ' +
  Buffer.from(`${process.env.WIZARD_USER ?? ''}:${process.env.WIZARD_PASS ?? ''}`).toString('base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ViciusBot/1.0';

function _headers(json = true) {
  const h = { Authorization: WIZARD_AUTH, 'User-Agent': UA };
  if (json) h['Content-Type'] = 'application/json; charset=utf-8';
  return h;
}

// Registra un mensaje (entrante o saliente). msg:
//   { cliente_jid, cliente_nombre?, wa_message_id?, direction: 'in'|'out',
//     sender: 'cliente'|'bot'|'humano', sender_nombre?, type?, text?, media_ref?, status?, ts? }
export async function registrarMensaje(msg) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/mensajes`, {
    method: 'POST', headers: _headers(), body: JSON.stringify(msg),
  });
  if (!res.ok) throw new Error(`registrarMensaje HTTP ${res.status}`);
  return res.json();
}

// Actualiza el estado de entrega de un saliente (sent/delivered/read/failed).
export async function actualizarEstadoMensaje(waMessageId, status, error = null) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/mensajes/${encodeURIComponent(waMessageId)}/estado`, {
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
// `motivo` (opcional): marcador|deteccion-verbal|fuera-horario|freno:<x> → la bandeja lo muestra.
export async function escalarAHumano(jid, motivo) {
  const body = { accion: 'requiere_humano' };
  if (motivo) body.motivo = motivo;
  const res = await fetchConReintento(`${WIZARD_BASE}/api/conversaciones/${encodeURIComponent(jid)}/estado`, {
    method: 'POST', headers: _headers(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`escalarAHumano HTTP ${res.status}`);
  const out = await res.json();
  // Fase 4 (Web Push): avisar al equipo en el acto, para que suene aunque el teléfono esté bloqueado.
  // Fire-and-forget y best-effort: si el push falla, el escalado YA quedó hecho (no se revierte).
  enviarPushEquipo({ title: '🙋 Un cliente espera', body: 'Tenés una conversación sin atender en El Sazón.' })
    .catch(() => {});
  return out;
}

// Fase 5 (constancia): el poller lista la bandeja para re-pushear las conversaciones que siguen en
// requiere_humano sin tomar. Best-effort desde el caller.
export async function listarConversaciones() {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/conversaciones`, { method: 'GET', headers: _headers(false) });
  if (!res.ok) throw new Error(`listarConversaciones HTTP ${res.status}`);
  const data = await res.json();
  return data.conversaciones ?? [];
}

// Devuelve la conversación al bot (timeout 25min / resolución). Idempotente.
export async function devolverAlBot(jid) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/conversaciones/${encodeURIComponent(jid)}/estado`, {
    method: 'POST', headers: _headers(), body: JSON.stringify({ accion: 'devolver_al_bot' }),
  });
  if (!res.ok) throw new Error(`devolverAlBot HTTP ${res.status}`);
  return res.json();
}

// Fase 2 — saliente del humano: el bot pollea las respuestas del humano pendientes de
// envío (status 'enviando' en la bandeja) y las manda por el número del bot.
export async function salientesPendientes() {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/comunicaciones/salientes`, {
    method: 'GET', headers: _headers(false),
  });
  if (!res.ok) throw new Error(`salientesPendientes HTTP ${res.status}`);
  const data = await res.json();
  return data.pendientes ?? [];
}

// Confirma que el saliente del humano (id de la bandeja) se envió, con el wa_message_id
// de Cloud API → de ahí los estados de entrega siguen por el webhook.
export async function marcarSalienteEnviado(id, waMessageId) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/comunicaciones/salientes/${id}/enviado`, {
    method: 'POST', headers: _headers(), body: JSON.stringify({ wa_message_id: waMessageId ?? null }),
  });
  if (!res.ok) throw new Error(`marcarSalienteEnviado HTTP ${res.status}`);
  return res.json();
}

// "Devolver al bot" manual: el bot pollea las conversaciones que un humano devolvió y debe
// RELANZAR el flujo (saludo+menú proactivo). Devuelve la lista de jids pendientes.
export async function relanzarPendientes() {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/comunicaciones/relanzar-pendientes`, {
    method: 'GET', headers: _headers(false),
  });
  if (!res.ok) throw new Error(`relanzarPendientes HTTP ${res.status}`);
  const data = await res.json();
  return data.pendientes ?? [];
}

// Confirma que ya relanzó el flujo de esa conversación → baja el flag (evita re-disparo).
export async function marcarRelanzado(jid) {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/comunicaciones/relanzar-hecho`, {
    method: 'POST', headers: _headers(), body: JSON.stringify({ jid }),
  });
  if (!res.ok) throw new Error(`marcarRelanzado HTTP ${res.status}`);
  return res.json();
}

// Fase 3 — barrido de timeouts del handoff: conversaciones en requiere_humano/en_atención
// inactivas ~25min → el wizard las devuelve al bot (reactivación automática). El bot lo
// dispara periódicamente (el wizard no tiene scheduler propio).
export async function barrerTimeouts() {
  const res = await fetchConReintento(`${WIZARD_BASE}/api/comunicaciones/barrer-timeouts`, {
    method: 'POST', headers: _headers(), body: '{}',
  });
  if (!res.ok) throw new Error(`barrerTimeouts HTTP ${res.status}`);
  return res.json();
}
