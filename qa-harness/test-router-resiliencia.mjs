// Test de resiliencia del ROUTER (bug 2026-06-29): si el wizard devuelve 5xx al persistir el estado,
// el bot DEBE enviar igual los botones (el tier básico es 100% botones). Con el código viejo,
// setEstadoFlujo tiraba y abortaba el turno ANTES de mandar la lista → este test fallaba.
import { setActiveMenu } from '../src/active-menu.js';
import { manejarTurnoBotones } from '../src/flujo-botones-router.js';

setActiveMenu({
  day_label: 'Test Lunes', day_code: 'L', published_at: new Date().toISOString(),
  proteinas_dia: [{ nombre: 'Pollo', disponible: true }, { nombre: 'Carne mechada', disponible: true }],
  agregados_incluidos: ['Arroz', 'Puré'], bebida_incluida: ['Consomé'], extras_pagados: [],
  platos_especiales: [{ nombre: 'Pabellón criollo', precio: 9000 }],
});

// Simula el wizard CAÍDO: todo fetch al wizard → 520 (el peor caso, persistencia siempre falla).
const origFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return { ok: false, status: 520, json: async () => ({}), text: async () => '' }; };

const sent = [];
const sock = { sendMessage: async (_jid, payload) => { sent.push(payload); return { key: { id: 'x' } }; } };
const logger = { info() {}, warn() {}, error() {} };

let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

try {
  await manejarTurnoBotones({ sock, jid: '56911111111@s.whatsapp.net', senderName: 'Test', btnId: null, texto: 'hola', logger });
} catch (e) {
  check(false, `manejarTurnoBotones NO debe tirar aunque el wizard falle (tiró: ${e.message})`);
} finally {
  globalThis.fetch = origFetch;
}

const tieneLista = sent.some((p) => Array.isArray(p.sections) && p.sections.length);
const textos = sent.filter((p) => !p.sections && !p.buttons).length;
console.log(`\nmensajes enviados: ${sent.length} (textos=${textos}, listas=${sent.filter((p) => p.sections).length}) | fetchCalls=${fetchCalls}`);
check(sent.length >= 3, 'envía saludo + menú + lista (≥3 mensajes) pese al wizard 520');
check(tieneLista, '🎯 la LISTA de botones (proteína) se envió PESE al 520 del wizard');
check(fetchCalls >= 2, 'hubo reintentos ante el 5xx (fetchCalls ≥ 2)');

console.log(fails ? `\n❌ ${fails} fallo(s)` : '\n✅ router resiliente: los botones llegan aunque la persistencia caiga');
process.exit(fails ? 1 : 0);
