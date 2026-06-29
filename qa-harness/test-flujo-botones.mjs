// Tests DETERMINISTAS del tier básico (flujo-botones.js) — SIN LLM, SIN red → gratis e instantáneo.
// Cubre: flujo completo retiro/delivery, cálculo de total, multi-select de acompañamientos (2 gratis +
// 3º $2.000), especial, extras, idempotencia ante taps fuera de orden, y emisión del pedido final.
import { procesar, estadoInicial, renderMenuCliente, PASOS } from '../src/flujo-botones.js';

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

console.log('\n=== E) Delivery + transferencia: suma $1.000 + status esperando_comprobante (con confirmación de dir) ===');
r = correr(['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_delivery', { tipo: 'text', texto: 'Los Aromos 123, casa' }, 'dir_ok', 'pay_transfer', 'conf_si']);
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

console.log('\n=== H) BUG4: el especial avisa el costo del acompañamiento DESDE EL PRIMERO (cupo 0) ===');
// Al elegir el especial (prot:3) el render de acompañamientos debe avisar que cada uno suma $2.000
// (NO debe tratarse como "2 incluidos gratis" del menú del día).
let eH = estadoInicial();
let rEsp = procesar(eH, { tipo: 'list', id: 'prot:3' }, MENU); // elige Albacora (especial)
let sEsp = rEsp.salidas[rEsp.salidas.length - 1];
check(sEsp.text.includes('suma $2.000'), `especial: avisa "suma $2.000" desde "Llevas 0" (got: "${sEsp.text}")`);
check(sEsp.text.includes('Llevas 0'), 'especial: arranca en "Llevas 0"');
check((sEsp.sections?.[0]?.title || '').includes('Cada uno'), `especial: sección "Cada uno $2.000" (got: "${sEsp.sections?.[0]?.title}")`);
// Y el estándar NO debe avisar costo en el primero (mantiene "2 incluidos").
let eStd = estadoInicial();
let rStd = procesar(eStd, { tipo: 'list', id: 'prot:0' }, MENU); // elige Carne Mechada (estándar)
let sStd = rStd.salidas[rStd.salidas.length - 1];
check(!sStd.text.includes('suma'), 'estándar: NO avisa costo en el 1º (2 incluidos)');
check((sStd.sections?.[0]?.title || '').includes('2 incluidos'), 'estándar: sección "2 incluidos · extra $2.000"');

console.log('\n=== I) UX-B: confirmar dirección — paso intermedio antes de pago ===');
// Tras escribir la dirección, NO debe ir directo a pago: debe pedir confirmación.
let eI = estadoInicial();
let seqDir = ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_delivery', { tipo: 'text', texto: 'San Martín 45 depto 302' }];
let stI = eI, lastI = null;
for (const s of seqDir) {
  const input = typeof s === 'string' ? { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s } : s;
  const rr = procesar(stI, input, MENU); stI = rr.estado; lastI = rr.salidas[rr.salidas.length - 1];
}
check(stI.paso === PASOS.CONFIRMA_DIR, `tras dirección → paso CONFIRMA_DIR (got ${stI.paso})`);
check(lastI.text.includes('San Martín 45 depto 302'), 'confirma mostrando la dirección anotada');
check(lastI.text.toLowerCase().includes('depto'), 'recuerda incluir el número de depto');
check((lastI.buttons || []).some((b) => b.id === 'dir_ok') && (lastI.buttons || []).some((b) => b.id === 'dir_fix'), 'botones Confirmar/Corregir');
// Corregir → vuelve a pedir dirección; nueva dir → re-confirma; confirmar → pago.
let rFix = procesar(stI, { tipo: 'button', id: 'dir_fix' }, MENU);
check(rFix.estado.paso === PASOS.DIRECCION, 'corregir → vuelve a DIRECCION');
let rRe = procesar(rFix.estado, { tipo: 'text', texto: 'Av Siempre Viva 742' }, MENU);
check(rRe.estado.paso === PASOS.CONFIRMA_DIR && rRe.estado.direccion === 'Av Siempre Viva 742', 're-confirma la nueva dirección');
let rOk = procesar(rRe.estado, { tipo: 'button', id: 'dir_ok' }, MENU);
check(rOk.estado.paso === PASOS.PAGO, 'confirmar → avanza a PAGO');
// Confirmar por TEXTO también funciona (match-texto).
let rOkTxt = procesar(rRe.estado, { tipo: 'text', texto: 'sí, correcta' }, MENU);
check(rOkTxt.estado.paso === PASOS.PAGO, 'confirmar por texto ("sí, correcta") → PAGO');

console.log('\n=== J) UX-A: render del menú cara-cliente (sin instrucciones internas) ===');
const m = renderMenuCliente(MENU);
check(!!m && m.tipo === 'text', 'renderMenuCliente devuelve texto');
check(m.text.includes('Carne Mechada') && m.text.includes('Albacora'), 'lista proteínas del día + especiales');
check(m.text.includes('$9.000'), 'muestra precio del especial');
check(m.text.includes('Papas fritas') && m.text.includes('$2.000'), 'lista extras con precio');
check(!/REGLA PARA EL BOT|🚨|Ignor[áa] el menú/.test(m.text), 'NO filtra instrucciones internas del prompt LLM');
check(renderMenuCliente(null) === null, 'sin menú → null (no rompe el saludo)');

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK (10 escenarios)');
process.exit(fails ? 1 : 0);
