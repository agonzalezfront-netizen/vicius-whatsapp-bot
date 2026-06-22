// Bug 2026-06-22: el bot anunciaba los extras a "$2.000 c/u" fijo, ignorando el precio individual
// que el local le pone a cada extra en el Menu Manager. El cobro ya era correcto (precios.js); el
// fix es de PRESENTACIÓN. Este test verifica que el anuncio del menú usa el precio individual.
// (buildSaludoEjemplo no se exporta → lo ejercitamos vía mensajeRelanzarFlujo, que lo usa.)
// Uso: node qa-harness/test-extras-precio-unit.mjs
import { mensajeRelanzarFlujo } from '../src/claude.js';
const { setActiveMenu } = await import('../src/active-menu.js');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

setActiveMenu({
  day_label: 'Lunes', day_code: 'L',
  proteinas_dia: [{ nombre: 'Pollo asado', disponible: true }],
  agregados_incluidos: ['arroz', 'puré'],
  // extras con precios DISTINTOS de $2.000 (lo que el local configuró)
  extras_pagados: [{ nombre: 'Papas fritas', precio: 1500 }, { nombre: 'Tostones', precio: 3000 }],
  bebida_incluida: ['Consomé'],
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
});

const m = mensajeRelanzarFlujo({ proteinas_dia: [], bebida_incluida: [] });
console.log('--- sección extras del anuncio ---');
console.log(m.split('Extras')[1]?.split('\n').slice(0, 4).join('\n'));
console.log('----------------------------------');

check('anuncia Papas fritas con SU precio ($1.500)', /Papas fritas\s*—\s*\$1\.500/.test(m));
check('anuncia Tostones con SU precio ($3.000)', /Tostones\s*—\s*\$3\.000/.test(m));
check('NO anuncia el fijo "$2.000 c/u" en extras', !/\*Extras\*[^\n]*\$2\.000 c\/u/.test(m));

console.log(`\n=== EXTRAS PRECIO UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
