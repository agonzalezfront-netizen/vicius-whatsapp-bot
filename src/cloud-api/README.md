# Transporte WhatsApp Cloud API (Meta directa) — Fase A

Migración del bot de **Baileys** (no oficial, arriesga ban) a la **Cloud API oficial
de Meta**, vía DIRECTA sin BSP. La lógica del Sazón (`claude.js`, `handlers.js`,
`active-menu.js`, `precios.js`, `pedidos-client.js`, `notif-poller.js`) NO cambia:
solo se reemplaza la capa de transporte.

## Módulos (este directorio)
- `client.js` — cliente de la Graph API por tenant: `sendText`, `sendButtons`,
  `markRead`, `downloadMedia`.
- `tenants.js` — registro multi-tenant; ruteo por `phone_number_id`. Hoy 1 tenant
  desde env (`WA_PHONE_NUMBER_ID`/`WA_TOKEN`); a futuro `WA_TENANTS` (JSON).
- `adapter.js` — `normalizeIncoming` (webhook de Meta → `msg` estilo Baileys, así
  `handlers.js` no cambia) + `makeCloudSock` (objeto sock-like sobre la Graph API:
  `sendMessage`/`readMessages`/`sendPresenceUpdate`/`downloadImage`).
  Sintetiza `cliente_jid` como `<numero>@s.whatsapp.net` para no romper el link de
  comprobantes del wizard.
- `webhook.js` — `handleVerify` (handshake GET), `verifySignature` (HMAC del App
  Secret), `handleIncoming` (POST: valida firma → rutea al tenant → `handleMessage`).

## Estado (2026-06-18)
- ✅ Scaffold completo + test sin red: `qa-harness/test-cloud-api.mjs` (11 checks).
- ⏳ **Pendiente, requiere credenciales de Meta** (lo coordina Cortex con Alberto):
  1. **Cablear** el webhook en el server HTTP del bot (`qr-server.js`/`index.js`) bajo
     `TRANSPORT=cloud` (sin romper el path Baileys default).
  2. Mínimo cambio en `handlers.js`: bajar el comprobante con `sock.downloadImage(msg)`
     en vez del import directo de Baileys (así el flujo es transport-agnostic). Para
     Baileys, `index.js` le agrega `sock.downloadImage = m => downloadMediaMessage(m,'buffer',{})`.
  3. Adaptar `notif-poller.js` para mandar MSG-2/MSG-3 vía el sock Cloud API.
  4. Templates (mensajes business-initiated fuera de ventana 24h) — crear en Fase B.
  5. Validación E2E contra el número de prueba (5 destinatarios).

## Setup de Meta (lo saca Cortex/Alberto o yo por Chrome MCP)
1. App en developers.facebook.com (caso de uso WhatsApp) → WABA + número de prueba.
2. **Meta Business portfolio + System User** → token permanente (el temp dura 24h).
3. Suscribir el webhook (URL del server Railway + `WA_VERIFY_TOKEN`) al campo `messages`.
4. Cargar hasta 5 destinatarios de prueba.
5. Env: `WA_PHONE_NUMBER_ID`, `WA_TOKEN`, `WA_VERIFY_TOKEN`, `WA_APP_SECRET`.

Doc Meta: https://developers.facebook.com/docs/whatsapp/cloud-api
