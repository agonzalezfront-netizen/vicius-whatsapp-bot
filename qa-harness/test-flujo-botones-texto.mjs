// Tests del MATCH DE TEXTO (mejora 2026-06-28) — el cliente ESCRIBE el nombre en vez de tocar. Sin IA, sin red.
import { procesar, estadoInicial, matchTexto, PASOS } from '../src/flujo-botones.js';

const MENU = {
  price_typical: 7000,
  proteinas_dia: [{ nombre: 'Carne Mechada', disponible: true }, { nombre: 'Pescado Frito', disponible: true }],
  platos_especiales: [{ nombre: 'Albacora', precio: 9000, agregados_incluidos: [] }],
  agregados_incluidos: ['Arroz', 'Puré', 'Ensalada mixta'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  bebida_incluida: ['Consomé'],
};
let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

console.log('=== A) matchTexto por paso ===');
check(matchTexto(PASOS.PROTEINA, 'carne mechada', MENU) === 'prot:0', '"carne mechada" → prot:0');
check(matchTexto(PASOS.PROTEINA, 'PESCADO', MENU) === 'prot:1', '"PESCADO" (mayús/parcial) → prot:1');
check(matchTexto(PASOS.PROTEINA, 'albacora', MENU) === 'prot:2', '"albacora" (especial) → prot:2');
check(matchTexto(PASOS.ACOMP, 'pure', MENU) === 'ac:1', '"pure" (sin tilde) → ac:1');
check(matchTexto(PASOS.ACOMP, 'listo', MENU) === 'ac_listo', '"listo" → ac_listo');
check(matchTexto(PASOS.BEBIDA, 'sin bebida', MENU) === 'beb_no', '"sin bebida" → beb_no');
check(matchTexto(PASOS.MODALIDAD, 'lo paso a buscar', MENU) === 'mod_local', '"lo paso a buscar" → mod_local');
check(matchTexto(PASOS.MODALIDAD, 'delivery', MENU) === 'mod_delivery', '"delivery" → mod_delivery');
check(matchTexto(PASOS.PAGO, 'transferencia', MENU) === 'pay_transfer', '"transferencia" → pay_transfer');
check(matchTexto(PASOS.CONFIRMAR, 'sí confirmo', MENU) === 'conf_si', '"sí confirmo" → conf_si');
check(matchTexto(PASOS.PROTEINA, 'pizza', MENU) === null, '"pizza" (no existe) → null');

console.log('\n=== B) Flujo COMPLETO escribiendo (sin tocar botones) → pedido $7.000 ===');
let e = estadoInicial();
let pedido = null;
const txts = ['carne mechada', 'arroz', 'otro', 'ensalada mixta', 'listo', 'sin bebida', 'no', 'seguir', 'retiro', 'en el local', 'confirmo'];
for (const tx of txts) { const r = procesar(e, { tipo: 'text', texto: tx }, MENU); e = r.estado; if (r.pedido) pedido = r.pedido; }
check(!!pedido, 'emite pedido escribiendo todo');
check(pedido?.total === 7000, `total $7.000 (got ${pedido?.total})`);
check(pedido?.items?.[0]?.agregados.length === 2, '2 acompañamientos (arroz + ensalada)');
check(pedido?.metodo_pago === 'en_local', 'pago en_local');

console.log('\n=== C) Texto no reconocido 2× → escalar ===');
e = estadoInicial();
const r1 = procesar(e, { tipo: 'text', texto: 'xyzqwe' }, MENU);
check(!r1.escalar && r1.estado.intentos === 1, '1er fallo: re-render, intentos=1, no escala');
const r2 = procesar(r1.estado, { tipo: 'text', texto: 'asdfgh' }, MENU);
check(r2.escalar === true, '2º fallo seguido → escalar=true');
check(r2.estado.intentos === 0, 'intentos se resetea tras escalar');
// match exitoso resetea intentos
const r3 = procesar(r1.estado, { tipo: 'text', texto: 'carne mechada' }, MENU);
check(r3.estado.intentos === 0 && r3.estado.paso === PASOS.ACOMP, 'match exitoso tras 1 fallo → resetea + avanza');

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK');
process.exit(fails ? 1 : 0);
