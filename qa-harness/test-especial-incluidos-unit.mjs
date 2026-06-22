// Feature 2026-06-22: platos especiales con agregados INCLUIDOS configurables (cupo propio).
// Reglas: cambiar/quitar un incluido = gratis; añadir más allá del cupo = $2.000 c/u.
// Verifica calcularItem (núcleo determinista). Uso: node qa-harness/test-especial-incluidos-unit.mjs
import { calcularItem } from '../src/precios.js';

let pass = 0, fail = 0;
const check = (n, c, got) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log(`  ❌ ${n} (obtuvo ${got})`); } };

// Especial $9.000 con 2 incluidos (puré + ensalada).
const menu = {
  price_typical: 7000,
  platos_especiales: [{ nombre: 'Pabellón criollo', precio: 9000, agregados_incluidos: ['puré', 'ensalada'] }],
  extras_pagados: [],
};
const sub = (item) => calcularItem(item, menu, null).subtotal;

// 1. Pedirlo tal cual (sus 2 incluidos) → $9.000.
check('tal cual (puré+ensalada) → $9.000', sub({ proteina: 'Pabellón criollo', agregados: ['puré', 'ensalada'] }) === 9000, sub({ proteina: 'Pabellón criollo', agregados: ['puré', 'ensalada'] }));
// 2. Cambiar puré→papas (misma cantidad) → $9.000.
check('cambiar puré→papas → $9.000', sub({ proteina: 'Pabellón criollo', agregados: ['papas', 'ensalada'] }) === 9000, sub({ proteina: 'Pabellón criollo', agregados: ['papas', 'ensalada'] }));
// 3. Quitar ensalada (menos) → $9.000 (no descuenta).
check('quitar ensalada → $9.000 (no descuenta)', sub({ proteina: 'Pabellón criollo', agregados: ['puré'] }) === 9000, sub({ proteina: 'Pabellón criollo', agregados: ['puré'] }));
// 4. Añadir un 3er agregado → $9.000 + $2.000 = $11.000.
check('añadir 3ro → $11.000', sub({ proteina: 'Pabellón criollo', agregados: ['puré', 'ensalada', 'papas'] }) === 11000, sub({ proteina: 'Pabellón criollo', agregados: ['puré', 'ensalada', 'papas'] }));
// 4b. Añadir DOS de más → $9.000 + $4.000 = $13.000.
check('añadir 2 de más → $13.000', sub({ proteina: 'Pabellón criollo', agregados: ['puré', 'ensalada', 'papas', 'tostones'] }) === 13000, sub({ proteina: 'Pabellón criollo', agregados: ['puré', 'ensalada', 'papas', 'tostones'] }));

// 5. Retrocompat: especial SIN agregados_incluidos → cupo 0, todo agregado paga (como hoy).
const menuViejo = { price_typical: 7000, platos_especiales: [{ nombre: 'Albacora', precio: 9000 }], extras_pagados: [] };
check('retrocompat (sin incluidos): 1 agregado paga → $11.000',
  calcularItem({ proteina: 'Albacora', agregados: ['puré'] }, menuViejo, null).subtotal === 11000,
  calcularItem({ proteina: 'Albacora', agregados: ['puré'] }, menuViejo, null).subtotal);
check('retrocompat: especial solo (sin agregados) → $9.000',
  calcularItem({ proteina: 'Albacora', agregados: [] }, menuViejo, null).subtotal === 9000,
  calcularItem({ proteina: 'Albacora', agregados: [] }, menuViejo, null).subtotal);

// 6. No romper el menú normal: $7.000 con 2 incluidos gratis + 3º a $2.000.
check('menú normal: 2 agregados gratis → $7.000', sub({ proteina: 'Pollo', agregados: ['arroz', 'puré'] }) === 7000, sub({ proteina: 'Pollo', agregados: ['arroz', 'puré'] }));
check('menú normal: 3er agregado → $9.000', sub({ proteina: 'Pollo', agregados: ['arroz', 'puré', 'papas'] }) === 9000, sub({ proteina: 'Pollo', agregados: ['arroz', 'puré', 'papas'] }));

console.log(`\n=== ESPECIAL INCLUIDOS UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
