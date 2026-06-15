// Reproducción del BUG (reportado por Alberto 2026-06-15):
// el menú del día publica SOLO consomé (Alberto quitó el jugo del wizard), pero
// el bot ofrece JUGO igual — como bebida incluida alternativa y/o como extra $2.000.
//
// Regla correcta (Cortex, frente 1, el fix de fondo): la fuente de verdad es lo
// EFECTIVAMENTE listado en el menú del día, NO el título "Jugo o consomé". Si el
// jugo no está publicado hoy, el bot no lo ofrece ni lo cobra; si lo piden,
// responde "hoy no tenemos jugo, solo consomé".
//
// Respeta el bug previo (2026-06-08): si el jugo SÍ estuviera publicado, valdría
// como incluido y como extra $2.000. Acá NO está, así que se rechaza.
//
// Uso: node qa-harness/repro-jugo-no-publicado.mjs
//   FIX_OFF=1 para ver el comportamiento sin fix (debe reproducir el bug).

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

// Menú de HOY: solo consomé como bebida incluida (jugo retirado por Alberto).
setActiveMenu({
  day_label: 'Domingo de prueba',
  day_code: 'D',
  proteinas_dia: [{ nombre: 'Carne mechada', disponible: true }],
  agregados_incluidos: ['arroz', 'puré', 'ensalada', 'tajadas'],
  extras_pagados: [
    { nombre: 'Papas fritas', precio: 2000 },
    { nombre: 'Tostones al ajillo', precio: 2000 },
  ],
  bebida_incluida: ['Consomé'], // ← SOLO consomé. No hay jugo hoy.
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
});

// Historial realista: el cliente ya armó su menú con consomé y el bot preguntó
// "¿cómo seguimos?". Ahí el cliente escribe "Jugo y Consome".
const history = [
  { role: 'user', content: 'hola' },
  {
    role: 'assistant',
    content:
      '¡Hola! 👋 Bienvenido a El Sazón de Carla y César. Hoy tenemos:\n\n🍽️ *MENÚ DEL DÍA — $7.000*\n*Proteínas:* Carne mechada\n*Acompañamientos (elegí 2):* arroz · puré · ensalada · tajadas\n*Consomé* (incluido, gratis)\n\nDecime qué te gustaría 🙂',
  },
  { role: 'user', content: 'carne mechada con arroz y tajadas, consomé' },
  {
    role: 'assistant',
    content:
      '¡Anotado! 🙂 Carne mechada con arroz y tajadas + consomé.\n\n¿Cómo seguimos?\n1️⃣ Agregar otro menú\n2️⃣ Cambiar o agregar algo a tu pedido\n3️⃣ Cerrar el pedido',
  },
];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history,
  userMessage: 'Jugo y Consome',
  sesion: 'continua',
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
if (r.pedido) console.log('\n<<PEDIDO>> extraído:\n' + JSON.stringify(r.pedido, null, 2));

const t = r.textoVisible.toLowerCase();

// ¿El bot OFRECE jugo como ítem disponible (incluido o extra)?
const ofreceJugo =
  /jugo extra/.test(t) ||
  /un jugo (extra|adicional|aparte|m[áa]s)/.test(t) ||
  /jugo.{0,15}\$?\s?2\.?000/.test(t) ||
  /\$?\s?2\.?000.{0,15}jugo/.test(t) ||
  /solo jugo/.test(t) ||
  /jugo \(incluido/.test(t) ||
  /(cambi\w*|reemplaz\w*).{0,20}jugo/.test(t) ||
  /jugo por consom/.test(t);

// ¿El bot DECLINA el jugo correctamente?
const declinaJugo =
  /no (tenemos|hay) jugo/.test(t) ||
  /(hoy )?solo (hay |tenemos )?(el )?consom/.test(t) ||
  /sin jugo/.test(t) ||
  /jugo.{0,20}no (lo )?(tenemos|hay|está)/.test(t);

// ¿El <<PEDIDO>> agrega jugo a extras? (no debería)
const pedidoConJugo = !!r.pedido && JSON.stringify(r.pedido).toLowerCase().includes('jugo');

const bug = (ofreceJugo || pedidoConJugo) && !declinaJugo;

console.log('\nofreceJugo=' + ofreceJugo + ' declinaJugo=' + declinaJugo + ' pedidoConJugo=' + pedidoConJugo);
console.log(
  bug
    ? '❌ BUG REPRODUCIDO (el bot ofrece/cobra jugo que hoy NO está publicado)'
    : '✅ correcto (no ofrece jugo; declina y deja solo consomé)'
);
process.exit(bug ? 1 : 0);
