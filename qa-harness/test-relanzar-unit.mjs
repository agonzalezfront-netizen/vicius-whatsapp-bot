// "Devolver al bot" manual → mensajeRelanzarFlujo() arma un saludo de continuidad + el menú del
// día (determinista, sin LLM) para relanzar el flujo de pedido. Uso: node qa-harness/test-relanzar-unit.mjs
import { mensajeRelanzarFlujo } from '../src/claude.js';
const { setActiveMenu } = await import('../src/active-menu.js');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

// Con menú activo: relanza con saludo de continuidad + las proteínas/bebida del día.
setActiveMenu({
  day_label: 'Lunes', day_code: 'L',
  proteinas_dia: [{ nombre: 'Carne mechada', disponible: true }, { nombre: 'Pollo asado', disponible: true }],
  agregados_incluidos: ['arroz', 'puré', 'ensalada'],
  extras_pagados: [],
  bebida_incluida: ['Consomé'],
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
});
const m = mensajeRelanzarFlujo({ proteinas_dia: [], bebida_incluida: [] });
console.log('--- mensaje relanzar ---\n' + m + '\n------------------------');
check('es de continuidad (no "Bienvenido"), arranca con "¡Listo!"', m.startsWith('¡Listo!') && !/Bienvenido/.test(m));
check('incluye el menú del día (proteínas reales)', m.includes('Carne mechada') && m.includes('Pollo asado'));
check('incluye la bebida del día', /Consom[ée]/.test(m));
check('invita a armar el pedido', /pedido|armemos|menú de hoy/i.test(m));

console.log(`\n=== RELANZAR UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
