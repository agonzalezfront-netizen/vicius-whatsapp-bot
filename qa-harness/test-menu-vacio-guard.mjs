// Test UNITARIO (sin LLM): guard del menú vacío en el flujo de botones.
// Si no hay proteínas ni especiales (menú sin publicar / todo agotado), WhatsApp no acepta una lista
// con 0 filas → antes el flujo se rompía. Debe avisar honesto en texto.
//
// Uso: node qa-harness/test-menu-vacio-guard.mjs
import { procesar, estadoInicial, PASOS } from '../src/flujo-botones.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

const menuVacio = { day_label: 'Sin publicar', price_typical: 7000, proteinas_dia: [], platos_especiales: [], agregados_incluidos: [], bebida_incluida: [], extras_pagados: [] };
const menuAgotado = { ...menuVacio, proteinas_dia: [{ nombre: 'Pollo', disponible: false }] };
const menuOk = { ...menuVacio, proteinas_dia: [{ nombre: 'Pollo', disponible: true }] };

console.log('— Menú vacío (sin publicar) —');
let r = procesar(estadoInicial(), { tipo: 'init' }, menuVacio);
check('no rompe: devuelve salida', Array.isArray(r.salidas) && r.salidas.length > 0);
check('avisa en TEXTO (no lista)', r.salidas[0].tipo === 'text');
check('mensaje honesto de "no publicado"', /no est[aá] publicado|apenas est[eé]/i.test(r.salidas[0].text));

console.log('\n— Todas las proteínas agotadas (disponible:false) → mismo guard —');
r = procesar(estadoInicial(), { tipo: 'init' }, menuAgotado);
check('avisa en texto', r.salidas[0].tipo === 'text' && /no est[aá] publicado/i.test(r.salidas[0].text));

console.log('\n— Regresión: con menú válido SÍ muestra la lista —');
r = procesar(estadoInicial(), { tipo: 'init' }, menuOk);
check('lista de platos normal', r.salidas.some((s) => s.tipo === 'list'));

console.log(`\n=== MENU-VACIO GUARD: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
