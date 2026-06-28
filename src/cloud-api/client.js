// Cliente de la WhatsApp Cloud API (Graph API de Meta) — vía DIRECTA, sin BSP.
// Reemplaza la capa de transporte de Baileys: en vez de un socket WebSocket,
// hablamos HTTP con graph.facebook.com. Un cliente por tenant (phone_number_id +
// token) — multi-tenant ready.
//
// Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/reference
// Node 20+ trae fetch global; no dependemos de librerías HTTP externas.

const GRAPH_VERSION = process.env.GRAPH_API_VERSION ?? 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Suscribe NUESTRA app a una WABA para recibir sus webhooks (entrantes). Sin esto,
// los mensajes al número de esa WABA NO llegan a nuestro /webhook. Idempotente:
// llamarla de más no rompe nada. POST /{waba-id}/subscribed_apps con el token.
// Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
//
// OVERRIDE de webhook por WABA (staging sin romper prod): el webhook de la UI de Meta es
// ÚNICO por APP y apunta a PROD. Cambiarlo desviaría TODOS los entrantes (incluido el número
// real) a staging → rompería el piloto en vivo. La vía limpia es el override por WABA:
// `POST /{waba-id}/subscribed_apps` con body { override_callback_uri, verify_token } setea un
// webhook propio SOLO para esa WABA, sin tocar el de la app (prod). Como las WABAs de prod y de
// test son distintas, el override de la WABA de test → bot staging, y prod queda intacto.
// Doc: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/
// Meta verifica la override URL con un GET de challenge (handleVerify lo responde con WA_VERIFY_TOKEN).
export async function subscribeAppToWaba(wabaId, token, logger = console, opts = {}) {
  if (!wabaId || !token) return { ok: false, error: 'falta wabaId o token' };
  const { overrideCallbackUri, verifyToken } = opts;
  const usaOverride = Boolean(overrideCallbackUri && verifyToken);
  try {
    // Paso 1 (siempre): asegurar la suscripción app↔WABA. Es lo que necesita prod (sin override)
    // y, para staging, garantiza que la suscripción exista antes de aplicar el override.
    const res1 = await fetch(`${GRAPH_BASE}/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const j1 = await res1.json().catch(() => ({}));
    if (!(res1.ok && j1?.success !== false)) {
      logger.warn?.({ wabaId, status: res1.status, err: j1?.error }, 'no se pudo suscribir la app a la WABA');
      return { ok: false, status: res1.status, error: j1?.error?.message };
    }
    if (!usaOverride) {
      logger.info?.({ wabaId }, '🔔 app suscrita a la WABA (webhooks entrantes habilitados)');
      return { ok: true };
    }
    // Paso 2 (solo staging): setear el override de callback SOLO para esta WABA.
    const res2 = await fetch(`${GRAPH_BASE}/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ override_callback_uri: overrideCallbackUri, verify_token: verifyToken }),
    });
    const j2 = await res2.json().catch(() => ({}));
    if (res2.ok && j2?.success !== false) {
      logger.info?.({ wabaId, override: overrideCallbackUri }, '🔔 override de webhook por WABA aplicado (staging) — prod intacto');
      return { ok: true, override: overrideCallbackUri };
    }
    logger.warn?.({ wabaId, status: res2.status, err: j2?.error }, 'suscripción OK pero NO se pudo aplicar el override de webhook (¿el token tiene whatsapp_business_management?)');
    return { ok: false, status: res2.status, error: j2?.error?.message, subscribedSinOverride: true };
  } catch (err) {
    logger.warn?.({ wabaId, err: err.message }, 'error suscribiendo la app a la WABA');
    return { ok: false, error: err.message };
  }
}

// Construye un cliente atado a un tenant (un número de WhatsApp Business).
//   tenant: { phoneNumberId, token }
export function makeCloudClient(tenant, logger = console) {
  const { phoneNumberId, token } = tenant;
  if (!phoneNumberId || !token) {
    throw new Error('makeCloudClient: faltan phoneNumberId o token del tenant');
  }
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function post(path, body) {
    const res = await fetch(`${GRAPH_BASE}/${path}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = json?.error;
      logger.error?.({ status: res.status, err }, 'Cloud API POST falló');
      throw new Error(`Cloud API ${res.status}: ${err?.message ?? 'sin detalle'} (code ${err?.code})`);
    }
    return json;
  }

  // Envía texto plano. `to` = número en formato internacional sin '+' (ej. 56961234567).
  async function sendText(to, text, { previewUrl = false } = {}) {
    return post(`${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: previewUrl },
    });
  }

  // Mensaje interactivo de botones (hasta 3). buttons = [{id, title}].
  async function sendButtons(to, bodyText, buttons, { header, footer } = {}) {
    const action = {
      buttons: buttons.slice(0, 3).map((b) => ({
        type: 'reply',
        reply: { id: String(b.id), title: String(b.title).slice(0, 20) },
      })),
    };
    const interactive = { type: 'button', body: { text: bodyText }, action };
    if (header) interactive.header = { type: 'text', text: String(header).slice(0, 60) };
    if (footer) interactive.footer = { text: String(footer).slice(0, 60) };
    return post(`${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive,
    });
  }

  // Mensaje interactivo de LISTA (tier básico). sections = [{title, rows:[{id,title,description?}]}].
  // Límites WhatsApp: máx 10 filas en total, title ≤24, description ≤72, botón ≤20.
  async function sendList(to, bodyText, sections, { button = 'Elegir', header, footer } = {}) {
    let restantes = 10;
    const secs = (sections ?? []).map((s) => {
      const rows = (s.rows ?? []).slice(0, Math.max(0, restantes)).map((r) => {
        const row = { id: String(r.id), title: String(r.title).slice(0, 24) };
        if (r.description) row.description = String(r.description).slice(0, 72);
        return row;
      });
      restantes -= rows.length;
      return { title: String(s.title ?? '').slice(0, 24), rows };
    }).filter((s) => s.rows.length);
    const interactive = { type: 'list', body: { text: bodyText }, action: { button: String(button).slice(0, 20), sections: secs } };
    if (header) interactive.header = { type: 'text', text: String(header).slice(0, 60) };
    if (footer) interactive.footer = { text: String(footer).slice(0, 60) };
    return post(`${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive,
    });
  }

  // Marca un mensaje entrante como leído (doble check azul).
  async function markRead(messageId) {
    return post(`${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  // Descarga media (ej. la foto del comprobante). Dos pasos: (1) resolver el media_id
  // a una URL temporal, (2) bajar el binario con el token. Devuelve { buffer, mime }.
  async function downloadMedia(mediaId) {
    const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta?.url) {
      throw new Error(`downloadMedia: no se pudo resolver media ${mediaId}: ${meta?.error?.message ?? metaRes.status}`);
    }
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!binRes.ok) throw new Error(`downloadMedia: bajada del binario falló (${binRes.status})`);
    const buffer = Buffer.from(await binRes.arrayBuffer());
    return { buffer, mime: meta.mime_type ?? 'application/octet-stream', sha256: meta.sha256 };
  }

  return { phoneNumberId, sendText, sendButtons, sendList, markRead, downloadMedia, _post: post };
}
