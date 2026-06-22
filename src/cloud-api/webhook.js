// Webhook de la Cloud API. Meta hace:
//   - GET  /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
//       → handshake de verificación: devolvemos el challenge si el token coincide.
//   - POST /webhook  (body JSON con los mensajes entrantes)
//       → validamos la firma (X-Hub-Signature-256, HMAC con el App Secret),
//         ruteamos por phone_number_id al tenant, y procesamos cada mensaje con
//         la MISMA lógica del bot (handleMessage), vía el sock-adapter Cloud API.
//
// Seguridad: si WA_APP_SECRET está seteado, se exige firma válida (recomendado en
// prod). Sin él (dev temprano), se acepta sin firma pero se loguea un warning.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getTenant } from './tenants.js';
import { makeCloudClient } from './client.js';
import { makeCloudSock, normalizeIncoming } from './adapter.js';

const VERIFY_TOKEN = () => process.env.WA_VERIFY_TOKEN ?? '';
const APP_SECRET = () => process.env.WA_APP_SECRET ?? '';

// Verificación del handshake GET. `query` = objeto con los params hub.*.
export function handleVerify(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && token === VERIFY_TOKEN()) {
    return { ok: true, status: 200, body: String(challenge ?? '') };
  }
  return { ok: false, status: 403, body: 'Forbidden' };
}

// Valida la firma HMAC-SHA256 del body crudo contra X-Hub-Signature-256.
export function verifySignature(rawBody, signatureHeader) {
  const secret = APP_SECRET();
  if (!secret) return { ok: true, skipped: true }; // dev sin secret: no exigir
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return { ok: false };
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return { ok: a.length === b.length && timingSafeEqual(a, b) };
  } catch {
    return { ok: false };
  }
}

// Procesa un POST entrante. `rawBody` = string crudo (para la firma). ctx = {logger, menu}.
// Devuelve { status } — Meta solo necesita un 200 rápido. El procesamiento de cada
// mensaje se hace best-effort (un error en uno no tira el resto ni el 200).
export async function handleIncoming(rawBody, signatureHeader, ctx) {
  const { logger = console, menu, handleMessage, onStatus } = ctx;

  const sig = verifySignature(rawBody, signatureHeader);
  if (!sig.ok) {
    logger.warn?.('webhook: firma inválida — rechazado');
    return { status: 401 };
  }
  if (sig.skipped) logger.warn?.('webhook: WA_APP_SECRET no seteado — firma NO verificada (ok en dev)');

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400 };
  }
  if (payload.object !== 'whatsapp_business_account') return { status: 200 }; // ignorar otros objetos

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      const tenant = getTenant(phoneNumberId);
      if (!tenant) {
        logger.warn?.({ phoneNumberId }, 'webhook: sin tenant para este phone_number_id — ignorado');
        continue;
      }
      const client = makeCloudClient(tenant, logger);
      const sock = makeCloudSock(client, logger);
      const msgs = normalizeIncoming(value);
      for (const msg of msgs) {
        try {
          await handleMessage({ sock, logger, menu, msg });
        } catch (err) {
          logger.error?.({ err: err.message, stack: err.stack }, 'webhook: handleMessage falló');
        }
      }
      // Estados de entrega (sent/delivered/read/failed) — handoff v1: el panel muestra el
      // estado de cada mensaje saliente. Best-effort, no bloquea el 200.
      if (onStatus && Array.isArray(value?.statuses)) {
        for (const st of value.statuses) {
          try {
            await onStatus({ id: st.id, status: st.status, error: st.errors?.[0]?.title ?? null });
          } catch (err) {
            logger.warn?.({ err: err.message }, 'webhook: onStatus falló');
          }
        }
      }
    }
  }
  return { status: 200 };
}
