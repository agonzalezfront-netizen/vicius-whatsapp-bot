// Handoff v1 — trigger requiere_humano: el bot emite <<ESCALAR>> cuando deriva a la pareja
// (consulta fuera de menú, detalle no cargado/alergia, queja). El sistema lo recorta (el
// cliente NO lo ve) y marca la conversación requiere_humano. Un pedido normal NO escala.
//
// Uso: node qa-harness/repro-escalar.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu({
  day_label: 'Lunes de prueba', day_code: 'L',
  proteinas_dia: [{ nombre: 'Carne mechada', disponible: true }], // sin descripción cargada
  agregados_incluidos: ['arroz', 'puré', 'ensalada'],
  extras_pagados: [],
  bebida_incluida: ['Consomé'],
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
});

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

// Caso A: derivación (detalle no cargado + alergia) → debe escalar.
const a = await runBotTurn({
  menu: MENU_FALLBACK,
  history: [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '¡Hola! Hoy tenemos Carne mechada con arroz, puré o ensalada. ¿Querés un menú? 🙂' },
  ],
  userMessage: '¿qué ingredientes tiene la carne mechada? ¿lleva maní? soy muy alérgico',
  sesion: 'continua',
});
console.log('CASO A (deriva por alergia):\n' + a.textoVisible);
console.log('escalar=' + a.escalar);
check('A: escala (requiere_humano)', a.escalar === true);
check('A: el cliente NO ve el marcador', !/<<ESCALAR>>/.test(a.textoVisible));
check('A: deriva en el texto', /(consult|d[eé]jame|pareja|local|confirmo)/i.test(a.textoVisible));

// Caso B: pedido normal → NO escala.
const b = await runBotTurn({
  menu: MENU_FALLBACK,
  history: [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '¡Hola! Hoy tenemos Carne mechada con arroz, puré o ensalada. ¿Querés un menú? 🙂' },
  ],
  userMessage: 'carne mechada con arroz y puré, consomé',
  sesion: 'continua',
});
console.log('\nCASO B (pedido normal):\n' + b.textoVisible.slice(0, 200));
console.log('escalar=' + b.escalar);
check('B: NO escala (pedido normal)', b.escalar === false);
check('B: sin marcador visible', !/<<ESCALAR>>/.test(b.textoVisible));

console.log(`\n=== ESCALAR: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
