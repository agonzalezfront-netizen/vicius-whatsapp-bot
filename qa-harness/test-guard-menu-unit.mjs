// Test UNITARIO (determinista, sin LLM) del guard de menú generalizado.
// Valida pedidoItemNoDisponible / menuViolation contra el menú del día:
// ningún ítem confirmado en el <<PEDIDO>> puede estar fuera del menú publicado.
//
// Uso: node qa-harness/test-guard-menu-unit.mjs

const { setActiveMenu } = await import('../src/active-menu.js');
const { pedidoItemNoDisponible, menuViolation, bebidaNoDisponibleOfrecida } =
  await import('../src/claude.js');

setActiveMenu({
  day_label: 'Test', day_code: 'L',
  proteinas_dia: [
    { nombre: 'Carne mechada', disponible: true },
    { nombre: 'Pollo asado', disponible: true },
    { nombre: 'Pescado frito', disponible: false }, // NO disponible hoy
  ],
  agregados_incluidos: ['arroz', 'puré', 'ensalada', 'tajadas'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  bebida_incluida: ['Consomé'], // solo consomé
  platos_especiales: [{ nombre: 'Pabellón criollo', precio: 9000, desc: '' }],
  price_typical: 7000,
  published_at: new Date().toISOString(),
});

let pass = 0, fail = 0;
function check(nombre, cond) {
  if (cond) { pass++; console.log('  ✅ ' + nombre); }
  else { fail++; console.log('  ❌ ' + nombre); }
}
const ped = (items) => ({ items });

console.log('— PEDIDO válido (todo en el menú) → sin violación —');
check('plato + bebida + extra válidos',
  pedidoItemNoDisponible(ped([{ proteina: 'Carne mechada', agregados: ['arroz', 'puré'], bebida: 'consomé', extras: ['papas fritas'] }])) === null);
check('especial válido',
  pedidoItemNoDisponible(ped([{ proteina: 'Pabellón criollo', agregados: [], bebida: 'consomé', extras: [] }])) === null);
check('match parcial proteína ("Pollo" ⊂ "Pollo asado")',
  pedidoItemNoDisponible(ped([{ proteina: 'Pollo', bebida: 'consomé', extras: [] }])) === null);
check('pedido vacío / sin items → null',
  pedidoItemNoDisponible(ped([])) === null && pedidoItemNoDisponible(null) === null);

console.log('\n— PEDIDO con ítem FUERA del menú → violación detectada —');
let v;
v = pedidoItemNoDisponible(ped([{ proteina: 'Lasaña', bebida: 'consomé', extras: [] }]));
check('plato fantasma (Lasaña)', v?.categoria === 'plato' && /lasa/i.test(v.item));
v = pedidoItemNoDisponible(ped([{ proteina: 'Pescado frito', bebida: 'consomé', extras: [] }]));
check('proteína marcada NO disponible hoy (Pescado frito)', v?.categoria === 'plato');
v = pedidoItemNoDisponible(ped([{ proteina: 'Carne mechada', bebida: 'jugo', extras: [] }]));
check('bebida fuera de menú (jugo cuando solo hay consomé)', v?.categoria === 'bebida');
v = pedidoItemNoDisponible(ped([{ proteina: 'Carne mechada', bebida: 'consomé', extras: ['jugo extra'] }]));
check('bebida extra no disponible (jugo extra)', v?.categoria === 'bebida extra');
v = pedidoItemNoDisponible(ped([{ proteina: 'Carne mechada', bebida: 'consomé', extras: ['Tostones al ajillo'] }]));
check('extra pagado fuera de menú (Tostones)', v?.categoria === 'extra');

console.log('\n— Regresión: lo válido NO se marca —');
check('consomé extra SÍ válido (consomé está hoy)',
  pedidoItemNoDisponible(ped([{ proteina: 'Carne mechada', bebida: 'consomé', extras: ['consomé extra'] }])) === null);
check('papas fritas como extra válido',
  pedidoItemNoDisponible(ped([{ proteina: 'Pollo asado', bebida: 'consomé', extras: ['Papas fritas'] }])) === null);

console.log('\n— menuViolation combina texto (bebida) + pedido —');
check('texto ofrece jugo (no disponible) → viol bebida_texto',
  menuViolation('¿Querés agregar un jugo extra a $2.000?', null)?.tipo === 'bebida_texto');
check('texto limpio + pedido válido → null',
  menuViolation('Listo, anotado tu pollo con consomé 🙂\n<<PEDIDO>>{"items":[{"proteina":"Pollo asado","bebida":"consomé","extras":[]}]}<<FIN>>', null) === null);
check('texto limpio + pedido con plato fantasma → viol pedido',
  menuViolation('Listo, anotado 🙂\n<<PEDIDO>>{"items":[{"proteina":"Lasaña","bebida":"consomé","extras":[]}]}<<FIN>>', null)?.tipo === 'pedido');

console.log(`\n=== UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
