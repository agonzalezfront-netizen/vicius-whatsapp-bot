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
// El especial ahora PREGUNTA antes (acask_si) → luego elige acompañamiento.
r = correr(['prot:3', 'acask_si', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.items?.[0]?.proteina === 'Albacora', 'proteína = Albacora');
check(r.pedido?.total === 11000, `total = $11.000 (9000 + 2000 acompañamiento) (got ${r.pedido?.total})`);
// Especial diciendo "No, seguir" → sin acompañamientos → $9.000.
let rSinAcomp = correr(['prot:3', 'acask_no', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(rSinAcomp.pedido?.total === 9000, `especial sin acompañamientos = $9.000 (got ${rSinAcomp.pedido?.total})`);
check((rSinAcomp.pedido?.items?.[0]?.agregados?.length ?? 0) === 0, 'especial "No, seguir": 0 acompañamientos');

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
// El especial PREGUNTA primero (ajuste QA): paso ACOMP_ASK con botones Sí/No.
let rAsk = procesar(eH, { tipo: 'list', id: 'prot:3' }, MENU); // elige Albacora (especial)
let sAsk = rAsk.salidas[rAsk.salidas.length - 1];
check(rAsk.estado.paso === PASOS.ACOMP_ASK, 'especial → paso ACOMP_ASK (pregunta antes de la lista)');
check((sAsk.buttons || []).some((b) => b.id === 'acask_si') && (sAsk.buttons || []).some((b) => b.id === 'acask_no'), 'especial: botones Sí/No agregar acompañamientos');
check(sAsk.text.includes('cada uno $2.000'), 'especial: la pregunta avisa "cada uno $2.000"');
// "No, seguir" → salta a BEBIDA (sin forzar acompañamientos). (clono: procesar muta el estado)
let rNo = procesar(structuredClone(rAsk.estado), { tipo: 'button', id: 'acask_no' }, MENU);
check(rNo.estado.paso === PASOS.BEBIDA, 'especial "No, seguir" → salta a BEBIDA');
// "Sí, agregar" → recién ahí la lista con "cada uno $2.000".
let rEsp = procesar(structuredClone(rAsk.estado), { tipo: 'button', id: 'acask_si' }, MENU);
let sEsp = rEsp.salidas[rEsp.salidas.length - 1];
check(rEsp.estado.paso === PASOS.ACOMP, 'especial "Sí, agregar" → paso ACOMP');
check(sEsp.text.includes('cada uno $2.000'), `especial tras Sí: regla "cada uno $2.000" (got: "${sEsp.text.split('\\n')[0]}")`);
check(sEsp.text.includes('Llevas 0'), 'especial: arranca en "Llevas 0"');
check((sEsp.sections?.[0]?.title || '').includes('Cada uno'), `especial: sección "Cada uno $2.000" (got: "${sEsp.sections?.[0]?.title}")`);
// Estándar llevas 0: muestra los incluidos gratis, SIN mencionar el costo del extra (ajuste QA: no asustar).
let eStd = estadoInicial();
let rStd = procesar(eStd, { tipo: 'list', id: 'prot:0' }, MENU); // elige Carne Mechada (estándar)
let sStd = rStd.salidas[rStd.salidas.length - 1];
check(rStd.estado.paso === PASOS.ACOMP, 'estándar → directo a ACOMP (sin preguntar, los incluidos son parte del plato)');
check(sStd.text.includes('te quedan 2 gratis'), `estándar llevas 0: "te quedan 2 gratis" (got: "${sStd.text.split('\\n')[0]}")`);
check(!sStd.text.includes('$2.000'), 'estándar llevas 0: NO menciona $2.000 (hay incluidos disponibles)');
check((sStd.sections?.[0]?.title || '').includes('2 incluidos'), 'estándar: sección "2 incluidos gratis"');
// AMBOS listan los acompañamientos disponibles en el texto, antes de la lista interactiva.
check(sStd.text.includes('· Arroz') && sStd.text.includes('· Puré'), 'estándar: lista acompañamientos en el texto (· Arroz, · Puré)');
check(sEsp.text.includes('· Arroz') && sEsp.text.includes('· Tajadas'), 'especial: lista acompañamientos en el texto');
// Estándar al SUPERAR el cupo (llevas 2): recién ahí aparece el costo del siguiente.
let stCupo = estadoInicial();
for (const s of ['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_mas']) {
  const input = { tipo: s.startsWith('prot') || s.startsWith('ac:') ? 'list' : 'button', id: s };
  const rr = procesar(stCupo, input, MENU); stCupo = rr.estado; if (s === 'ac_mas') var sCupo = rr.salidas[rr.salidas.length - 1];
}
check(sCupo.text.includes('Llevas 2') && sCupo.text.includes('$2.000'), `estándar llevas 2: "el siguiente suma $2.000" (got: "${sCupo.text.split('\\n')[0]}")`);

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
// Orden (ajuste UX): especiales AL FINAL (después de extras), no después del plato del día.
check(m.text.indexOf('Especiales') > m.text.indexOf('Extras'), 'especiales van DESPUÉS de extras (al final)');
check(m.text.indexOf('Acompañamientos') < m.text.indexOf('Especiales'), 'acompañamientos antes que especiales');
check(m.text.lastIndexOf('Armemos tu pedido') > m.text.indexOf('Especiales'), 'el cierre queda al final, tras especiales');

console.log('\n=== K) UX: el paso de EXTRAS lista los extras con precio en el texto ===');
// Tras elegir bebida, el mensaje de extras debe listar los extras del menú con su precio (antes de decidir).
let eK = estadoInicial();
let stK = eK, lastK = null;
for (const s of ['prot:0', 'ac:0', 'ac_listo', 'beb:0']) {
  const input = { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s };
  const rr = procesar(stK, input, MENU); stK = rr.estado; lastK = rr.salidas[rr.salidas.length - 1];
}
check(stK.paso === PASOS.EXTRAS, 'tras bebida → paso EXTRAS');
check(lastK.text.includes('Papas fritas') && lastK.text.includes('$2.000'), 'extras: lista "Papas fritas — $2.000" en el texto');
check(lastK.text.includes('Quesillo') && lastK.text.includes('$2.500'), 'extras: lista "Quesillo — $2.500" en el texto');
check((lastK.buttons || []).some((b) => b.id === 'ex_add') && (lastK.buttons || []).some((b) => b.id === 'ex_no'), 'extras: botones Agregar/No seguir intactos');

console.log('\n=== L) Editar pedido (pieza 2 FASE A) ===');
// Pedido estándar con 2 acompañamientos (Arroz, Tajadas) + Consomé, retiro local → hasta el resumen.
const hastaResumen = ['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local'];
// L1: editar acompañamiento Arroz→Puré (ambos incluidos) → total sigue $7.000, agregado cambiado.
r = correr([...hastaResumen, 'conf_editar', 'ep:0', 'ei_acomp', 'eaf:0', 'eat:2', 'conf_si']);
check(r.pedido?.items?.[0]?.agregados?.[0] === 'Puré', `acompañamiento cambiado a Puré (got ${r.pedido?.items?.[0]?.agregados?.[0]})`);
check(r.pedido?.items?.[0]?.agregados?.[1] === 'Tajadas', 'el otro acompañamiento intacto (Tajadas)');
check(r.pedido?.total === 7000, `total sigue $7.000 (incluido→incluido gratis) (got ${r.pedido?.total})`);
// L2: cambiar bebida → quitar la bebida (beb_no).
r = correr([...hastaResumen, 'conf_editar', 'ep:0', 'ei_bebida', 'beb_no', 'conf_si']);
check(r.pedido?.items?.[0]?.bebida === null, 'bebida cambiada a (sin bebida)');
// L3: quitar plato con 2 platos → queda 1.
const dosPlatos = ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_otro', 'prot:1', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local'];
r = correr([...dosPlatos, 'conf_editar', 'ep:0', 'ei_quitar', 'conf_si']);
check(r.pedido?.items?.length === 1, `quitar 1 de 2 platos → queda 1 (got ${r.pedido?.items?.length})`);
// L4: quitar el ÚLTIMO plato → pedido vacío → vuelve a PROTEINA (sin emitir pedido).
let stL = estadoInicial();
for (const s of [...hastaResumen, 'conf_editar', 'ep:0', 'ei_quitar']) {
  const input = typeof s === 'string' ? { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('ep:') ? 'list' : 'button', id: s } : s;
  const rr = procesar(stL, input, MENU); stL = rr.estado;
}
check(stL.paso === PASOS.PROTEINA, `quitar el último plato → vuelve a PROTEINA (got ${stL.paso})`);
// L5: "empezar de nuevo" pide confirmación; "No" vuelve al resumen, "Sí" reinicia.
let stR = estadoInicial();
for (const s of hastaResumen) { const rr = procesar(stR, { tipo: 'button', id: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s }, MENU); stR = rr.estado; }
let rReset = procesar(stR, { tipo: 'button', id: 'conf_reset' }, MENU);
check(rReset.estado.paso === PASOS.RESET_CONFIRM, 'conf_reset → pide confirmación (RESET_CONFIRM)');
check(procesar(structuredClone(rReset.estado), { tipo: 'button', id: 'reset_no' }, MENU).estado.paso === PASOS.CONFIRMAR, '"No, volver" → vuelve al resumen');
check(procesar(structuredClone(rReset.estado), { tipo: 'button', id: 'reset_si' }, MENU).estado.paso === PASOS.PROTEINA, '"Sí, de nuevo" → reinicia (PROTEINA)');
// L6: editar el 3er acompañamiento (pagado) → total se mantiene $9.000 (recálculo coherente por posición).
r = correr(['prot:0', 'ac:0', 'ac_mas', 'ac:1', 'ac_mas', 'ac:2', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0', 'ei_acomp', 'eaf:2', 'eat:3', 'conf_si']);
check(r.pedido?.total === 9000, `editar el 3º (pagado) mantiene $9.000 (got ${r.pedido?.total})`);
check(r.pedido?.items?.[0]?.agregados?.[2] === 'Ensalada mixta', 'el 3er acompañamiento quedó reemplazado');

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK (12 escenarios)');
process.exit(fails ? 1 : 0);
