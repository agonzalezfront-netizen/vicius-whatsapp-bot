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

// ── Repertorio dinámico (3 casos) ────────────────────────────────────────────
const { enRepertorio, itemRepertorioOfrecidoEnTexto } = await import('../src/claude.js');

setActiveMenu({
  day_label: 'Test rep', day_code: 'M',
  proteinas_dia: [{ nombre: 'Pollo asado', disponible: true }], // HOY solo pollo asado
  agregados_incluidos: ['arroz', 'puré'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  bebida_incluida: ['Consomé'],
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
  repertorio: {
    proteinas: ['Pollo asado', 'Carne mechada', 'Pescado empanizado'],
    agregados: ['arroz', 'puré', 'ensalada', 'tajadas'],
    extras: [{ nombre: 'Papas fritas', precio: 2000 }, { nombre: 'Tostones al ajillo', precio: 2000 }],
    bebidas: ['Jugo natural', 'Consomé'],
    especiales: [{ nombre: 'Pabellón criollo', precio: 9000, desc: '' }],
  },
});

console.log('\n— Repertorio: enRepertorio (existe / no existe) —');
check('Carne mechada está en repertorio', enRepertorio('Carne mechada') === true);
check('Pabellón criollo está en repertorio', enRepertorio('Pabellón criollo') === true);
check('Lasaña NO está en repertorio', enRepertorio('Lasaña') === false);

console.log('\n— Repertorio: oferta en texto de ítem no-activo-hoy → violación —');
let r;
r = itemRepertorioOfrecidoEnTexto('¡Buenísimo! Hoy también tenemos Carne mechada riquísima 🙂');
check('ofrece Carne mechada (en repertorio, no hoy) → viol', r?.item === 'Carne mechada');
r = itemRepertorioOfrecidoEnTexto('¿Le sumo unos Tostones al ajillo a $2.000?');
check('ofrece Tostones (extra de repertorio, no hoy) → viol', /tostones/i.test(r?.item || ''));

console.log('\n— Repertorio: NO violación cuando declina o cuando está activo hoy —');
check('declina correctamente ("hoy no tenemos carne mechada") → null',
  itemRepertorioOfrecidoEnTexto('Uff, hoy no tenemos carne mechada, pero otros días sí 🙂') === null);
check('ofrece Pollo asado (activo hoy) → null',
  itemRepertorioOfrecidoEnTexto('Hoy tenemos Pollo asado con arroz y puré 🙂') === null);
check('menuViolation: ofrecer Carne mechada hoy → tipo item_texto',
  menuViolation('Te recomiendo la Carne mechada de hoy 🙂', null)?.tipo === 'item_texto');

console.log(`\n=== UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
