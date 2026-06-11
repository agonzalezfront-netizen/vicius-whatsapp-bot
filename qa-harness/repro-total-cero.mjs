// Reproducción del BUG total=$0 en pedido COMPLEJO multi-turno (2026-06-10, 2ª pasada).
// Hipótesis: cuando el <<PEDIDO>> se emite en un mensaje SIN <<CALC>> (el total se
// mostró en un turno anterior), el código cae al placeholder pedido.total=0.
// Driveo el flujo real multi-turno y observo el total del pedido en el ÚLTIMO turno.
//
// Uso: ANTHROPIC_API_KEY=... node qa-harness/repro-total-cero.mjs

import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);

const turns = [
  'hola',
  'voy a pedir para 3 personas: 1) menú de carne mechada con puré y ensalada, consomé. 2) menú de pollo asado con arroz y papas, jugo natural, y agregale papas fritas. 3) un Pabellón criollo con papas fritas, jugo natural',
  'eso es todo',
  'es para delivery a Pudeto 6631, departamento 602',
  'sin ajustes, está bien así',
  'transferencia',
  'sí, confirmo',
];
const VERBOSE = process.env.VERBOSE;

const conv = [];
let last = null;
let i = 0;
for (const userMsg of turns) {
  const sesion = i === 0 ? 'nueva' : 'continua';
  last = await runBotTurn({ menu: MENU_FALLBACK, history: conv.slice(), userMessage: userMsg, sesion });
  conv.push({ role: 'user', content: userMsg });
  conv.push({ role: 'assistant', content: last.textoVisible });
  // marcadores de cada turno: ¿hubo CALC? ¿hubo PEDIDO?
  const tuvoCalc = last.total !== null;
  const tuvoPedido = !!last.pedido;
  console.log(`turno ${i}: CALC=${tuvoCalc ? '$'+last.total : 'NO'} | PEDIDO=${tuvoPedido ? 'SÍ (placeholder total='+last.pedido.total+')' : 'no'}`);
  if (VERBOSE) console.log('   « ' + last.textoVisible.replace(/\n/g, ' ').slice(0, 160));
  // capturar el PRIMER turno que emite PEDIDO (como hace el handler real)
  if (tuvoPedido && !global._pedidoTurn) { global._pedidoTurn = { total: last.total, pedido: last.pedido, turno: i }; }
  i++;
}

console.log('\n--- RESULTADO FINAL ---');
const pt = global._pedidoTurn;
if (pt) {
  // misma lógica que handlers.js:471 (calc.total ?? pedido.total)
  const totalUsado = pt.total !== null ? pt.total : pt.pedido.total;
  console.log(`PEDIDO emitido en turno ${pt.turno} | CALC en ese turno: ${pt.total !== null ? '$'+pt.total : 'NO'} | placeholder pedido.total: ${pt.pedido.total}`);
  console.log('total que se guardaría en la DB:', totalUsado);
  console.log(totalUsado === 0 ? '❌ BUG REPRODUCIDO (total $0)' : '✅ total OK ($' + totalUsado + ')');
  process.exit(totalUsado === 0 ? 1 : 0);
} else {
  console.log('⚠️ no se emitió <<PEDIDO>> en toda la conversación');
  process.exit(2);
}
