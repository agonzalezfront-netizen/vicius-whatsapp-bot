// Test de integración HTTP del webhook montado en el server real (startQRServer),
// con handleMessage MOCK (sin LLM ni red). Verifica: handshake GET, POST firmado →
// ruteo al tenant → handleMessage recibe el mensaje normalizado.
// Uso: node qa-harness/test-webhook-server.mjs

import assert from 'node:assert';
import { createHmac } from 'node:crypto';

process.env.WA_VERIFY_TOKEN = 'verify-xyz';
process.env.WA_APP_SECRET = 'secret-abc';
process.env.WA_PHONE_NUMBER_ID = '1281173078402742';
process.env.WA_TOKEN = 'fake-token';

const { startQRServer } = await import('../src/qr-server.js');
const { loadTenantsFromEnv } = await import('../src/cloud-api/tenants.js');
loadTenantsFromEnv();

const PORT = 8077;
const recibidos = [];
const logger = { info() {}, warn() {}, error() {} };
const server = startQRServer(logger, {
  port: PORT,
  menu: { plato_estandar: { precio: 7000, incluye_agregados: 2 } },
  handleMessage: async (a) => { recibidos.push(a); },
});
await new Promise((r) => setTimeout(r, 300)); // dar tiempo a listen

const base = `http://127.0.0.1:${PORT}`;
let pass = 0;
const ok = (n) => { console.log('✅', n); pass++; };

// 1) Handshake GET correcto
const g = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-xyz&hub.challenge=CHALLENGE42`);
assert.equal(g.status, 200);
assert.equal(await g.text(), 'CHALLENGE42');
ok('GET /webhook: handshake devuelve el challenge con verify_token correcto');

// 2) Handshake GET con token malo → 403
const gBad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=X`);
assert.equal(gBad.status, 403);
ok('GET /webhook: 403 con verify_token incorrecto');

// 3) POST firmado → procesa y llama handleMessage
const payload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: '1281173078402742' },
        contacts: [{ wa_id: '56961234567', profile: { name: 'Tester' } }],
        messages: [{ from: '56961234567', id: 'wamid.Z', type: 'text', text: { body: 'quiero un menú' } }],
      },
    }],
  }],
});
const sig = 'sha256=' + createHmac('sha256', 'secret-abc').update(payload).digest('hex');
const p = await fetch(`${base}/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
  body: payload,
});
assert.equal(p.status, 200);
await new Promise((r) => setTimeout(r, 50));
assert.equal(recibidos.length, 1);
assert.equal(recibidos[0].msg.message.conversation, 'quiero un menú');
assert.equal(recibidos[0].msg.key.remoteJid, '56961234567@s.whatsapp.net');
assert.equal(recibidos[0].sock.user.id, '1281173078402742'); // tenant correcto
ok('POST /webhook: firma válida → handleMessage recibe el mensaje normalizado y el sock del tenant');

// 4) POST con firma inválida → 401, no procesa
const pBad = await fetch(`${base}/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=bad' },
  body: payload,
});
assert.equal(pBad.status, 401);
assert.equal(recibidos.length, 1); // no aumentó
ok('POST /webhook: firma inválida → 401, no procesa');

server.close();
console.log(`\n${pass} checks ✅ — webhook HTTP integrado y verificado (sin LLM)`);
process.exit(0);
