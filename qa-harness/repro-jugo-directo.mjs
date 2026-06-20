// Caso directo (variante del bug del jugo): con SOLO consomé publicado, el cliente
// pregunta explícito "¿tienen jugo?". El bot debe DECLINAR ("hoy no tenemos jugo,
// solo consomé") y NO ofrecerlo como incluido ni como extra. El guard determinista
// de claude.js garantiza esto al 100% aunque el LLM caiga en la ambigüedad.
//
// Uso: node qa-harness/repro-jugo-directo.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu({
  day_label: 'Martes de prueba',
  day_code: 'M',
  proteinas_dia: [{ nombre: 'Pollo asado', disponible: true }],
  agregados_incluidos: ['arroz', 'puré', 'ensalada'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  bebida_incluida: ['Consomé'], // ← SOLO consomé hoy
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
});

const history = [
  { role: 'user', content: 'hola' },
  {
    role: 'assistant',
    content:
      '¡Hola! 👋 Bienvenido a El Sazón. Hoy: Pollo asado con arroz, puré o ensalada. Consomé incluido. ¿Querés un menú? 🙂',
  },
];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history,
  userMessage: '¿tienen jugo? me gustaría un jugo con el pollo',
  sesion: 'continua',
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
if (r.pedido) console.log('\n<<PEDIDO>> extraído:\n' + JSON.stringify(r.pedido, null, 2));

const t = r.textoVisible.toLowerCase();

const ofreceJugo =
  /jugo extra/.test(t) ||
  /un jugo (extra|adicional|aparte|m[áa]s)/.test(t) ||
  /jugo.{0,15}\$?\s?2\.?000/.test(t) ||
  /\$?\s?2\.?000.{0,15}jugo/.test(t) ||
  /jugo \(incluido/.test(t) ||
  /(cambi\w*|reemplaz\w*).{0,20}jugo/.test(t) ||
  /(s[íi],?\s+(tenemos|hay)|claro).{0,15}jugo/.test(t);

const declinaJugo =
  /no (tenemos|hay) (m[áa]s )?jugo/.test(t) ||
  /sin jugo/.test(t) ||
  /(hoy )?solo (hay |tenemos )?(el )?consom/.test(t);

const pedidoConJugo = !!r.pedido && JSON.stringify(r.pedido).toLowerCase().includes('jugo');

const bug = (ofreceJugo || pedidoConJugo) && !declinaJugo;

console.log('\nofreceJugo=' + ofreceJugo + ' declinaJugo=' + declinaJugo + ' pedidoConJugo=' + pedidoConJugo);
console.log(
  bug
    ? '❌ BUG (ofrece/confirma jugo que hoy NO está publicado)'
    : '✅ correcto (declina el jugo; deja solo consomé)'
);
process.exit(bug ? 1 : 0);
