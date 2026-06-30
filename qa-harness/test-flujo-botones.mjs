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
  platos_especiales: [{ nombre: 'Albacora', precio: 9000, agregados_incluidos: [], componentes: [{ nombre: 'Tajadas', reemplazable: true }, { nombre: 'Arroz', reemplazable: true }, { nombre: 'Salsa', reemplazable: false }] }],
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
let r = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(!!r.pedido, 'emite pedido al confirmar');
check(r.pedido?.total === 7000, `total = $7.000 (got ${r.pedido?.total})`);
check(r.pedido?.metodo_pago === 'en_local', 'metodo_pago = en_local');
check(r.pedido?.tipo === 'local' && r.pedido?.status === 'en_cocina', 'tipo local + status en_cocina (entra a cocina)');
check(r.pedido?.items?.[0]?.proteina === 'Carne Mechada', 'proteína correcta');
check(r.pedido?.items?.[0]?.agregados.length === 2, '2 acompañamientos');

console.log('\n=== B) R2-5: plato normal cap = 2 gratis → al 2º avanza SOLO a la bebida (NO 3er pagado) ===');
let eB = estadoInicial();
let rB1 = procesar(eB, { tipo: 'list', id: 'prot:0' }, MENU);       // → ACOMP
let rB2 = procesar(rB1.estado, { tipo: 'list', id: 'ac:0' }, MENU);  // 1 acomp → sigue en ACOMP
check(rB2.estado.paso === PASOS.ACOMP, '1 acompañamiento → sigue eligiendo (ACOMP)');
let rB3 = procesar(rB2.estado, { tipo: 'list', id: 'ac:1' }, MENU);  // 2 acomp → auto bebida
check(rB3.estado.paso === PASOS.BEBIDA, '🔴 R2-5: al 2º acompañamiento → pasa DIRECTO a BEBIDA (sin 3er pagado)');
check(rB3.estado.actual.agregados.length === 2, 'exactamente 2 acompañamientos');
// El total del plato normal con 2 acompañamientos es $7.000 (ambos incluidos, ninguno pagado).
r = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.total === 7000, `2 acompañamientos = $7.000 (ninguno pagado) (got ${r.pedido?.total})`);

console.log('\n=== C) Especial (Albacora $9.000): R2-2 bebida PRIMERO, R2-4 paso combinado → +1 = $11.000 ===');
// Nuevo flujo del especial: prot → BEBIDA (incluida) → ESP_AGREGAR (acompañamientos+extras, todo $2.000).
r = correr(['prot:3', 'beb:0', 'ac:0', 'esp_listo', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.items?.[0]?.proteina === 'Albacora', 'proteína = Albacora');
check(r.pedido?.total === 11000, `total = $11.000 (9000 + 2000 acompañamiento combinado) (got ${r.pedido?.total})`);
// Especial sin agregar nada ("No, seguir" = esp_listo) → $9.000.
let rSinAcomp = correr(['prot:3', 'beb:0', 'esp_listo', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(rSinAcomp.pedido?.total === 9000, `especial sin agregados = $9.000 (got ${rSinAcomp.pedido?.total})`);
check((rSinAcomp.pedido?.items?.[0]?.agregados?.length ?? 0) === 0, 'especial "No, seguir": 0 acompañamientos');

console.log('\n=== D) Extra (Papas $2.000) → $9.000 ===');
r = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.total === 9000, `total = $9.000 (7000 + 2000 papas, botón directo) (got ${r.pedido?.total})`);

console.log('\n=== E) Delivery + transferencia: suma $1.000 + status esperando_comprobante (con confirmación de dir) ===');
r = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_delivery', { tipo: 'text', texto: 'Los Aromos 123, casa' }, 'dir_ok', 'pay_transfer', 'conf_si']);
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
r = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_otro', 'prot:1', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check(r.pedido?.items?.length === 2, '2 ítems en el pedido');
check(r.pedido?.total === 14000, `total = $14.000 (2 × $7.000) (got ${r.pedido?.total})`);

console.log('\n=== H) R2-2 + R2-4: especial → BEBIDA primero, luego paso COMBINADO ($2.000 c/u) ===');
let eH = estadoInicial();
let rEspBeb = procesar(eH, { tipo: 'list', id: 'prot:3' }, MENU); // elige Albacora (especial)
let sEspBeb = rEspBeb.salidas[rEspBeb.salidas.length - 1];
check(rEspBeb.estado.paso === PASOS.BEBIDA, '🔴 R2-2: especial → primero BEBIDA (incluida), NO acompañamientos');
check(sEspBeb.tipo === 'buttons' && /bebida/i.test(sEspBeb.text), 'especial: el primer paso es la bebida incluida');
// Tras la bebida → paso combinado ESP_AGREGAR.
let rEspAgg = procesar(rEspBeb.estado, { tipo: 'button', id: 'beb:0' }, MENU);
let sEspAgg = rEspAgg.salidas[rEspAgg.salidas.length - 1];
check(rEspAgg.estado.paso === PASOS.ESP_AGREGAR, '🔴 R2-4: tras la bebida → paso COMBINADO ESP_AGREGAR');
check(sEspAgg.tipo === 'list' && /algo más/i.test(sEspAgg.text) && /2\.000/.test(sEspAgg.text), 'combinado: "¿agregar algo más? ($2.000 c/u)"');
const aggRows = sEspAgg.sections?.[0]?.rows || [];
check(aggRows.some((r) => r.id === 'ac:0') && aggRows.some((r) => /^ex:/.test(r.id)), 'combinado: lista UNIFICADA acompañamientos (ac:) + extras (ex:)');
check(aggRows.some((r) => r.id === 'esp_listo'), 'combinado: salida "Listo" dentro de la lista');
// R2-7: el precio va en la BAJADA de la fila, no en el título.
const filaAc = aggRows.find((r) => r.id === 'ac:0');
check(!/\$/.test(filaAc.title) && /\$2\.000/.test(filaAc.description || ''), 'R2-7: precio en la bajada ("Especial $2.000"), NO en el título');
check(/Especial/.test(filaAc.description || ''), 'R2-7: wording de bajada = "Especial $2.000"');
// Estándar llevas 0: muestra los incluidos gratis, SIN mencionar el costo del extra.
let eStd = estadoInicial();
let rStd = procesar(eStd, { tipo: 'list', id: 'prot:0' }, MENU); // elige Carne Mechada (estándar)
let sStd = rStd.salidas[rStd.salidas.length - 1];
check(rStd.estado.paso === PASOS.ACOMP, 'estándar → directo a ACOMP (los incluidos son parte del plato)');
check(sStd.text.includes('te quedan 2 gratis'), `estándar llevas 0: "te quedan 2 gratis" (got: "${sStd.text.split('\\n')[0]}")`);
check(!sStd.text.includes('$2.000'), 'estándar llevas 0: NO menciona $2.000 (R2-5: no hay 3er pagado)');
check((sStd.sections?.[0]?.title || '').includes('2 incluidos'), 'estándar: sección "2 incluidos gratis"');
check(sStd.text.includes('· Arroz') && sStd.text.includes('· Puré'), 'estándar: lista acompañamientos en el texto (· Arroz, · Puré)');

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

console.log('\n=== K) UX: paso de extras con BOTONES DIRECTOS (sin iteración, item 1) ===');
// 2 extras (≤2) → reply buttons directos: [Papas][Quesillo][No, seguir]. Sin "Agregar extra" → lista.
let eK = estadoInicial();
let stK = eK, lastK = null;
for (const s of ['prot:0', 'ac:0', 'ac_listo', 'beb:0']) {
  const input = { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s };
  const rr = procesar(stK, input, MENU); stK = rr.estado; lastK = rr.salidas[rr.salidas.length - 1];
}
check(stK.paso === PASOS.EXTRAS, 'tras bebida → paso EXTRAS');
check(lastK.tipo === 'buttons', '2 extras → reply buttons directos (sin lista intermedia)');
check((lastK.buttons || []).some((b) => b.id === 'ex:0' && /Papas/.test(b.title)), 'botón directo del extra Papas (id ex:0, nombre sin precio)');
check((lastK.buttons || []).some((b) => b.id === 'ex:1' && /Quesillo/.test(b.title)), 'botón directo del extra Quesillo (id ex:1)');
check((lastK.buttons || []).some((b) => b.id === 'ex_no') && !(lastK.buttons || []).some((b) => b.id === 'ex_add'), '"No, seguir" presente y SIN el viejo "Agregar extra"');
const rK1 = procesar(stK, { tipo: 'button', id: 'ex:0' }, MENU);
check(rK1.estado.actual.extras.includes('Papas fritas'), 'tocar el extra lo selecciona al toque');
// R3-3: los extras son REPETIBLES → tras elegir Papas, el re-render SIGUE ofreciendo Papas (ex:0) y Quesillo (ex:1).
check((rK1.salidas.slice(-1)[0].buttons || []).some((b) => b.id === 'ex:0') && (rK1.salidas.slice(-1)[0].buttons || []).some((b) => b.id === 'ex:1'), 'R3-3: re-render sigue ofreciendo el ya elegido (repetible) + el otro');

console.log('\n=== L) Editar pedido (pieza 2 FASE A) ===');
// Pedido estándar con 2 acompañamientos (Arroz, Tajadas) + Consomé, retiro local → hasta el resumen.
const hastaResumen = ['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local'];
// L1: editar acompañamiento Arroz→Puré (ambos incluidos) → total sigue $7.000, agregado cambiado.
r = correr([...hastaResumen, 'conf_editar', 'ep:0', 'ei_parte', 'epf:a:0', 'eat:2', 'conf_si']);
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
// L6: editar el 2º acompañamiento de un plato normal (Tajadas→Puré, ambos del día) → total sigue $7.000.
r = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0', 'ei_parte', 'epf:a:1', 'eat:2', 'conf_si']);
check(r.pedido?.total === 7000, `editar un acompañamiento del día mantiene $7.000 (got ${r.pedido?.total})`);
check(r.pedido?.items?.[0]?.agregados?.[1] === 'Puré', 'el 2º acompañamiento quedó reemplazado por Puré');

console.log('\n=== M) Sustitución de componentes del especial componible (pieza 2, caso pabellón) ===');
// MENU.Albacora tiene componentes: Tajadas* / Arroz* (reemplazables) / Salsa (no). opcionesComponente =
// acompañamientos [Arroz(0) Tajadas(1) Puré(2) Ensalada mixta(3)] (gratis) + extras [Papas fritas(4,$2.000) Quesillo(5,$2.500)].
const albacoraResumen = ['prot:3', 'beb:0', 'esp_listo', 'mm_seguir', 'mod_local', 'pay_local'];
// M1: sin cambios → total $9.000 (componentes incluidos, costo 0).
r = correr([...albacoraResumen, 'conf_si']);
check(r.pedido?.total === 9000, `especial componible sin cambios = $9.000 (got ${r.pedido?.total})`);
// M2: cambiar Tajadas (comp 0) por Papas fritas (extra $2.000) → $11.000 (incluido→pagado).
r = correr([...albacoraResumen, 'conf_editar', 'ep:0', 'ei_parte', 'epf:c:0', 'ect:4', 'conf_si']);
check(r.pedido?.total === 11000, `componente → extra pagado suma $2.000 → $11.000 (got ${r.pedido?.total})`);
check(r.pedido?.items?.[0]?.componentes?.[0]?.nombre === 'Papas fritas', 'componente 0 reemplazado por Papas fritas');
check(r.pedido?.items?.[0]?.componentes?.[0]?.costo === 2000, 'componente 0 con costo $2.000');
// M3: cambiar Tajadas por Puré (acompañamiento del día, gratis) → sigue $9.000 (incluido→incluido).
r = correr([...albacoraResumen, 'conf_editar', 'ep:0', 'ei_parte', 'epf:c:0', 'ect:2', 'conf_si']);
check(r.pedido?.total === 9000, `componente → acompañamiento del día = gratis → $9.000 (got ${r.pedido?.total})`);
check(r.pedido?.items?.[0]?.componentes?.[0]?.nombre === 'Puré', 'componente 0 reemplazado por Puré (gratis)');
// M4 (H3): el plato del día ofrece "Cambiar algo del plato" (sobre sus acompañamientos), opción unificada.
let stStd = estadoInicial(); let sEi = null;
for (const s of ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0']) {
  const input = { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('ep:') ? 'list' : 'button', id: s };
  const rr = procesar(stStd, input, MENU); stStd = rr.estado; sEi = rr.salidas[rr.salidas.length - 1];
}
check((sEi.sections?.[0]?.rows || []).some((row) => row.id === 'ei_parte') && !(sEi.sections?.[0]?.rows || []).some((row) => row.id === 'ei_comp' || row.id === 'ei_acomp'), 'H3: estándar ofrece "Cambiar algo del plato" (sin las viejas ei_comp/ei_acomp)');
const sParteStd = procesar(stStd, { tipo: 'list', id: 'ei_parte' }, MENU).salidas.slice(-1)[0];
check((sParteStd.sections?.[0]?.rows || []).some((r) => r.id === 'epf:a:0' && /Arroz/.test(r.title)), 'estándar: la parte cambiable es su acompañamiento (epf:a:0 = Arroz)');
// M5 (H3): un componente NO reemplazable (Salsa) NO aparece en la lista de partes cambiables.
let stC = estadoInicial();
for (const s of [...albacoraResumen, 'conf_editar', 'ep:0', 'ei_parte']) {
  const input = { tipo: s.startsWith('prot') || s.startsWith('ep:') ? 'list' : 'button', id: s };
  const rr = procesar(stC, input, MENU); stC = rr.estado;
}
const parteRows = procesar(stC, { tipo: 'list', id: '__rerender__' }, MENU).salidas.slice(-1)[0].sections?.[0]?.rows || [];
check(!parteRows.some((r) => /Salsa/.test(r.title)), 'componente NO reemplazable (Salsa) no aparece en las partes cambiables');
check(parteRows.some((r) => /Tajadas/.test(r.title)) && parteRows.some((r) => /Arroz/.test(r.title)), 'sí aparecen los reemplazables (Tajadas, Arroz)');
// M6: el resumen lista la composición del especial.
const resumenTxt = correr(albacoraResumen).last.text;
check(/viene con: .*Tajadas/.test(resumenTxt), `el resumen muestra "viene con: ...Tajadas" (got: "${resumenTxt.split('\\n').find(l => l.includes('viene con')) || '?'}")`);

console.log('\n=== N) Nivel 2 — pedido fuera de carta (async, FASE B) ===');
// Armar estándar hasta el resumen, editar el plato, pedir algo especial.
let stN = estadoInicial();
for (const s of hastaResumen) { stN = procesar(stN, { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s }, MENU).estado; }
stN = procesar(stN, { tipo: 'button', id: 'conf_editar' }, MENU).estado;
stN = procesar(stN, { tipo: 'list', id: 'ep:0' }, MENU).estado;
stN = procesar(stN, { tipo: 'list', id: 'ei_especial' }, MENU).estado;
check(stN.paso === PASOS.EDIT_ESPECIAL_TXT, 'ei_especial → EDIT_ESPECIAL_TXT');
const rTxt = procesar(stN, { tipo: 'text', texto: 'torta de chocolate' }, MENU);
check(rTxt.crearSolicitud && rTxt.crearSolicitud.descripcion === 'torta de chocolate', 'emite señal crearSolicitud (router hace el POST)');
check(rTxt.crearSolicitud.plato === 'Carne Mechada', 'solicitud etiquetada con el plato (gap 3)');
check(rTxt.estado.solicitud && rTxt.estado.solicitud.status === 'pendiente', 'solicitud draft queda pendiente');
check(rTxt.estado.paso === PASOS.CONFIRMAR, 'vuelve a CONFIRMAR (no congela)');
const sPend = rTxt.salidas[rTxt.salidas.length - 1];
check(/quedó pendiente/.test(sPend.text), 'resumen muestra el pedido especial pendiente (§8)');
check((sPend.buttons || []).some((b) => b.id === 'conf_sin_ajuste') && (sPend.buttons || []).some((b) => b.id === 'mm_otro') && (sPend.buttons || []).some((b) => b.id === 'conf_editar'), 'pending §8: botones = agregar otro / editar / seguir sin el especial');
check(!(sPend.buttons || []).some((b) => b.id === 'conf_esperar') && !/¿Confirmamos\?/.test(sPend.text), 'pending §8: SIN botón "Esperar" y SIN "¿Confirmamos?" (esperar = default en el texto)');
// N2: "seguir sin eso" → confirma sin el ajuste.
const rSin = procesar(structuredClone(rTxt.estado), { tipo: 'button', id: 'conf_sin_ajuste' }, MENU);
check(!!rSin.pedido && rSin.pedido.total === 7000 && !rSin.pedido.ajuste_especial, 'seguir sin eso → pedido $7.000 sin ajuste');
// N3: el router reconcilia (inyecta aplicado) y re-renderiza (cualquier input → reRender del resumen):
// ahora muestra ajuste + costo + botón Confirmar (§8: el Confirmar aparece cuando el local resolvió).
const stApp = structuredClone(rTxt.estado);
stApp.solicitud = { ...stApp.solicitud, status: 'aplicado', costo: 3000, descripcion: 'torta de chocolate' };
const sApp = procesar(stApp, { tipo: 'button', id: '__rerender__' }, MENU).salidas.slice(-1)[0];
check(/torta de chocolate/.test(sApp.text) && /3\.000/.test(sApp.text), 'aplicado: resumen muestra ajuste + costo');
check(/Total: \$10\.000/.test(sApp.text), `aplicado: total $10.000 (7000+3000) (got: "${sApp.text.split('\\n').find(l => l.includes('Total')) || '?'}")`);
check((sApp.buttons || []).some((b) => b.id === 'conf_si'), 'aplicado: vuelve el botón Confirmar');
// N4: confirmar con ajuste aplicado → pedido con ajuste_especial y total sumado.
const rConf = procesar(structuredClone(stApp), { tipo: 'button', id: 'conf_si' }, MENU);
check(rConf.pedido && rConf.pedido.total === 10000, 'confirmar aplicado → total $10.000');
check(rConf.pedido.ajuste_especial && rConf.pedido.ajuste_especial.costo === 3000, 'pedido lleva ajuste_especial ($3.000)');

console.log('\n=== O) §7: "¿otro menú o seguir?" con resumen parcial + Editar ===');
let stO = estadoInicial();
for (const s of ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no']) {
  stO = procesar(stO, { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s }, MENU).estado;
}
check(stO.paso === PASOS.MAS_MENUS, 'tras extras → paso MAS_MENUS');
const sMM = procesar(stO, { tipo: 'button', id: '__noop__' }, MENU).salidas.slice(-1)[0]; // re-render del paso
check(/Total: \$7\.000/.test(sMM.text), '§7: muestra el total PARCIAL en el texto ($7.000)');
check((sMM.buttons || []).some((b) => b.id === 'mm_editar') && (sMM.buttons || []).some((b) => b.id === 'mm_otro') && (sMM.buttons || []).some((b) => b.id === 'mm_seguir'), '§7: botones [Otro menú][Editar][Seguir]');
const rEd = procesar(stO, { tipo: 'button', id: 'mm_editar' }, MENU);
check(rEd.estado.paso === PASOS.EDIT_PICK && rEd.estado.editReturn === PASOS.MAS_MENUS, 'mm_editar → EDIT_PICK con editReturn=MAS_MENUS');
const rEdBack = procesar(rEd.estado, { tipo: 'list', id: 'ep_volver' }, MENU);
check(rEdBack.estado.paso === PASOS.MAS_MENUS, 'volver de la edición → regresa a MAS_MENUS (NO a CONFIRMAR → no saltea pago)');

console.log('\n=== P) item 1: 0 extras → saltar el paso de extras ===');
const MENU0 = { ...MENU, extras_pagados: [] };
let stP = estadoInicial(); let lastP = null;
for (const s of ['prot:0', 'ac:0', 'ac_listo', 'beb:0']) {
  const rr = procesar(stP, { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s }, MENU0);
  stP = rr.estado; lastP = rr.salidas.slice(-1)[0];
}
check(stP.paso === PASOS.MAS_MENUS, '0 extras → tras bebida SALTA el paso de extras y cae en MAS_MENUS');
check(/Total/.test(lastP.text) && (lastP.buttons || []).some((b) => b.id === 'mm_seguir'), '0 extras: muestra directo el resumen de "otro menú o seguir"');

console.log('\n=== Q) B1+H4: especial con agregados_incluidos = composición FIJA (no "elegí 2 gratis") ===');
const MENU_PAB = { ...MENU, platos_especiales: [{ nombre: 'Pabellón criollo', precio: 9000, agregados_incluidos: ['Arroz', 'Tajadas'], componentes: [{ nombre: 'porotos negros', reemplazable: true }] }] };
const rQ = procesar(estadoInicial(), { tipo: 'list', id: 'prot:3' }, MENU_PAB); // índice 3 = el especial (tras 3 proteínas del día)
check(rQ.estado.paso === PASOS.BEBIDA, '🔴 B1+R2-2: especial → BEBIDA primero (composición fija, no "elegí 2 gratis")');
const compQ = (rQ.estado.actual.componentes || []);
const namesQ = compQ.map((c) => c.nombre);
check(namesQ.includes('Arroz') && namesQ.includes('Tajadas') && namesQ.includes('porotos negros'), 'H4: composición = agregados_incluidos (Arroz, Tajadas) + exclusivos (porotos)');
check(compQ.every((c) => c.costo === 0), 'composición va gratis (ya en el precio del especial)');
check(compQ.find((c) => c.nombre === 'Arroz')?.exclusivo === false && compQ.find((c) => c.nombre === 'porotos negros')?.exclusivo === true, 'origen marcado: Arroz=del día (no exclusivo), porotos=exclusivo del plato');
let rQ2 = procesar(rQ.estado, { tipo: 'button', id: 'beb:0' }, MENU_PAB); // bebida → paso combinado
for (const s of ['esp_listo', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']) {
  rQ2 = procesar(rQ2.estado, { tipo: 'button', id: s }, MENU_PAB);
}
check(rQ2.pedido?.total === 9000, `🔴 B1: especial sin extras → total = $9.000 (no suma agregados "gratis") (got ${rQ2.pedido?.total})`);

console.log('\n=== R) H3: "Cambiar algo del plato" — pool unificado día + extras ===');
// Estándar con 2 acompañamientos (Arroz, Tajadas) = $7.000. opcionesComponente = día [Arroz0 Tajadas1 Puré2
// Ensalada3] (gratis) + extras [Papas fritas4 $2.000, Quesillo5 $2.500].
const hastaResR = ['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local'];
let rR = correr([...hastaResR, 'conf_editar', 'ep:0', 'ei_parte', 'epf:a:0', 'eat:4', 'conf_si']); // Arroz → Papas ($2.000)
check(rR.pedido?.total === 9000, `H3: acompañamiento → extra pagado suma $2.000 → $9.000 (got ${rR.pedido?.total})`);
check((rR.pedido?.items?.[0]?.extras || []).includes('Papas fritas') && !(rR.pedido?.items?.[0]?.agregados || []).includes('Arroz'), 'el extra entró a extras y el acompañamiento salió de agregados');
let rR2 = correr([...hastaResR, 'conf_editar', 'ep:0', 'ei_parte', 'epf:a:0', 'eat:2', 'conf_si']); // Arroz → Puré (día, gratis)
check(rR2.pedido?.total === 7000 && (rR2.pedido?.items?.[0]?.agregados || []).includes('Puré'), 'H3: acompañamiento → otro del día = gratis, swap en agregados ($7.000)');

console.log('\n=== S) H1: acompañamientos sin iteración (salida "Listo así" DENTRO de la lista) ===');
let stS = procesar(estadoInicial(), { tipo: 'list', id: 'prot:0' }, MENU).estado;
const sAc = procesar(stS, { tipo: 'list', id: 'ac:0' }, MENU).salidas.slice(-1)[0]; // tras elegir 1
const acRows = sAc.sections?.[0]?.rows || [];
check(sAc.tipo === 'list', 'H1: tras elegir, sigue siendo la LISTA (no botones "+ Otro/Listo" intermedios)');
check(acRows.some((r) => r.id === 'ac_listo') && !acRows.some((r) => r.id === 'ac_mas'), 'H1: "Listo así" (ac_listo) va DENTRO de la lista; sin el "+ Otro" (ac_mas)');

console.log('\n=== H2) bajadas descriptivas en el menú Editar ===');
let stH2 = estadoInicial();
for (const s of ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0']) {
  stH2 = procesar(stH2, { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('ep:') ? 'list' : 'button', id: s }, MENU).estado;
}
const editRows = procesar(stH2, { tipo: 'list', id: '__rr__' }, MENU).salidas.slice(-1)[0].sections?.[0]?.rows || [];
check(editRows.every((r) => r.id === 'ei_volver' || (r.description && r.description.length > 0)), 'H2: las opciones del menú Editar tienen bajada descriptiva');

console.log('\n=== T) R2-6: sustitución DESTACADA + composición consolidada (Tajadas x2) ===');
const MENU_PAB2 = { ...MENU, platos_especiales: [{ nombre: 'Pabellón criollo', precio: 9000, agregados_incluidos: ['Arroz', 'Tajadas'], componentes: [{ nombre: 'porotos negros', reemplazable: true }] }] };
let st6 = estadoInicial();
for (const s of ['prot:3', 'beb:0', 'esp_listo', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0', 'ei_parte']) {
  st6 = procesar(st6, { tipo: 'button', id: s }, MENU_PAB2).estado;
}
// componentes = [Arroz(0), Tajadas(1), porotos(2)] (todos reemplazables). Cambiar porotos (c:2) → Tajadas (ect:1).
let r6 = procesar(st6, { tipo: 'list', id: 'epf:c:2' }, MENU_PAB2);
r6 = procesar(r6.estado, { tipo: 'list', id: 'ect:1' }, MENU_PAB2);
const resumen6 = r6.salidas.slice(-1)[0].text;
check(/✏️ Cambiaste: porotos negros → Tajadas/.test(resumen6), `R2-6: resumen DESTACA "Cambiaste: porotos negros → Tajadas" (got: "${resumen6.split('\n').find((l) => l.includes('Cambiaste')) || '?'}")`);
check(/viene con:[^\n]*Tajadas x2/.test(resumen6), `R2-6: composición CONSOLIDA duplicados (Tajadas x2) (got: "${resumen6.split('\n').find((l) => l.includes('viene con')) || '?'}")`);
// El pedido emitido lleva los cambios (para que el board los muestre — R2-6b).
const ped6 = procesar(r6.estado, { tipo: 'button', id: 'conf_si' }, MENU_PAB2).pedido;
check(ped6?.items?.[0]?.cambios?.some((c) => c.de === 'porotos negros' && c.a === 'Tajadas'), 'R2-6b: el pedido viaja con los cambios (insumo del board)');

console.log('\n=== U) R2-1: menú de inicio — cada ítem con "·" en su línea ===');
const menuTxt = renderMenuCliente(MENU).text;
check(/🥗 \*Acompañamientos\*[^\n]*:\n · /.test(menuTxt), 'R2-1: acompañamientos van con "·" en líneas (no pegados con comas)');
check(/elegí una/.test(menuTxt) && /🥤 \*Bebida incluida\*[^\n]*:\n · /.test(menuTxt), 'R2-1: bebida "(elegí una)" con puntos');
check(/➕ \*Extras\*:\n · /.test(menuTxt), 'R2-1: extras con "·" en líneas');
check(!/Acompañamientos\* \(2 incluidos[^\n]*\): [A-Z]/.test(menuTxt), 'R2-1: NO quedan ítems pegados con comas tras los dos puntos');

console.log('\n=== V) R3-1: menú de inicio con línea en blanco entre secciones ===');
const menuR3 = renderMenuCliente(MENU).text;
check(/· Ensalada mixta\n\n🥤 \*Bebida incluida\*/.test(menuR3) || /\n\n🥤 \*Bebida incluida\*/.test(menuR3), 'R3-1: línea en blanco antes de 🥤 Bebida');
check(/\n\n➕ \*Extras\*/.test(menuR3), 'R3-1: línea en blanco antes de ➕ Extras');
check(!/[^\n]\n🥤 \*Bebida/.test(menuR3) && !/[^\n]\n➕ \*Extras/.test(menuR3), 'R3-1: NO quedan secciones pegadas con un solo \\n');

console.log('\n=== W) R3-2b: la salida ("Listo") va PRIMERO en las listas ===');
// Acompañamientos del día.
const sAcW = procesar(procesar(estadoInicial(), { tipo: 'list', id: 'prot:0' }, MENU).estado, { tipo: 'list', id: '__rr__' }, MENU).salidas.slice(-1)[0];
check(sAcW.sections?.[0]?.rows?.[0]?.id === 'ac_listo', 'R3-2b: en acompañamientos, "Listo así" es la 1ª fila');
// Paso combinado del especial.
let stW = procesar(estadoInicial(), { tipo: 'list', id: 'prot:3' }, MENU).estado;
stW = procesar(stW, { tipo: 'button', id: 'beb:0' }, MENU).estado;
const sEspW = procesar(stW, { tipo: 'list', id: '__rr__' }, MENU).salidas.slice(-1)[0];
check(sEspW.sections?.[0]?.rows?.[0]?.id === 'esp_listo', 'R3-2b: en el paso combinado, "Listo" es la 1ª fila');
check(sEspW.button === 'Ver opciones', 'R3-2a: el botón del List combinado dice "Ver opciones" (no "Agregar")');

console.log('\n=== X) R3-3: cantidades múltiples en pagados → consolida x2 ===');
// Especial + 2× el mismo acompañamiento pagado (ac:0 dos veces) → $9.000 + $4.000 = $13.000, "x2" en resumen.
let rX = correr(['prot:3', 'beb:0', 'ac:0', 'ac:0', 'esp_listo', 'mm_seguir', 'mod_local', 'pay_local']);
const resumenX = renderMenuCliente ? procesar(rX.estado, { tipo: 'button', id: '__rr__' }, MENU).salidas.slice(-1)[0].text : '';
check(/x2/.test(resumenX), `R3-3: el resumen consolida "x2" (got: "${resumenX.split('\n').find((l) => /x2/.test(l)) || '?'}")`);
const pedX = procesar(rX.estado, { tipo: 'button', id: 'conf_si' }, MENU).pedido;
check(pedX?.total === 13000, `R3-3: 2× acompañamiento pagado → $13.000 (got ${pedX?.total})`);
// Extra repetible: en el especial, tomar el mismo extra (ex:0) 2 veces → entra 2 veces.
let rX2 = correr(['prot:3', 'beb:0', 'ex:0', 'ex:0', 'esp_listo', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si']);
check((rX2.pedido?.items?.[0]?.extras || []).filter((e) => e === 'Papas fritas').length === 2, 'R3-3: el extra pagado se puede repetir (2× Papas fritas)');

console.log('\n=== Y) R3-4: Editar → "Agregar algo más" con precio según cupo ===');
// Normal con 1 acompañamiento (cupo libre = 1). Editar → agregar: 1 normal GRATIS + el resto $2.000.
let stY = estadoInicial();
for (const s of ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0']) {
  stY = procesar(stY, { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('ep:') ? 'list' : 'button', id: s }, MENU).estado;
}
const sEditY = procesar(stY, { tipo: 'list', id: '__rr__' }, MENU).salidas.slice(-1)[0];
check((sEditY.sections?.[0]?.rows || []).some((r) => r.id === 'ei_agregar'), 'R3-4: el menú Editar ofrece "Agregar algo más"');
let stYa = procesar(stY, { tipo: 'list', id: 'ei_agregar' }, MENU);
const sAggY = stYa.salidas.slice(-1)[0];
check(stYa.estado.paso === PASOS.EDIT_AGREGAR, 'ei_agregar → EDIT_AGREGAR');
check(sAggY.sections?.[0]?.rows?.[0]?.id === 'ea_listo', 'R3-4: "Listo" primero (R3-2b)');
const filaAcY = (sAggY.sections?.[0]?.rows || []).find((r) => r.id === 'ea_ac:0');
check(filaAcY && /Incluido/.test(filaAcY.description), 'R3-4: con cupo libre, el acompañamiento normal figura "Incluido"');
// Agregar 1 normal (gratis, completa el cupo) → total sigue $7.000.
let rY = correr(['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0', 'ei_agregar', 'ea_ac:2', 'ea_listo', 'conf_si']);
check(rY.pedido?.total === 7000 && (rY.pedido?.items?.[0]?.agregados || []).length === 2, `R3-4: normal con cupo → agregado gratis, $7.000 (got ${rY.pedido?.total})`);
// Agregar un extra pagado en la edición → +$2.000.
let rY2 = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_editar', 'ep:0', 'ei_agregar', 'ea_ex:0', 'ea_listo', 'conf_si']);
check(rY2.pedido?.total === 9000, `R3-4: cupo lleno → extra pagado suma $2.000 → $9.000 (got ${rY2.pedido?.total})`);

console.log('\n=== Z) R3-5: aviso de dirección SOLO en delivery ===');
let rZ = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_delivery', { tipo: 'text', texto: 'Los Aromos 123' }, 'dir_ok', 'pay_efectivo']);
check(/⚠️.*dirección/i.test(rZ.last.text), 'R3-5: delivery → aviso ⚠️ de verificar dirección en el resumen');
let rZ2 = correr(['prot:0', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local']);
check(!/⚠️.*dirección/i.test(rZ2.last.text), 'R3-5: retiro local → SIN aviso de dirección');

console.log('\n=== AA) R4-1: "Agregar otro plato" en Editar → arma plato nuevo y vuelve al resumen ===');
// Pedido normal hasta el resumen final (retiro local, pagado). Editar → Agregar otro plato → armar un 2º.
let stAA = estadoInicial();
for (const s of hastaResumen) { stAA = procesar(stAA, { tipo: s.startsWith('prot') || s.startsWith('ac:') || s.startsWith('beb:') ? 'list' : 'button', id: s }, MENU).estado; }
// en CONFIRMAR → Editar → ver la opción.
let sPickAA = procesar(procesar(stAA, { tipo: 'button', id: 'conf_editar' }, MENU).estado, { tipo: 'list', id: '__rr__' }, MENU).salidas.slice(-1)[0];
check((sPickAA.sections?.[0]?.rows || []).some((r) => r.id === 'ep_nuevo'), 'R4-1: "Editar" ofrece "➕ Agregar otro plato" (ep_nuevo)');
// Flujo completo: conf_editar → ep_nuevo → armar 2º plato (prot:1, 2 acomp, bebida, sin extra) → vuelve al resumen, confirma.
let rAA = correr([...hastaResumen, 'conf_editar', 'ep_nuevo', 'prot:1', 'ac:0', 'ac:1', 'beb:0', 'ex_no', 'conf_si']);
check(rAA.pedido?.items?.length === 2, `R4-1: el pedido quedó con 2 platos (got ${rAA.pedido?.items?.length})`);
check(rAA.pedido?.total === 14000, `R4-1: total = $14.000 (2 × $7.000) sin re-preguntar modalidad (got ${rAA.pedido?.total})`);
check(rAA.pedido?.metodo_pago === 'en_local' && rAA.pedido?.tipo === 'local', 'R4-1: conserva modalidad/pago ya elegidos (no re-pregunta)');

console.log('\n=== AB) R4-2: total acumulado EN VIVO durante el armado ===');
// Tras elegir proteína normal, el paso de acompañamientos muestra el total corriente ($7.000 con el plato base).
let stAB = procesar(estadoInicial(), { tipo: 'list', id: 'prot:0' }, MENU);
check(/💰 Total hasta ahora: \$7\.000/.test(stAB.salidas.slice(-1)[0].text), `R4-2: ACOMP muestra "Total hasta ahora: $7.000" (got: "${stAB.salidas.slice(-1)[0].text.split('\n').find((l) => /Total hasta/.test(l)) || '?'}")`);
// Caso papas (Alberto): especial + 2 papas → el paso combinado muestra el acumulado subiendo.
let stAB2 = correr(['prot:3', 'beb:0', 'ex:0']); // Albacora $9.000 + 1 papas $2.000 = $11.000
const sAggAB = procesar(stAB2.estado, { tipo: 'list', id: '__rr__' }, MENU).salidas.slice(-1)[0];
check(/💰 Total hasta ahora: \$11\.000/.test(sAggAB.text), `R4-2: tras 1 papas el combinado muestra $11.000 (got: "${sAggAB.text.split('\n').find((l) => /Total hasta/.test(l)) || '?'}")`);
// NO es proyección: el total mostrado es el ACUMULADO actual, no "si agregás sería".
check(!/si agregás|sería/i.test(sAggAB.text), 'R4-2: muestra el ACUMULADO, no una proyección');
// En PROTEINA del 1er plato (sin nada aún) NO se muestra total (0).
check(!/Total hasta ahora/.test(procesar(estadoInicial(), { tipo: 'init' }, MENU).salidas.slice(-1)[0].text), 'R4-2: sin items todavía → no muestra total');

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : `TODO OK (${29} escenarios)`);
process.exit(fails ? 1 : 0);
