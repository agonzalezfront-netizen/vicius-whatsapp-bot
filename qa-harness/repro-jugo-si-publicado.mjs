// Regresión del bug 2026-06-08: cuando el jugo SÍ está publicado hoy, debe
// poder venderse como AGREGADO $2.000 aunque el cliente ya haya elegido consomé.
// El fix del bug 2026-06-15 NO debe romper esto: con jugo en el menú, el jugo
// extra sigue siendo válido.
//
// Uso: node qa-harness/repro-jugo-si-publicado.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

// Menú de HOY: jugo Y consomé disponibles.
setActiveMenu({
  day_label: 'Lunes de prueba',
  day_code: 'L',
  proteinas_dia: [{ nombre: 'Pollo asado', disponible: true }],
  agregados_incluidos: ['arroz', 'puré', 'ensalada', 'tajadas'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  bebida_incluida: ['Jugo natural', 'Consomé'], // ← ambas hoy
  platos_especiales: [],
  price_typical: 7000,
  published_at: new Date().toISOString(),
});

const history = [
  { role: 'user', content: 'hola' },
  {
    role: 'assistant',
    content:
      '¡Hola! 👋 Bienvenido a El Sazón. Hoy: Pollo asado. Acompañamientos: arroz · puré · ensalada · tajadas. Jugo o consomé (elegí 1, gratis). Decime 🙂',
  },
  { role: 'user', content: 'pollo con arroz y ensalada, consomé' },
  {
    role: 'assistant',
    content:
      '¡Anotado! 🙂 Pollo con arroz y ensalada + consomé.\n\n¿Cómo seguimos?\n1️⃣ Agregar otro menú\n2️⃣ Cambiar o agregar algo\n3️⃣ Cerrar el pedido',
  },
];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history,
  userMessage: 'quiero agregar un jugo extra aparte',
  sesion: 'continua',
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
if (r.pedido) console.log('\n<<PEDIDO>> extraído:\n' + JSON.stringify(r.pedido, null, 2));

const t = r.textoVisible.toLowerCase();

// Correcto: ofrece/acepta el jugo extra a $2.000 (NO lo rechaza diciendo "solo con el menú").
const aceptaJugoExtra =
  /\$?\s?2\.?000/.test(t) && /jugo/.test(t);
const rechazaMal =
  /solo (se vende |va )?(con|junto)/.test(t) ||
  /no (tenemos|hay) jugo/.test(t) ||
  /jugo.{0,20}no (se )?(puede|vende)/.test(t);

const ok = aceptaJugoExtra && !rechazaMal;
console.log('\naceptaJugoExtra=' + aceptaJugoExtra + ' rechazaMal=' + rechazaMal);
console.log(
  ok
    ? '✅ correcto (ofrece el jugo extra a $2.000 — el jugo SÍ está publicado hoy)'
    : '❌ REGRESIÓN (con jugo publicado, debería venderlo como extra y no lo hace)'
);
process.exit(ok ? 0 : 1);
