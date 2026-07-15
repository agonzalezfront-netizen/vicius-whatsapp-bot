// Test UNITARIO (determinista, sin LLM) de BUG4: TTL de sesión + keywords de reset + escape.
// Origen: Alberto quedó atascado 8 días en un pedido a medias; "hola" no reseteaba (15-jul).
//
// Uso: node qa-harness/test-bug4-reset-ttl.mjs
import { procesar, estadoInicial, sesionExpirada, esResetKeyword, TTL_SESION_MS, PASOS }
  from '../src/flujo-botones.js';

const menu = {
  day_label: 'Test', price_typical: 7000,
  proteinas_dia: [{ nombre: 'Carne mechada', disponible: true }, { nombre: 'Pollo', disponible: true }],
  agregados_incluidos: ['Arroz', 'Puré', 'Ensalada'],
  bebida_incluida: ['Consomé'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  platos_especiales: [],
};

let pass = 0, fail = 0;
function check(nombre, cond) {
  if (cond) { pass++; console.log('  ✅ ' + nombre); }
  else { fail++; console.log('  ❌ ' + nombre); }
}
const tieneBoton = (salidas, bid) =>
  salidas.some((s) => s.tipo === 'buttons' && (s.buttons || []).some((b) => b.id === bid));
// Estado mid-armado (proteína elegida, en ACOMP) → hay progreso.
function conProgreso() {
  const r = procesar(estadoInicial(), { tipo: 'button', id: 'prot:0' }, menu);
  return r.estado;
}

console.log('— sesionExpirada (TTL) —');
check('estado recién sellado → NO expirada', sesionExpirada({ _ts: Date.now() }, Date.now()) === false);
check('estado +4h (> 3h TTL) → expirada', sesionExpirada({ _ts: Date.now() - 4 * 3600 * 1000 }, Date.now()) === true);
check('estado justo bajo el TTL → NO expirada', sesionExpirada({ _ts: Date.now() - (TTL_SESION_MS - 60000) }, Date.now()) === false);
check('estado sin _ts → NO expirada (no rompe estados viejos)', sesionExpirada({}, Date.now()) === false);
check('estado null → NO expirada', sesionExpirada(null, Date.now()) === false);

console.log('\n— esResetKeyword (match exacto) —');
check('"hola" es reset', esResetKeyword('hola') === true);
check('"HOLA " (mayús/espacios) es reset', esResetKeyword('HOLA ') === true);
check('"menú" (con tilde) es reset', esResetKeyword('menú') === true);
check('"cancelar" es reset', esResetKeyword('cancelar') === true);
check('"calle hola 123" NO es reset (no pisa direcciones)', esResetKeyword('calle hola 123') === false);
check('"carne mechada" NO es reset', esResetKeyword('carne mechada') === false);

console.log('\n— Reset por keyword: con pedido a medias → pregunta (RESET_CONFIRM) —');
let r = procesar(conProgreso(), { tipo: 'text', texto: 'hola' }, menu);
check('paso pasa a RESET_CONFIRM', r.estado.paso === PASOS.RESET_CONFIRM);
check('guarda resetReturn (para "No, volver")', !!r.estado.resetReturn);
check('ofrece botón reset_si', tieneBoton(r.salidas, 'reset_si'));
check('ofrece botón reset_no', tieneBoton(r.salidas, 'reset_no'));

console.log('\n— Reset por keyword: sin progreso → arranca fresco —');
r = procesar(estadoInicial(), { tipo: 'text', texto: 'hola' }, menu);
check('sigue/vuelve a PROTEINA', r.estado.paso === PASOS.PROTEINA);
check('sin items', (r.estado.items || []).length === 0);

console.log('\n— Botones de escape globales —');
r = procesar(conProgreso(), { tipo: 'button', id: 'reset_si' }, menu);
check('reset_si → estado fresco (PROTEINA, sin items)', r.estado.paso === PASOS.PROTEINA && (r.estado.items || []).length === 0);

const stConf = conProgreso(); stConf.resetReturn = stConf.paso; stConf.paso = PASOS.RESET_CONFIRM;
r = procesar(stConf, { tipo: 'button', id: 'reset_no' }, menu);
check('reset_no → vuelve al paso previo (ACOMP)', r.estado.paso === PASOS.ACOMP);

r = procesar(estadoInicial(), { tipo: 'button', id: 'hablar_local' }, menu);
check('hablar_local → flag escalar', r.escalar === true);

console.log('\n— Fallback: 2º "no te entendí" → botones de escape + escalar —');
let e = estadoInicial();
let r1 = procesar(e, { tipo: 'text', texto: 'xyzzy123' }, menu);
check('1er no-entendido: sin escalar', !r1.escalar);
check('1er no-entendido: repite hint (texto)', r1.salidas.some((s) => s.tipo === 'text' && /no te entend/i.test(s.text)));
let r2 = procesar(r1.estado, { tipo: 'text', texto: 'qwerty999' }, menu);
check('2º no-entendido: escalar', r2.escalar === true);
check('2º no-entendido: ofrece "empezar de nuevo"', tieneBoton(r2.salidas, 'reset_si'));
check('2º no-entendido: ofrece "hablar con el local"', tieneBoton(r2.salidas, 'hablar_local'));

console.log('\n— Regresión: un texto que SÍ matchea una opción avanza normal —');
r = procesar(estadoInicial(), { tipo: 'text', texto: 'Carne mechada' }, menu);
check('elegir proteína por texto avanza a ACOMP', r.estado.paso === PASOS.ACOMP);
check('no false-resetea un nombre de plato', r.estado.actual && r.estado.actual.proteina === 'Carne mechada');

console.log(`\n=== BUG4: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
