// Reproducción del BUG #2 en condiciones REALES (lección 2026-06-10):
// el test pre-deploy usó historial limpio y pasó; en vivo el historial estaba
// saturado de "comprobante" y el bot respondió "quedo atento al comprobante"
// pese a tener estadoPedido=entregado inyectado.
//
// Acá construyo un historial REALISTA (el pedido completo terminando en
// "comprobante en revisión", que es donde queda la conversación porque el avance
// a entregado pasa por el PANEL, invisible al historial del bot) + estadoPedido
// entregado + "gracias". Debe reproducir el bug ANTES del fix.
//
// Uso: ANTHROPIC_API_KEY=... node qa-harness/repro-bug2.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);

// Historial realista: el pedido se armó, se pidió transferencia, llegó el
// comprobante. La conversación QUEDA ahí (el avance a entregado fue por panel).
const history = [
  { role: 'user', content: 'hola' },
  { role: 'assistant', content: '¡Hola! 👋 Bienvenido a El Sazón. Hoy tenemos carne mechada y pollo asado. ¿Qué te gustaría?' },
  { role: 'user', content: 'un menú de carne mechada con puré y ensalada, consomé, para delivery a Pudeto 6631 depto 602' },
  { role: 'assistant', content: '📋 Tu pedido: Carne mechada con puré y ensalada + consomé. Delivery a Pudeto 6631, depto 602. Total: $8.000. ¿Cómo pagás?' },
  { role: 'user', content: 'transferencia' },
  { role: 'assistant', content: 'Perfecto. Te paso los datos para transferir. Apenas me mandes la foto del comprobante, lo paso a validar con la pareja y te confirmo enseguida. Quedo atento 🙂' },
];
// Nota: el mensaje "recibí tu comprobante" NO está en el historial (el path de la
// imagen retorna sin pushHistory). Por eso el último turno asistente es el de los
// datos de transferencia, que es donde queda "anclada" la conversación al comprobante.

// FIX (replica de handlers.js): inyectar el turno sintético del estado real para
// que la conversación sea coherente. Con FIX_OFF=1 se desactiva para reproducir el bug.
const historyAug = process.env.FIX_OFF
  ? history
  : [...history, { role: 'assistant', content: '¡Tu pedido fue entregado! 🙂 Que lo disfrutes. ¡Gracias por elegir a El Sazón de Carla y César!' }];

const r = await runBotTurn({
  menu: MENU_FALLBACK,
  history: historyAug,
  userMessage: 'gracias',
  sesion: 'continua',
  estadoPedido: { id: 'ped_eccd6f1c79fc', status: 'entregado', total: 8000 },
});

console.log('RESPUESTA DEL BOT:\n' + r.textoVisible);
const t = r.textoVisible.toLowerCase();
const bug = /comprobante|atento|esper(o|amos)|en revisión|transfer/.test(t);
console.log('\n' + (bug ? '❌ BUG REPRODUCIDO (menciona comprobante/espera)' : '✅ correcto (cierra sin mencionar comprobante)'));
process.exit(bug ? 1 : 0);
