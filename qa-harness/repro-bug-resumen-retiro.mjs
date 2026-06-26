// Repro del BUG bloqueante (staging, 2026-06-26): en el flujo de RETIRO LOCAL el bot dice
// "Aquí va tu pedido:" pero NO muestra el resumen (ítems + total). Hipótesis: el bot pone
// {{RESUMEN}} sin emitir un <<PEDIDO>> extraíble → handlers no reemplaza → la limpieza borra
// el placeholder → queda "Aquí va tu pedido:" vacío.
//
// Inspeccionamos el TEXTO CRUDO de cada turno (¿tiene {{RESUMEN}}? ¿tiene <<PEDIDO>>?) y el
// textoVisible (lo que vería el cliente). Corre el flujo hasta el resumen del retiro.
import { runBotTurn, CostMeter, MENU_PRUEBA, MENU_FALLBACK } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu(MENU_PRUEBA);
const meter = new CostMeter({ capUSD: 2.0 });
const history = [];
const menu = MENU_FALLBACK;

function tieneResumenVacio(visible) {
  return /aqu[ií] va tu pedido/i.test(visible) && !/total/i.test(visible);
}

async function turno(userMessage, label) {
  const r = await runBotTurn({ menu, history, userMessage, sesion: 'nueva', meter });
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: r.textoVisible });
  const crudo = r.textoCrudo || '';
  console.log(`\n──────── ${label} ────────`);
  console.log('CLIENTE:', userMessage);
  console.log('VISIBLE :', JSON.stringify(r.textoVisible));
  console.log('flags   : {{RESUMEN}} en crudo =', crudo.includes('{{RESUMEN}}'),
              '| <<PEDIDO>> en crudo =', /<<PEDIDO>>/.test(crudo),
              '| pedido extraído =', !!r.pedido,
              '| total =', r.total);
  if (tieneResumenVacio(r.textoVisible)) {
    console.log('🔴 BUG REPRODUCIDO: anuncia el resumen pero NO lista total/ítems.');
  }
  return r;
}

console.log('=== Flujo RETIRO LOCAL hasta el resumen ===');
await turno('hola', 'T1 saludo');
await turno('quiero 2 carne mechada', 'T2 pide platos');
await turno('a la primera arroz y ensalada, a la segunda puré y papas', 'T3 acompañamientos');
await turno('jugo para las dos', 'T4 bebida');
await turno('eso es todo', 'T5 cierra carrito → bot pregunta modalidad');
const r6 = await turno('lo paso a buscar al local', 'T6 RETIRO → acá debe salir el resumen');

console.log('\n=== meter ===', JSON.stringify(meter.summary().byModel));
process.exit(tieneResumenVacio(r6.textoVisible) ? 1 : 0);
