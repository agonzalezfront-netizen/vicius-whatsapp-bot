// Test del scaffold Cloud API SIN red ni credenciales: normalización del webhook,
// handshake de verificación, firma HMAC y el sock-adapter (con un client mock).
// Uso: node qa-harness/test-cloud-api.mjs

import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { normalizeIncoming, makeCloudSock, phoneToJid, jidToPhone } from '../src/cloud-api/adapter.js';
import { handleVerify, verifySignature, handleIncoming } from '../src/cloud-api/webhook.js';
import { loadTenantsFromEnv, getTenant, tenantCount } from '../src/cloud-api/tenants.js';

let pass = 0;
const ok = (name) => { console.log('✅', name); pass++; };

// ── jid <-> phone (compat con el wizard) ──
assert.equal(phoneToJid('56961234567'), '56961234567@s.whatsapp.net');
assert.equal(jidToPhone('56961234567@s.whatsapp.net'), '56961234567');
assert.equal(jidToPhone(phoneToJid('+56 9 6123 4567')), '56961234567');
ok('jid <-> phone roundtrip (compat wizard cliente_jid)');

// ── normalizeIncoming: texto ──
const vText = {
  metadata: { phone_number_id: '111' },
  contacts: [{ wa_id: '56961234567', profile: { name: 'Juan' } }],
  messages: [{ from: '56961234567', id: 'wamid.AAA', type: 'text', text: { body: 'hola, quiero pedir' } }],
};
const [mText] = normalizeIncoming(vText);
assert.equal(mText.key.remoteJid, '56961234567@s.whatsapp.net');
assert.equal(mText.key.fromMe, false);
assert.equal(mText.key.id, 'wamid.AAA');
assert.equal(mText.pushName, 'Juan');
assert.equal(mText.message.conversation, 'hola, quiero pedir');
assert.equal(mText._cloud, true);
ok('normalizeIncoming: texto → shape estilo Baileys');

// ── normalizeIncoming: imagen (comprobante) ──
const vImg = {
  metadata: { phone_number_id: '111' },
  contacts: [],
  messages: [{ from: '56961234567', id: 'wamid.IMG', type: 'image', image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'pago' } }],
};
const [mImg] = normalizeIncoming(vImg);
assert.equal(mImg.message.imageMessage._cloudMediaId, 'MEDIA123');
assert.equal(mImg.message.imageMessage.mimetype, 'image/jpeg');
assert.equal(mImg.message.imageMessage.caption, 'pago');
ok('normalizeIncoming: imagen → imageMessage con _cloudMediaId');

// ── normalizeIncoming: interactivo (botón) → texto ──
const vBtn = {
  metadata: { phone_number_id: '111' },
  messages: [{ from: '569', id: 'wamid.B', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'opt_2', title: 'Cerrar el pedido' } } }],
};
assert.equal(normalizeIncoming(vBtn)[0].message.conversation, 'Cerrar el pedido');
ok('normalizeIncoming: botón interactivo → conversation con el título');

// ── normalizeIncoming: 'statuses' (acks) → nada ──
assert.deepEqual(normalizeIncoming({ statuses: [{ id: 'x', status: 'delivered' }] }), []);
ok('normalizeIncoming: statuses (acks) ignorados');

// ── handleVerify ──
process.env.WA_VERIFY_TOKEN = 'tok-secreto';
assert.deepEqual(
  handleVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok-secreto', 'hub.challenge': '12345' }),
  { ok: true, status: 200, body: '12345' }
);
assert.equal(handleVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'mal', 'hub.challenge': '12345' }).status, 403);
ok('handleVerify: challenge OK con token correcto, 403 con token malo');

// ── verifySignature (HMAC) ──
process.env.WA_APP_SECRET = 'app-secret';
const body = JSON.stringify({ a: 1 });
const goodSig = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
assert.equal(verifySignature(body, goodSig).ok, true);
assert.equal(verifySignature(body, 'sha256=deadbeef').ok, false);
assert.equal(verifySignature(body, undefined).ok, false);
ok('verifySignature: acepta firma válida, rechaza inválida/ausente');

// ── makeCloudSock con client mock (sin red) ──
const calls = [];
const mockClient = {
  phoneNumberId: '111',
  sendText: async (to, text) => { calls.push(['text', to, text]); return { messages: [{ id: 'wamid.OUT' }] }; },
  sendButtons: async (to, t, b) => { calls.push(['buttons', to, b.length]); return { messages: [{ id: 'wamid.BTN' }] }; },
  markRead: async (id) => { calls.push(['read', id]); return {}; },
  downloadMedia: async (mid) => { calls.push(['media', mid]); return { buffer: Buffer.from('IMG'), mime: 'image/jpeg' }; },
};
const sock = makeCloudSock(mockClient);
const sent = await sock.sendMessage('56961234567@s.whatsapp.net', { text: 'hola' });
assert.equal(sent.key.id, 'wamid.OUT');
assert.deepEqual(calls[0], ['text', '56961234567', 'hola']);
await sock.readMessages([{ id: 'wamid.AAA' }]);
assert.deepEqual(calls[1], ['read', 'wamid.AAA']);
const buf = await sock.downloadImage({ message: { imageMessage: { _cloudMediaId: 'MEDIA123' } } });
assert.equal(buf.toString(), 'IMG');
await sock.sendPresenceUpdate('composing', 'x'); // no-op, no debe tirar
ok('makeCloudSock: sendMessage/readMessages/downloadImage/presence mapean a la Graph API');

// ── tenants (multi-tenant ready) ──
process.env.WA_PHONE_NUMBER_ID = '111';
process.env.WA_TOKEN = 'tok';
loadTenantsFromEnv();
assert.equal(tenantCount(), 1);
assert.equal(getTenant('111').token, 'tok');
assert.equal(getTenant('999'), null);
ok('tenants: carga desde env + ruteo por phone_number_id');

// ── handleIncoming end-to-end con handleMessage mock (sin red) ──
const recibidos = [];
const res = await handleIncoming(
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: vText }] }],
  }),
  null, // sin firma; WA_APP_SECRET está seteado → debería RECHAZAR
  { logger: { warn() {}, error() {}, info() {} }, menu: {}, handleMessage: async (a) => recibidos.push(a) }
);
assert.equal(res.status, 401);
assert.equal(recibidos.length, 0);
ok('handleIncoming: rechaza 401 sin firma cuando WA_APP_SECRET está seteado');

// ahora con firma válida → procesa
const rawOk = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: vText }] }],
});
const sigOk = 'sha256=' + createHmac('sha256', 'app-secret').update(rawOk).digest('hex');
const res2 = await handleIncoming(rawOk, sigOk, {
  logger: { warn() {}, error() {}, info() {} }, menu: {}, handleMessage: async (a) => recibidos.push(a),
});
assert.equal(res2.status, 200);
assert.equal(recibidos.length, 1);
assert.equal(recibidos[0].msg.message.conversation, 'hola, quiero pedir');
assert.equal(recibidos[0].sock.user.id, '111'); // ruteado al tenant correcto
ok('handleIncoming: firma válida → rutea al tenant y procesa el mensaje');

console.log(`\n${pass} checks ✅ — scaffold Cloud API verificado (sin red)`);
