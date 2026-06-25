// Test del fix de matching de acentos en precios.js (bug de cobro 2026-06-24).
// Verifica que el nombre del especial/extra matchea con o sin tilde contra el menú,
// y que un caso sin tildes sigue igual (no-regresión).
import { calcularItem } from '../src/precios.js';

const menu = {
  price_typical: 7000,
  extras_pagados: [{ nombre: 'Puré', precio: 1500 }, { nombre: 'Papas fritas', precio: 2000 }],
  platos_especiales: [{ nombre: 'Pabellón', precio: 9000, agregados_incluidos: [] }],
};

let ok = true;
function check(desc, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + desc); if (!cond) ok = false; }

// 1) Extra con tilde en el menú, pedido SIN tilde → debe matchear el precio del menú (1500), no el default (2000).
const e1 = calcularItem({ proteina: 'Carne', agregados: ['Arroz', 'Ensalada'], extras: ['pure'] }, menu);
check('extra "pure" (sin tilde) matchea "Puré" → $1500', e1.extras[0].precio === 1500);

// 2) Extra con tilde exacto → sigue matcheando.
const e2 = calcularItem({ proteina: 'Carne', agregados: [], extras: ['Puré'] }, menu);
check('extra "Puré" (con tilde) matchea → $1500', e2.extras[0].precio === 1500);

// 3) Especial con tilde, pedido SIN tilde → base del especial (9000), no estándar (7000).
const e3 = calcularItem({ proteina: 'pabellon', agregados: [] }, menu);
check('proteína "pabellon" (sin tilde) matchea especial "Pabellón" → base $9000 + esEspecial', e3.base === 9000 && e3.esEspecial === true);

// 4) No-regresión: extra sin tildes y fuera del menú → default 2000.
const e4 = calcularItem({ proteina: 'Carne', agregados: [], extras: ['quesillo'] }, menu);
check('extra desconocido → default $2000 (no-regresión)', e4.extras[0].precio === 2000);

// 5) No-regresión: plato estándar normal → base 7000.
const e5 = calcularItem({ proteina: 'Pescado', agregados: ['Arroz', 'Ensalada'] }, menu);
check('plato estándar → base $7000 (no-regresión)', e5.base === 7000 && e5.esEspecial === false);

console.log(ok ? '\n✅ TODOS PASAN' : '\n❌ HAY FALLOS');
process.exit(ok ? 0 : 1);
