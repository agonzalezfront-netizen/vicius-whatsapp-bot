// #medium: dedup de reentregas del webhook. Meta reintenta el POST si el 200 tarda → el MISMO mensaje
// (wamid) no debe procesarse 2× (evita doble respuesta / pedido duplicado). handleMessage MOCK.
// Uso: node qa-harness/test-webhook-dedup.mjs
import assert from 'node:assert';
import { createHmac } from 'node:crypto';

process.env.WA_VERIFY_TOKEN = 'verify-xyz';
process.env.WA_APP_SECRET = 'secret-abc';
process.env.WA_PHONE_NUMBER_ID = '1281173078402742';
process.env.WA_TOKEN = 'fake-token';

const { startQRServer } = await import('../src/qr-server.js');
const { loadTenantsFromEnv } = await import('../src/cloud-api/tenants.js');
loadTenantsFromEnv();

const PORT = 8079;
const recibidos = [];
const logger = { info() {}, warn() {}, error() {} };
const server = startQRServer(logger, {
  port: PORT,
  menu: { plato_estandar: { precio: 7000, incluye_agregados: 2 } },
  handleMessage: async (a) => { recibidos.push(a); },
});
await new Promise((r) => setTimeout(r, 300));

const base = `http://127.0.0.1:${PORT}`;
const payload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '1281173078402742' },
    contacts: [{ wa_id: '56961234567', profile: { name: 'Tester' } }],
    messages: [{ from: '56961234567', id: 'wamid.DUP1', type: 'text', text: { body: 'hola' } }],
  } }] }],
});
const sig = 'sha256=' + createHmac('sha256', 'secret-abc').update(payload).digest('hex');
const post = () => fetch(`${base}/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
  body: payload,
});

// Meta entrega el MISMO webhook dos veces (reentrega por timeout del 200)
const r1 = await post(); assert.equal(r1.status, 200);
const r2 = await post(); assert.equal(r2.status, 200);   // el 2º también responde 200 (no rompe)

// pero el mensaje se procesó UNA sola vez
assert.equal(recibidos.length, 1, `esperaba 1 handleMessage, hubo ${recibidos.length}`);
assert.equal(recibidos[0].msg.key.id, 'wamid.DUP1');

// un mensaje DISTINTO sí se procesa
const payload2 = payload.replace('wamid.DUP1', 'wamid.OTRO').replace("body: 'hola'", "body: 'chao'");
const sig2 = 'sha256=' + createHmac('sha256', 'secret-abc').update(payload2).digest('hex');
await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig2 }, body: payload2 });
assert.equal(recibidos.length, 2, 'un wamid nuevo debe procesarse');

console.log('✅ webhook dedup: reentrega del mismo wamid se ignora; wamid nuevo se procesa');
process.exit(0);   // process.exit cierra el server; server.close() aquí competía con libuv (ruido de teardown)
