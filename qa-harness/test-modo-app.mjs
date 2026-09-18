// Test DETERMINISTA (sin red, sin LLM) — BUG 2324 (18-09): modo `app` por tenant + fallback neutro.
//
// Cubre:
//   A) tenants.js captura `modo` y `cartaUrl` de WA_TENANTS.
//   B) modo app → UN solo mensaje con el link a la carta (no el menú conversacional); 2º mensaje dentro de la
//      ventana → silencio (guarda determinista, derivacion-registro). El link viene del config, no hardcodeado.
//   C) "matar el default": un slug propio (≠ sazon) SIN menú propio ni modo app → mensaje neutro, NO la carta
//      vieja del Sazón que vive en el slot default.
//
// Uso: node qa-harness/test-modo-app.mjs
//
// AISLAMIENTO: la guarda de derivación PERSISTE el registro (tenant|jid) en disco y sobrevive entre corridas
// → si no lo aislamos, la 2ª corrida silencia el 1er mensaje (el jid quedó "ya contactado") y el test da falso
// ROJO. Apuntamos el registro a un temp fresco ANTES de evaluar el grafo (imports dinámicos: el módulo lee
// DERIVACION_REGISTRO_PATH en su eval, que ocurre antes del cuerpo si el import fuera estático). Clase:
// feedback_test_e2e_localstorage_clear_post_deploy — testear desde estado fresco.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const REG = path.join(os.tmpdir(), `deriv-test-modo-app-${process.pid}.json`);
process.env.DERIVACION_REGISTRO_PATH = REG;
process.env.LOCAL_DEFAULT_CERRADO = 'true';   // ítem 3: Sazón cerró → el slot default responde neutro dedup-safe
try { fs.rmSync(REG, { force: true }); } catch { /* no existía */ }

const { loadTenantsFromEnv, getTenant } = await import('../src/cloud-api/tenants.js');
const { handleMessage } = await import('../src/handlers.js');
const { clearActiveMenu, setActiveMenu } = await import('../src/active-menu.js');

let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

// fetch mock: /api/menu-actual sin `wa` → getWaConfig cae a 'conversacional' (default). Así SOLO el flag del
// tenant (modo:app) dispara la derivación; nada toca la red real.
const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

const logger = { info() {}, warn() {}, error() {} };
function mockSock() {
  const sent = [];
  return { sent, sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { key: { id: 'out_' + sent.length } }; } };
}
const msg = (text, id) => ({ key: { remoteJid: '56999999999@s.whatsapp.net', fromMe: false, id }, message: { conversation: text } });

console.log('=== A) tenants.js captura modo/cartaUrl de WA_TENANTS ===');
process.env.WA_TENANTS = JSON.stringify([
  { phoneNumberId: 'PNID_ASUSHI', token: 'tok', name: 'A Sushi', slug: 'asushi', modo: 'app',
    cartaUrl: 'https://asushi.viciusstudio.cl/pedir/asushi' },
]);
loadTenantsFromEnv();
const t = getTenant('PNID_ASUSHI');
check(t?.modo === 'app', 'captura modo:"app"');
check((t?.cartaUrl || '').includes('/pedir/asushi'), 'captura cartaUrl del config');

console.log('\n=== B) modo app → un mensaje con link a la carta, no el menú conversacional ===');
const s = mockSock();
await handleMessage({ sock: s, logger, menu: {}, msg: msg('Hola', 'a1'), slug: 'asushi',
  tenantModo: 'app', cartaUrl: t.cartaUrl, tenantName: 'A Sushi' });
check(s.sent.length === 1, 'exactamente 1 saliente');
check((s.sent[0]?.payload?.text || '').includes('/pedir/asushi'), 'el mensaje trae el link de la carta (del config)');
check(!/plato del d[ií]a|menú de hoy|armemos tu pedido/i.test(s.sent[0]?.payload?.text || ''), 'NO es el flujo conversacional del menú');
// Guarda de CLASE (retoques Cortex 18-09): TODO copy que sale por WhatsApp sin raya larga (—, delata bot) ni
// mención de "pago" (el pago en línea no está encendido). memorias feedback_sin_guiones_largos_en_whatsapp +
// feedback_copy_derivar_de_fuente_de_verdad.
const txtApp = s.sent[0]?.payload?.text || '';
check(!/[—–]/.test(txtApp), 'copy modo app SIN raya larga (— ni –)');
check(!/\bpago\b/i.test(txtApp), 'copy modo app NO menciona "pago" (pago en línea off)');
await handleMessage({ sock: s, logger, menu: {}, msg: msg('Hola otra vez', 'a2'), slug: 'asushi',
  tenantModo: 'app', cartaUrl: t.cartaUrl, tenantName: 'A Sushi' });
check(s.sent.length === 1, '2º mensaje dentro de la ventana → silencio (guarda determinista, 1 saliente por ventana)');
// Fallback (sin cartaUrl) también debe salir sin raya larga.
const sf = mockSock();
await handleMessage({ sock: sf, logger, menu: {}, msg: msg('Hola', 'f1'), slug: 'otrofallback',
  tenantModo: 'app', cartaUrl: null, tenantName: 'Otro' });
check(!/[—–]/.test(sf.sent[0]?.payload?.text || ''), 'copy fallback de derivación SIN raya larga');

console.log('\n=== C) sin menú propio ni modo app → neutro (no la carta vieja del Sazón en el default) ===');
clearActiveMenu();
setActiveMenu({ day_label: 'Viernes 1 (Sazón viejo)', day_code: 'V', published_at: '2026-06-25T00:00:00Z',
  proteinas_dia: [{ nombre: 'Plato del día', disponible: true }], agregados_incluidos: [], bebida_incluida: [],
  extras_pagados: [], platos_especiales: [] });   // slot DEFAULT = carta vieja del Sazón
const s2 = mockSock();
await handleMessage({ sock: s2, logger, menu: {}, msg: msg('Hola', 'c1'), slug: 'otrolocal' });
check(s2.sent.length === 1, '1 saliente');
check(/no estamos tomando pedidos/i.test(s2.sent[0]?.payload?.text || ''), 'mensaje neutro');
check(!/plato del d[ií]a/i.test(s2.sent[0]?.payload?.text || ''), 'NO sirve la carta vieja del Sazón (default)');

console.log('\n=== E) Sazón cerró (LOCAL_DEFAULT_CERRADO) → el slot default responde neutro dedup-safe ===');
const s3 = mockSock();
await handleMessage({ sock: s3, logger, menu: {}, msg: msg('Hola', 'e1'), slug: 'sazon' });
check(s3.sent.length === 1, '1 saliente');
check(/no estamos tomando pedidos/i.test(s3.sent[0]?.payload?.text || ''), 'mensaje neutro (no el menú de junio)');
check(!/plato del d[ií]a/i.test(s3.sent[0]?.payload?.text || ''), 'NO sirve el menú viejo del Sazón');
await handleMessage({ sock: s3, logger, menu: {}, msg: msg('Hola de nuevo', 'e2'), slug: 'sazon' });
check(s3.sent.length === 1, '2º mensaje dentro de la ventana → silencio (neutro dedup-safe)');

globalThis.fetch = origFetch;
try { fs.rmSync(REG, { force: true }); } catch { /* best-effort */ }
console.log(fails ? `\nFALLA: ${fails} check(s)` : '\nOK modo-app (A/B/C/E)');
process.exit(fails ? 1 : 0);
