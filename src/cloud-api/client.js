// Cliente de la WhatsApp Cloud API (Graph API de Meta) — vía DIRECTA, sin BSP.
// Reemplaza la capa de transporte de Baileys: en vez de un socket WebSocket,
// hablamos HTTP con graph.facebook.com. Un cliente por tenant (phone_number_id +
// token) — multi-tenant ready.
//
// Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/reference
// Node 20+ trae fetch global; no dependemos de librerías HTTP externas.

const GRAPH_VERSION = process.env.GRAPH_API_VERSION ?? 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

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

  return { phoneNumberId, sendText, sendButtons, markRead, downloadMedia, _post: post };
}
