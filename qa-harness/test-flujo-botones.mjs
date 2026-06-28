// Tests DETERMINISTAS del tier básico (flujo-botones.js) — SIN LLM, SIN red → gratis e instantáneo.
// Cubre: flujo completo retiro/delivery, cálculo de total, multi-select de acompañamientos (2 gratis +
// 3º $2.000), especial, extras, idempotencia ante taps fuera de orden, y emisión del pedido final.
import { procesar, estadoInicial, PASOS } from '../src/flujo-botones.js';

const MENU = {
  price_typical: 7000,
  proteinas_dia: [
    { nombre: 'Carne Mechada', disponible: true },
    { nombre: 'Pescado Frito', disponible: true },
    { nombre: 'Pulpa al Vino', disponible: true },
  ],
  platos_especiales: [{ nombre: 'Albacora', precio: 9000, agregados_incluidos: [] }],
  agregados_incluidos: ['Arroz', 'Tajadas', 'Puré', 'Ensalada mixta'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }, { nombre: 'Quesillo', precio: 2500 }],
  bebida_incluida: ['Consomé'],
};

let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

// Corre una secuencia de inputs (ids string, o {texto} para libre) desde estado inicial.
function correr(seq) {
  let estado = estadoInicial();
  let last = null, pedido = null;
  for (const step of seq) {
    const input = typeof step === 'string' ? { tipo: step.startsWith('prot') || step.startsWith('ac:') || step.startsWith('ex:') || step.startsWith('beb:') ? 'list' : 'button', id: step } : step;
    const r = procesar(estado, input, MENU);
    estado = r.estado; last = r.salidas[r.salidas.length - 1]; if (r.pedido) pedido = r.pedido;
  }
  return { estado, last, pedido };
}

console.log('=== A) Flujo retiro estándar: 2 acompañamientos incluidos → $7.000 ===');
let r = correr(['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(!!r.pedido, 'emite pedido al confirmar');
check(r.pedido?.total === 7000, `total = $7.000 (got ${r.pedido?.total})`);
check(r.pedido?.metodo_pago === 'en_local', 'metodo_pago = en_local');
check(r.pedido?.tipo === 'local' && r.pedido?.status === 'en_cocina', 'tipo local + status en_cocina (entra a cocina)');
check(r.pedido?.items?.[0]?.proteina === 'Carne Mechada', 'proteína correcta');
check(r.pedido?.items?.[0]?.agregados.length === 2, '2 acompañamientos');

console.log('\n=== B) 3er acompañamiento suma $2.000 → $9.000 ===');
r = correr(['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_mas', 'ac:2', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.total === 9000, `total = $9.000 (got ${r.pedido?.total})`);

console.log('\n=== C) Especial (Albacora $9.000) + 1 acompañamiento ($2.000, sin cupo gratis) → $11.000 ===');
r = correr(['prot:3', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.items?.[0]?.proteina === 'Albacora', 'proteína = Albacora');
check(r.pedido?.total === 11000, `total = $11.000 (9000 + 2000 acompañamiento) (got ${r.pedido?.total})`);

console.log('\n=== D) Extra (Papas $2.000) → $9.000 ===');
r = correr(['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_listo', 'beb:0', 'ex_add', 'ex:0', 'ex_listo', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.total === 9000, `total = $9.000 (7000 + 2000 papas) (got ${r.pedido?.total})`);

console.log('\n=== E) Delivery + transferencia: suma $1.000 + status esperando_comprobante ===');
r = correr(['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_delivery', { tipo: 'text', texto: 'Los Aromos 123, casa' }, 'pay_transfer', 'conf_si']);
check(r.pedido?.tipo === 'delivery', 'tipo delivery');
check(r.pedido?.direccion === 'Los Aromos 123, casa', 'dirección capturada (texto libre)');
check(r.pedido?.total === 8000, `total = $8.000 (7000 + 1000 delivery) (got ${r.pedido?.total})`);
check(r.pedido?.status === 'esperando_comprobante', 'transferencia → esperando_comprobante');

console.log('\n=== F) Idempotencia: tap fuera de orden NO avanza ===');
let e = estadoInicial();
let r1 = procesar(e, { tipo: 'list', id: 'ac:0' }, MENU); // en PROTEINA, mando un id de ACOMP
check(r1.estado.paso === PASOS.PROTEINA, 'id de otro paso ignorado → sigue en PROTEINA');
check(!r1.pedido, 'no emite pedido');
let r2 = procesar(r1.estado, { tipo: 'button', id: 'conf_si' }, MENU); // confirmar sin pedido
check(r2.estado.paso === PASOS.PROTEINA, 'conf_si en PROTEINA ignorado');

console.log('\n=== G) Multi-menú: 2 menús → suma ambos ===');
r = correr(['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_listo', 'beb:0', 'ex_no', 'mm_otro', 'prot:1', 'ac:0', 'ac_mas', 'ac:1', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.items?.length === 2, '2 ítems en el pedido');
check(r.pedido?.total === 14000, `total = $14.000 (2 × $7.000) (got ${r.pedido?.total})`);

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK (7 escenarios)');
process.exit(fails ? 1 : 0);
