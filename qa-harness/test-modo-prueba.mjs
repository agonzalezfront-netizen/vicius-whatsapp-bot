// Test DETERMINISTA (sin red, sin LLM) — D16 incremento 2: MODO PRUEBA.
// El bot sirve el BORRADOR (wa.prueba.copy) al número verificado del dueño saltando la ventana; los clientes
// reales siguen con la derivación normal. Cubre los 5 casos de la precisión 3.
// Uso: node qa-harness/test-modo-prueba.mjs
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const REG = path.join(os.tmpdir(), `deriv-test-mp-${process.pid}.json`);
process.env.DERIVACION_REGISTRO_PATH = REG;
try { fs.rmSync(REG, { force: true }); } catch { /* no existía */ }

const { handleMessage } = await import('../src/handlers.js');
const { _resetWaConfigCache } = await import('../src/wa-config.js');

let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };
const logger = { info() {}, warn() {}, error() {} };
function mockSock() { const sent = []; return { sent, sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { key: { id: 'o' + sent.length } }; } }; }
const msg = (text, id, jid) => ({ key: { remoteJid: jid, fromMe: false, id }, message: { conversation: text } });
const OWNER = '56911112222';
const DRAFT = 'BORRADOR-DE-PRUEBA-XYZ';

// fetch mock: /api/menu-actual → wa con (o sin) prueba. `activo`/`numero` configurables por caso.
function armarFetch(waExtra) {
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => ({ wa: { modo: 'derivacion', ventana_horas: 24, copy: 'COPY-DERIVACION-NORMAL', ...waExtra } }),
    text: async () => '{}' });
}
async function fresh() { _resetWaConfigCache(); try { fs.rmSync(REG, { force: true }); } catch { /* */ } }
const call = (sock, text, id, jid) => handleMessage({ sock, logger, menu: {}, msg: msg(text, id, jid), slug: 'asushi' });

// A) dueño en modo prueba → 2 mensajes seguidos → 2 respuestas con el BORRADOR (bypass de la ventana)
await fresh(); armarFetch({ prueba: { activo: true, numero: OWNER, copy: DRAFT } });
let s = mockSock();
await call(s, 'Hola', 'a1', OWNER + '@s.whatsapp.net');
await call(s, 'Hola de nuevo', 'a2', OWNER + '@s.whatsapp.net');
console.log('=== A) dueño en modo prueba → 2 respuestas del borrador ===');
check(s.sent.length === 2, '2 respuestas (bypass de la ventana)');
check((s.sent[0]?.payload?.text || '').includes(DRAFT), 'sirve el BORRADOR, no el activo');

// B) cliente AJENO durante modo prueba → derivación normal (1 por ventana), NO el borrador
await fresh(); armarFetch({ prueba: { activo: true, numero: OWNER, copy: DRAFT } });
s = mockSock();
await call(s, 'Hola', 'b1', '56999998888@s.whatsapp.net');
await call(s, 'Hola', 'b2', '56999998888@s.whatsapp.net');
console.log('\n=== B) cliente ajeno durante prueba → ventana normal, sin borrador ===');
check(s.sent.length === 1, '1 sola respuesta (ventana normal)');
check(!(s.sent[0]?.payload?.text || '').includes(DRAFT), 'NO recibe el borrador del dueño');

// C) modo prueba VENCIDO (activo:false) → el dueño vuelve a la ventana normal
await fresh(); armarFetch({ prueba: { activo: false } });
s = mockSock();
await call(s, 'Hola', 'c1', OWNER + '@s.whatsapp.net');
await call(s, 'Hola', 'c2', OWNER + '@s.whatsapp.net');
console.log('\n=== C) prueba vencida → dueño en ventana normal ===');
check(s.sent.length === 1, '1 respuesta (ventana normal, sin bypass)');
check(!(s.sent[0]?.payload?.text || '').includes(DRAFT), 'no sirve el borrador');

// D) número NO verificado (prueba activa pero numero distinto al que escribe) → sin bypass
await fresh(); armarFetch({ prueba: { activo: true, numero: '56900000000', copy: DRAFT } });
s = mockSock();
await call(s, 'Hola', 'd1', OWNER + '@s.whatsapp.net');
console.log('\n=== D) número no verificado → sin bypass ===');
check(!(s.sent[0]?.payload?.text || '').includes(DRAFT), 'no aplica el bypass a un número que no es el verificado');

try { fs.rmSync(REG, { force: true }); } catch { /* */ }
console.log(fails ? `\nFALLA: ${fails} check(s)` : '\nOK modo-prueba (A/B/C/D)');
process.exit(fails ? 1 : 0);
