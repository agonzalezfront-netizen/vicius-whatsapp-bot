// Handoff v1 — estados de entrega: el webhook Cloud API procesa value.statuses
// (sent/delivered/read/failed) y los pasa a onStatus → actualizarEstadoMensaje en el wizard.
// Test unitario directo de handleIncoming (sin red): tenant de prueba por env, WA_APP_SECRET
// sin setear (firma skipped en dev), onStatus mock que captura.
//
// Uso: node qa-harness/test-webhook-status.mjs

process.env.WA_PHONE_NUMBER_ID = 'PN_TEST_1';
process.env.WA_TOKEN = 'tok_test';
delete process.env.WA_APP_SECRET; // firma no verificada en dev

const { loadTenantsFromEnv } = await import('../src/cloud-api/tenants.js');
const { handleIncoming } = await import('../src/cloud-api/webhook.js');
loadTenantsFromEnv();

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

const captured = [];
const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: 'PN_TEST_1' },
        statuses: [
          { id: 'wamid.AAA', status: 'delivered', recipient_id: '569111', timestamp: '1' },
          { id: 'wamid.BBB', status: 'read', recipient_id: '569111', timestamp: '2' },
          { id: 'wamid.CCC', status: 'failed', recipient_id: '569111', errors: [{ title: 'rate limit' }] },
        ],
      },
    }],
  }],
};

const r = await handleIncoming(JSON.stringify(payload), null, {
  logger: { warn() {}, error() {}, info() {} },
  menu: {},
  handleMessage: async () => {},
  onStatus: async (s) => { captured.push(s); },
});

check('responde 200', r.status === 200);
check('procesó los 3 estados', captured.length === 3);
check('delivered mapeado', captured[0]?.id === 'wamid.AAA' && captured[0]?.status === 'delivered');
check('read mapeado', captured[1]?.status === 'read');
check('failed con error', captured[2]?.status === 'failed' && captured[2]?.error === 'rate limit');

// sin onStatus (flag off) → no rompe
const r2 = await handleIncoming(JSON.stringify(payload), null, {
  logger: { warn() {}, error() {}, info() {} }, menu: {}, handleMessage: async () => {}, onStatus: null,
});
check('sin onStatus (flag off) → 200 igual', r2.status === 200);

console.log(`\n=== WEBHOOK-STATUS: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
