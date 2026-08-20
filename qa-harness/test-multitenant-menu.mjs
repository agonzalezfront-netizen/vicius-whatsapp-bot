// Test DETERMINISTA (sin red, sin LLM) de Task 5 — multitenant F1.5: el bot resuelve el LOCAL por
// slug (a futuro: phone_number_id → slug, vía tenants.js) y arma cada pedido contra el MENÚ DE ESE
// LOCAL. Antes de este fix, active-menu.js era un singleton global: publicar el menú de un 2º local
// pisaba el del primero (o ambos compartían el mismo menú activo) → un tenant vería el menú de otro.
//
// Cubre:
//   A) 2 tenants (slugs distintos) con menús distintos → getActiveMenu(slug) devuelve el menú CORRECTO
//      de cada uno (no comparten estado).
//   B) Conversación completa vía manejarTurnoBotones (router real, fetch mockeado — sin red) para 2
//      clientes de 2 locales distintos en paralelo → cada pedido creado lleva los ítems del menú de
//      SU local, no el del otro (repro del bug real: cross-tenant leak).
//   C) Back-compat: un tenant SIN slug sigue viendo el menú "de siempre" (slot default), igual que hoy
//      (no puede romper al Sazón mientras no tenga slug asignado).
//
// Uso: node qa-harness/test-multitenant-menu.mjs
import { setActiveMenu, getActiveMenu, clearActiveMenu } from '../src/active-menu.js';
import { manejarTurnoBotones } from '../src/flujo-botones-router.js';

let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

const basePayload = (nombreProteina, agregados, bebida) => ({
  day_label: 'Test Lunes',
  day_code: 'L',
  published_at: new Date().toISOString(),
  proteinas_dia: [{ nombre: nombreProteina, disponible: true }],
  agregados_incluidos: agregados,
  bebida_incluida: [bebida],
  extras_pagados: [],
  platos_especiales: [],
});

const MENU_SAZON = basePayload('Pollo Sazón', ['Arroz', 'Puré'], 'Consomé');
const MENU_DONPEPE = basePayload('Pescado Don Pepe', ['Papas', 'Ensalada'], 'Jugo');

console.log('=== A) getActiveMenu(slug) — 2 locales no comparten menú activo ===');
clearActiveMenu('sazon');
clearActiveMenu('donpepe');
setActiveMenu(MENU_SAZON, 'sazon');
setActiveMenu(MENU_DONPEPE, 'donpepe');
check(getActiveMenu('sazon')?.proteinas_dia?.[0]?.nombre === 'Pollo Sazón', 'sazon ve SU proteína (Pollo Sazón)');
check(getActiveMenu('donpepe')?.proteinas_dia?.[0]?.nombre === 'Pescado Don Pepe', 'donpepe ve SU proteína (Pescado Don Pepe)');
check(getActiveMenu('sazon') !== getActiveMenu('donpepe'), 'los objetos de menú son DISTINTOS (sin cross-tenant leak)');

console.log('\n=== C) Back-compat: sin slug → slot default (el de siempre) ===');
const MENU_LEGACY = basePayload('Menú sin slug', ['Arroz'], 'Jugo natural');
setActiveMenu(MENU_LEGACY); // sin slug — igual que index.js/qr-server.js hoy
check(getActiveMenu()?.proteinas_dia?.[0]?.nombre === 'Menú sin slug', 'getActiveMenu() sin slug devuelve el slot default');
check(getActiveMenu('local-inexistente')?.proteinas_dia?.[0]?.nombre === 'Menú sin slug', 'slug desconocido/sin registrar → cae al default (no rompe, no undefined)');
check(getActiveMenu('sazon')?.proteinas_dia?.[0]?.nombre === 'Pollo Sazón', 'el slot default NO pisó el de sazon (siguen aislados)');

console.log('\n=== B) Router real (manejarTurnoBotones) — 2 clientes, 2 locales, fetch mockeado (sin red) ===');
// Mock de wizard: estado-flujo (persistencia) en memoria + captura de los pedidos creados.
// Mock del wizard con la MISMA key compuesta que el backend real (bloqueador #2): (jid, local_slug).
// Así el test refleja el aislamiento real y captura si el bot NO propaga el local.
const estados = new Map();
const kEstado = (jid, local) => `${jid}::${local || 'sazon'}`;
const estadoCalls = [];   // registra qué local usó el bot en cada llamada de estado
const pedidosCreados = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = opts.method || 'GET';
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('/api/flujo-estado/borrar')) {
    const b = JSON.parse(opts.body);
    estadoCalls.push({ op: 'borrar', jid: b.cliente_jid, local: b.local_slug || 'sazon' });
    estados.delete(kEstado(b.cliente_jid, b.local_slug));
    return ok({ ok: true });
  }
  if (u.includes('/api/flujo-estado') && m === 'POST') {
    const b = JSON.parse(opts.body);
    estadoCalls.push({ op: 'set', jid: b.cliente_jid, local: b.local_slug || 'sazon' });
    estados.set(kEstado(b.cliente_jid, b.local_slug), b.estado);
    return ok({ ok: true });
  }
  if (u.includes('/api/flujo-estado')) {
    const params = new URLSearchParams(u.split('?')[1] || '');
    const jid = params.get('jid') || '';
    const local = params.get('local') || 'sazon';
    estadoCalls.push({ op: 'get', jid, local });
    return ok({ estado: estados.get(kEstado(jid, local)) ?? null });
  }
  if (u.includes('/api/pedidos') && m === 'POST') {
    const b = JSON.parse(opts.body);
    pedidosCreados.push(b);
    return ok({ id: pedidosCreados.length });
  }
  return ok({ ok: true }); // push equipo, comunicaciones, etc. — no relevantes acá
};

const logger = { info() {}, warn() {}, error() {} };
const sock = { sendMessage: async () => ({ key: { id: 'x' } }) };
const SEQ = ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si'];

async function correrPedido(jid, slug, senderName) {
  await manejarTurnoBotones({ sock, jid, senderName, btnId: null, texto: 'hola', logger, slug });
  for (const btnId of SEQ) {
    await manejarTurnoBotones({ sock, jid, senderName, btnId, texto: null, logger, slug });
  }
}

try {
  const JID_SAZON = '56911111111@s.whatsapp.net';
  const JID_DONPEPE = '56922222222@s.whatsapp.net';
  await correrPedido(JID_SAZON, 'sazon', 'Cliente Sazón');
  await correrPedido(JID_DONPEPE, 'donpepe', 'Cliente Don Pepe');

  const pedidoSazon = pedidosCreados.find((p) => p.cliente_jid === JID_SAZON);
  const pedidoDonPepe = pedidosCreados.find((p) => p.cliente_jid === JID_DONPEPE);

  check(pedidosCreados.length === 2, `se crearon 2 pedidos (got ${pedidosCreados.length})`);
  check(!!pedidoSazon && pedidoSazon.items?.[0]?.proteina === 'Pollo Sazón', `pedido de sazon con SU proteína (got ${pedidoSazon?.items?.[0]?.proteina})`);
  check(!!pedidoDonPepe && pedidoDonPepe.items?.[0]?.proteina === 'Pescado Don Pepe', `pedido de donpepe con SU proteína (got ${pedidoDonPepe?.items?.[0]?.proteina})`);
  check((pedidoSazon?.items?.[0]?.agregados || []).includes('Arroz'), 'pedido de sazon con SUS acompañamientos (Arroz)');
  check((pedidoDonPepe?.items?.[0]?.agregados || []).includes('Papas'), 'pedido de donpepe con SUS acompañamientos (Papas)');
  // Bloqueador #3 (multitenant): el pedido debe llevar local_slug para que el wizard sepa a QUÉ local pertenece.
  check(pedidoSazon?.local_slug === 'sazon', `pedido de sazon lleva local_slug='sazon' (got ${pedidoSazon?.local_slug})`);
  check(pedidoDonPepe?.local_slug === 'donpepe', `pedido de donpepe lleva local_slug='donpepe' (got ${pedidoDonPepe?.local_slug})`);
  // Bloqueador #2: el estado de flujo se persiste/lee scoped al local (no colisiona entre tenants).
  check(estadoCalls.some((c) => c.op === 'set' && c.local === 'donpepe'), 'el bot PERSISTE el estado con local=donpepe');
  check(estadoCalls.some((c) => c.op === 'get' && c.local === 'donpepe'), 'el bot LEE el estado con local=donpepe (no el default)');
} catch (e) {
  check(false, `manejarTurnoBotones con slug NO debe tirar (tiró: ${e.message})`);
}
// (el fetch mockeado se mantiene para el test D de abajo; se restaura al final)

console.log('\n=== D) Mismo jid en 2 locales — el estado NO colisiona (bloqueador #2) ===');
try {
  const JID = '56900000000@s.whatsapp.net';
  await manejarTurnoBotones({ sock, jid: JID, senderName: 'X', btnId: null, texto: 'hola', logger, slug: 'sazon' });
  await manejarTurnoBotones({ sock, jid: JID, senderName: 'X', btnId: 'prot:0', texto: null, logger, slug: 'sazon' });
  await manejarTurnoBotones({ sock, jid: JID, senderName: 'X', btnId: null, texto: 'hola', logger, slug: 'donpepe' }); // MISMO jid, otro local
  const eSazon = estados.get(kEstado(JID, 'sazon'));
  const eDonpepe = estados.get(kEstado(JID, 'donpepe'));
  check(!!eSazon, 'el estado de sazon sigue vivo tras un turno de donpepe con el MISMO jid (no lo pisó)');
  check(!!eDonpepe && eSazon !== eDonpepe, 'sazon y donpepe tienen estados SEPARADOS para el mismo jid');
} catch (e) {
  check(false, `mismo jid en 2 locales NO debe romper (tiró: ${e.message})`);
} finally {
  globalThis.fetch = origFetch;
}

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK');
process.exit(fails ? 1 : 0);
