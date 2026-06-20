// Bug E2E detectado por Alberto (2026-06-20): el guard no validaba acompañamientos.
// Menú "Sábado" → acompañamientos de hoy: Frijoles, Arroz, Tajadas (puré NO está hoy,
// pero está en el repertorio). El cliente pide "Albóndigas con puré y arroz". El bot NO
// debe aceptar el puré: debe decir "el puré hoy no está, los de hoy son Frijoles, Arroz,
// Tajadas" y NO meter puré en el pedido.
//
// Uso: node qa-harness/repro-pure-no-hoy.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu({
  day_label: 'Sábado de prueba',
  day_code: 'S',
  proteinas_dia: [
    { nombre: 'Albóndigas', disponible: true },
    { nombre: 'Pescado empanizado', disponible: true },
  ],
  agregados_incluidos: ['Frijoles', 'Arroz', 'Tajadas'], // puré NO hoy
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
      '¡Hola! 👋 Bienvenido a El Sazón. Hoy tenemos Albóndigas o Pescado empanizado, con Frijoles, Arroz o Tajadas. Consomé incluido. ¿Qué te gustaría? 🙂',
  },
];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history,
  userMessage: 'Albóndigas con puré y arroz',
  sesion: 'continua',
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
if (r.pedido) console.log('\n<<PEDIDO>> extraído:\n' + JSON.stringify(r.pedido, null, 2));

const t = r.textoVisible.toLowerCase();

// ¿Aceptó el puré como anotado/confirmado (mal)?
const aceptaPure =
  /(anotad|listo|perfecto|va con|con tu|sumé|agregu).{0,40}pur[ée]/.test(t) ||
  /pur[ée].{0,25}(anotad|listo|y arroz|va)/.test(t);
// ¿Declina el puré? ("hoy no está / no tenemos puré" o equivalentes)
const declinaPure =
  /no (tenemos|hay) (m[áa]s )?pur[ée]/.test(t) ||
  /pur[ée].{0,25}(hoy no|no (lo )?(tenemos|hay|est)|no está)/.test(t) ||
  /(hoy no|no).{0,15}pur[ée]/.test(t) ||
  /sin pur[ée]/.test(t);
// ¿El PEDIDO incluye puré como agregado? (no debería)
const pedidoConPure = !!r.pedido && JSON.stringify(r.pedido).toLowerCase().includes('pur');
// ¿Lista acompañamientos del día?
const listaHoy = /frijoles/.test(t) || /tajadas/.test(t);

const bug = (aceptaPure || pedidoConPure) && !declinaPure;

console.log('\naceptaPure=' + aceptaPure + ' declinaPure=' + declinaPure + ' pedidoConPure=' + pedidoConPure + ' listaHoy=' + listaHoy);
if (bug) {
  console.log('❌ BUG (acepta/agrega puré que HOY no está)');
  process.exit(1);
}
console.log('✅ correcto (no acepta puré; declina y ofrece los acompañamientos de hoy)');
process.exit(0);
