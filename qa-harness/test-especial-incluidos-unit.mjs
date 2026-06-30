// Modelo VIGENTE del especial (B1+H4, 2026-06-30 — reforzado por R2-4/R2-5): el especial tiene composición
// FIJA en `componentes` (costo 0, ya en el precio); cualquier `agregado` que el cliente sume es un EXTRA
// PAGADO ($2.000 c/u). Un componente sustituido por un ítem pagado suma su costo. Verifica calcularItem
// (núcleo determinista). Uso: node qa-harness/test-especial-incluidos-unit.mjs
//
// NOTA: este test reemplaza al viejo "agregados_incluidos como cupo gratis sobre agregados[]" — ese modelo
// fue descartado (la composición ya no se elige como "2 gratis del día", viaja en `componentes`).
import { calcularItem } from '../src/precios.js';

let pass = 0, fail = 0;
const check = (n, c, got) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log(`  ❌ ${n} (obtuvo ${got})`); } };

const menu = {
  price_typical: 7000,
  platos_especiales: [{ nombre: 'Pabellón criollo', precio: 9000, agregados_incluidos: ['Arroz', 'Tajadas'], componentes: [{ nombre: 'porotos negros', reemplazable: true }] }],
  extras_pagados: [{ nombre: 'papas', precio: 2000 }, { nombre: 'tostones', precio: 2000 }],
};
const sub = (item) => calcularItem(item, menu, null).subtotal;

// 1. Especial solo (sin agregados extra) → $9.000.
check('especial solo → $9.000', sub({ proteina: 'Pabellón criollo' }) === 9000, sub({ proteina: 'Pabellón criollo' }));
// 2. Composición fija en `componentes` (costo 0) → NO suma → $9.000.
const comp = [{ nombre: 'Arroz', costo: 0 }, { nombre: 'Tajadas', costo: 0 }, { nombre: 'porotos negros', costo: 0 }];
check('componentes incluidos (costo 0) → $9.000', sub({ proteina: 'Pabellón criollo', componentes: comp }) === 9000, sub({ proteina: 'Pabellón criollo', componentes: comp }));
// 3. Un acompañamiento EXTRA (paso combinado R2-4) = pagado → $11.000.
check('+1 acompañamiento extra ($2.000) → $11.000', sub({ proteina: 'Pabellón criollo', componentes: comp, agregados: ['Arroz'] }) === 11000, sub({ proteina: 'Pabellón criollo', componentes: comp, agregados: ['Arroz'] }));
// 4. DOS extras (acompañamiento + extra) → $13.000.
check('+2 extras → $13.000', sub({ proteina: 'Pabellón criollo', componentes: comp, agregados: ['Arroz'], extras: ['papas'] }) === 13000, sub({ proteina: 'Pabellón criollo', componentes: comp, agregados: ['Arroz'], extras: ['papas'] }));
// 5. Componente sustituido por un pagado (porotos → papas, costo 2000) → suma $2.000 → $11.000.
const compSust = [{ nombre: 'Arroz', costo: 0 }, { nombre: 'Tajadas', costo: 0 }, { nombre: 'papas', costo: 2000 }];
check('componente → pagado ($2.000) → $11.000', sub({ proteina: 'Pabellón criollo', componentes: compSust }) === 11000, sub({ proteina: 'Pabellón criollo', componentes: compSust }));

// 6. No romper el menú NORMAL: $7.000 con 2 incluidos gratis; el 3º (vía edición) suma $2.000 (precios.js
// mantiene el cálculo robusto aunque el FLUJO ya no ofrezca un 3er acompañamiento — R2-5).
check('menú normal: 2 agregados gratis → $7.000', sub({ proteina: 'Pollo', agregados: ['arroz', 'puré'] }) === 7000, sub({ proteina: 'Pollo', agregados: ['arroz', 'puré'] }));
check('menú normal: 3er agregado (robustez) → $9.000', sub({ proteina: 'Pollo', agregados: ['arroz', 'puré', 'papas'] }) === 9000, sub({ proteina: 'Pollo', agregados: ['arroz', 'puré', 'papas'] }));

console.log(`\n=== ESPECIAL (modelo vigente) UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
