// Test UNITARIO (sin LLM): setActiveMenu preserva el `horario` al publicar.
// Bug (gap1 Web N2): setActiveMenu reconstruye el menú desde un whitelist → un `horario` en el
// payload se perdía → al re-publicar el menú, la Web N2 dejaba de cortar pedidos fuera de hora.
// Uso: node qa-harness/test-horario-persist.mjs
import { setActiveMenu } from '../src/active-menu.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

const base = {
  day_label: 'Lunes', day_code: 'L', price_typical: 7000,
  proteinas_dia: [{ nombre: 'Pollo', disponible: true }],
  agregados_incluidos: ['Arroz', 'Puré'],
  bebida_incluida: ['Consomé'],
  platos_especiales: [],
};
const HOR = { dias: { 0: [['12:00', '19:00']], 6: [['12:00', '18:00']] } };

console.log('— Horario válido se PRESERVA —');
let m = setActiveMenu({ ...base, horario: HOR });
check('el menú activo conserva horario', JSON.stringify(m.horario) === JSON.stringify(HOR));

console.log('\n— Sin horario: no aparece (no rompe menús viejos) —');
m = setActiveMenu({ ...base });
check('sin horario en el payload → sin horario en el menú', m.horario === undefined);

console.log('\n— Horario con forma inválida se DESCARTA (no persiste basura) —');
check('dias ausente → descartado', setActiveMenu({ ...base, horario: { foo: 1 } }).horario === undefined);
check('rango mal formado → descartado', setActiveMenu({ ...base, horario: { dias: { 0: [['12', '19']] } } }).horario === undefined);
check('no-objeto → descartado', setActiveMenu({ ...base, horario: 'abierto' }).horario === undefined);

console.log('\n— Regresión: el resto del menú intacto —');
m = setActiveMenu({ ...base, horario: HOR });
check('proteínas OK', m.proteinas_dia[0].nombre === 'Pollo');
check('price_typical OK', m.price_typical === 7000);

console.log(`\n=== HORARIO PERSIST: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
