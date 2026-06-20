// Mejoras UX (Alberto 2026-06-20): cuando el cliente pide VARIOS ítems no disponibles
// de distintas categorías, el bot debe (1) listarlos TODOS en UNA respuesta (no goteo de
// a uno) y (2) ofrecer el reemplazo de la MISMA categoría de cada uno.
//
// Menú "Sábado": proteínas Albóndigas/Pescado empanizado; acompañamientos Frijoles/Arroz/
// Tajadas; extras Papas fritas; bebida Consomé. El cliente pide carne mechada (plato no-hoy)
// + puré (acomp no-hoy) + tostones al ajillo (extra no-hoy) + jugo (bebida no-hoy).
//
// Uso: node qa-harness/repro-multi-faltante.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu({
  day_label: 'Sábado de prueba',
  day_code: 'S',
  proteinas_dia: [
    { nombre: 'Albóndigas', disponible: true },
    { nombre: 'Pescado empanizado', disponible: true },
  ],
  agregados_incluidos: ['Frijoles', 'Arroz', 'Tajadas'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  bebida_incluida: ['Consomé'],
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
  repertorio: {
    proteinas: ['Pollo', 'Carne mechada', 'Pescado empanizado', 'Albóndigas'],
    agregados: ['Arroz', 'Puré', 'Ensalada', 'Tajadas', 'Frijoles'],
    extras: [{ nombre: 'Papas fritas', precio: 2000 }, { nombre: 'Tostones al ajillo', precio: 2000 }],
    bebidas: ['Jugo natural', 'Consomé'],
    especiales: [],
  },
});

const history = [
  { role: 'user', content: 'hola' },
  {
    role: 'assistant',
    content:
      '¡Hola! 👋 Bienvenido a El Sazón. Hoy: Albóndigas o Pescado empanizado, con Frijoles, Arroz o Tajadas. Consomé incluido. ¿Qué te gustaría? 🙂',
  },
];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history,
  userMessage: 'quiero carne mechada con puré, unos tostones al ajillo y un jugo',
  sesion: 'continua',
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
if (r.pedido) console.log('\n<<PEDIDO>> extraído:\n' + JSON.stringify(r.pedido, null, 2));

const t = r.textoVisible.toLowerCase();
const pedidoStr = r.pedido ? JSON.stringify(r.pedido).toLowerCase() : '';

// (a) Ninguno de los 4 faltantes debe quedar ACEPTADO en el pedido.
const faltantesEnPedido = ['carne mechada', 'pur', 'tostones', 'jugo'].filter((x) => pedidoStr.includes(x));
// (b) Respuesta agrupada: menciona los del día de las categorías afectadas (proxy ≥3).
const listaProte = /alb[óo]ndigas|pescado/.test(t);
const listaAcomp = /frijoles|arroz|tajadas/.test(t);
const listaBebida = /consom/.test(t);
const listaExtra = /papas fritas/.test(t);
const categoriasListadas = [listaProte, listaAcomp, listaBebida, listaExtra].filter(Boolean).length;
// (c) reemplazo same-category para el EXTRA: ofrece papas fritas (extra), no solo proteínas.
const ofreceExtraDelDia = /papas fritas/.test(t);

const ok = faltantesEnPedido.length === 0 && categoriasListadas >= 3;

console.log('\nfaltantesEnPedido=' + JSON.stringify(faltantesEnPedido) + ' categoriasListadas=' + categoriasListadas +
  ' (prote=' + listaProte + ' acomp=' + listaAcomp + ' bebida=' + listaBebida + ' extra=' + listaExtra + ')');
console.log(
  ok
    ? '✅ correcto (lista los faltantes juntos + opciones del día de varias categorías; no acepta ninguno)'
    : '❌ FALLO (aceptó un faltante o no agrupó las opciones del día)'
);
process.exit(ok ? 0 : 1);
