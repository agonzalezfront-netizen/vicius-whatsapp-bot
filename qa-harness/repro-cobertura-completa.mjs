// Crítica E2E de Alberto (2026-06-20): cobertura incompleta. El bot omitía faltantes que el
// cliente pidió — en especial el CONSOMÉ (bebida en el repertorio, no hoy). El guard normal
// mira la respuesta del bot, no el mensaje del cliente → una omisión no deja rastro. Fix:
// escanear el mensaje del cliente (universo cerrado repertorio+bebidas) y exigir que el bot
// declare CADA ítem no disponible.
//
// Menú: prot Albóndigas/Carne mechada/Pollo; acomp Arroz/Tajadas/Puré/Ensalada; extra
// Tostones; bebida Jugo; especiales Pabellón/Pollo Broster. Repertorio incluye consomé,
// frijoles, papas fritas, sopa de gallina (todos NO hoy).
//
// Uso: node qa-harness/repro-cobertura-completa.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu({
  day_label: 'Sábado de prueba', day_code: 'S',
  proteinas_dia: [
    { nombre: 'Albóndigas', disponible: true },
    { nombre: 'Carne mechada', disponible: true },
    { nombre: 'Pollo', disponible: true },
  ],
  agregados_incluidos: ['Arroz', 'Tajadas', 'Puré', 'Ensalada'],
  extras_pagados: [{ nombre: 'Tostones al ajillo', precio: 2000 }],
  bebida_incluida: ['Jugo natural'], // hoy SOLO jugo → consomé no está
  platos_especiales: [
    { nombre: 'Pabellón criollo', precio: 9000, desc: '' },
    { nombre: 'Pollo Broster', precio: 9000, desc: '' },
  ],
  price_typical: 7000,
  published_at: new Date().toISOString(),
  repertorio: {
    proteinas: ['Pollo', 'Carne mechada', 'Pescado empanizado', 'Albóndigas', 'lomo al vino'],
    agregados: ['Arroz', 'Puré', 'Ensalada', 'Tajadas', 'Frijoles'],
    extras: [{ nombre: 'Papas fritas', precio: 2000 }, { nombre: 'Tostones al ajillo', precio: 2000 }],
    bebidas: ['Jugo natural', 'Consomé'],
    especiales: [
      { nombre: 'Pabellón criollo', precio: 9000, desc: '' },
      { nombre: 'Pollo Broster', precio: 9000, desc: '' },
      { nombre: 'Sopa de gallina', precio: 8000, desc: '' },
    ],
  },
});

const history = [
  { role: 'user', content: 'hola' },
  { role: 'assistant', content: '¡Hola! 👋 Hoy: Albóndigas, Carne mechada o Pollo. ¿Qué te gustaría? 🙂' },
];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history,
  userMessage: 'albóndigas con puré, frijoles, papas fritas, consomé y jugo, y una sopa de gallina',
  sesion: 'continua',
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
if (r.pedido) console.log('\n<<PEDIDO>> extraído:\n' + JSON.stringify(r.pedido, null, 2));

const t = r.textoVisible.toLowerCase();
const pedidoStr = r.pedido ? JSON.stringify(r.pedido).toLowerCase() : '';

// (1) Cobertura: el bot DEBE declarar consomé (omisión que antes se comía), frijoles,
//     papas fritas y sopa de gallina. Cada uno mencionado = cubierto.
const cubre = {
  consome: /consom/.test(t),
  frijoles: /frijol/.test(t),
  papas: /papas/.test(t),
  sopa: /sopa/.test(t),
};
const nCubre = Object.values(cubre).filter(Boolean).length;
// (2) ninguno de los faltantes aceptado en el pedido
const faltantesEnPedido = ['frijol', 'papas', 'consom', 'sopa de gallina'].filter((x) => pedidoStr.includes(x));

// El consomé (omisión del repertorio) es la prueba clave del fix → obligatorio.
const cubreConsome = cubre.consome;
const ok = cubreConsome && nCubre >= 3 && faltantesEnPedido.length === 0;

console.log('\ncubre=' + JSON.stringify(cubre) + ' nCubre=' + nCubre + ' faltantesEnPedido=' + JSON.stringify(faltantesEnPedido));
console.log(
  ok
    ? '✅ correcto (declara consomé + ≥3 faltantes; no acepta ninguno)'
    : '❌ FALLO (omitió consomé u otros faltantes, o aceptó uno)'
);
process.exit(ok ? 0 : 1);
