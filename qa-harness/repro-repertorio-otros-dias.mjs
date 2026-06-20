// Repertorio dinámico (Alberto/Cortex 2026-06-20): con el catálogo cargado, si el
// cliente pide un ítem que el local ofrece OTROS días pero HOY no está, el bot debe
// decir "hoy no tenemos X, pero otros días sí" — NO ofrecerlo como disponible hoy,
// NO agregarlo al pedido, y TAMPOCO decir que no existe. El guard determinista +
// el repertorio en el prompt lo blindan.
//
// Uso: node qa-harness/repro-repertorio-otros-dias.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu({
  day_label: 'Martes de prueba',
  day_code: 'M',
  proteinas_dia: [
    { nombre: 'Pollo asado', disponible: true },
    { nombre: 'Pescado empanizado', disponible: true },
  ], // HOY hay DOS proteínas → al declinar, el bot debe listar AMBAS
  agregados_incluidos: ['arroz', 'puré', 'ensalada'],
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

const history = [
  { role: 'user', content: 'hola' },
  {
    role: 'assistant',
    content:
      '¡Hola! 👋 Bienvenido a El Sazón. Hoy tenemos Pollo asado con arroz, puré o ensalada. Consomé incluido. ¿Querés un menú? 🙂',
  },
];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history,
  userMessage: '¿hoy tienen carne mechada? quiero carne mechada con arroz',
  sesion: 'continua',
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
if (r.pedido) console.log('\n<<PEDIDO>> extraído:\n' + JSON.stringify(r.pedido, null, 2));

const t = r.textoVisible.toLowerCase();

// Ofrece la carne mechada COMO disponible hoy (mal): la confirma/agrega sin declinar.
const ofreceHoy =
  /(anotad|listo|perfecto|te sumo|agregu|le pongo|va con).{0,40}carne mechada/.test(t) ||
  /carne mechada.{0,30}(anotad|lista|va|con arroz)/.test(t);
// Declina bien: "hoy no tenemos carne mechada" (idealmente + "otros días").
const declina = /no (tenemos|hay) (m[áa]s )?carne mechada|carne mechada.{0,20}no (la |lo )?(tenemos|hay)|hoy no.{0,20}carne mechada/.test(t);
// El pedido NO debe incluir carne mechada.
const pedidoConCarne = !!r.pedido && JSON.stringify(r.pedido).toLowerCase().includes('carne mechada');

const bug = (ofreceHoy || pedidoConCarne) && !declina;

// Ajuste Alberto 2026-06-20: al declinar debe LISTAR todas las opciones del día (≥2),
// no una sola. Hoy hay Pollo asado Y Pescado empanizado → ambas deben aparecer.
const listaPollo = /pollo/.test(t);
const listaPescado = /pescado/.test(t);
const listaAmbas = listaPollo && listaPescado;

console.log('\nofreceHoy=' + ofreceHoy + ' declina=' + declina + ' pedidoConCarne=' + pedidoConCarne + ' listaAmbas=' + listaAmbas + ' (pollo=' + listaPollo + ' pescado=' + listaPescado + ')');
if (bug) {
  console.log('❌ BUG (ofrece/agrega carne mechada que HOY no está)');
  process.exit(1);
}
if (!listaAmbas) {
  console.log('⚠️ declina OK pero NO listó todas las opciones del día (ajuste Alberto)');
  process.exit(2);
}
console.log('✅ correcto (declina "hoy no" + lista TODAS las opciones del día; no agrega al pedido)');
process.exit(0);
