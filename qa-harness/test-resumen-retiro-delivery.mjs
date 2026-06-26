// Cobertura conductual del bug del resumen (staging 2026-06-26): tras elegir modalidad, el bot
// DEBE mostrar el resumen con ítems + Total — en RETIRO y en DELIVERY. El guard determinista de
// claude.js (regenera si {{RESUMEN}} sin <<PEDIDO>>) garantiza la invariante aunque el LLM olvide
// el bloque en el primer intento. Si el resumen sale vacío ("Aquí va tu pedido:" sin Total) → FALLA.
import { runBotTurn, CostMeter, MENU_FALLBACK, MENU_PRUEBA } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');

setActiveMenu(MENU_PRUEBA);
const meter = new CostMeter({ capUSD: 3.0 });

function resumenOk(visible) {
  // Anuncia el resumen Y muestra el Total (señal de que el desglose se armó).
  return /aqu[ií] va tu pedido/i.test(visible) && /total:\s*\$/i.test(visible);
}

async function correrFlujo(modalidadMsg, etiqueta) {
  const history = [];
  const turnos = [
    'hola',
    'quiero 2 carne mechada',
    'a la primera arroz y ensalada, a la segunda puré y papas',
    'jugo para las dos',
    'eso es todo',
    modalidadMsg, // dispara el resumen
  ];
  let last;
  for (const t of turnos) {
    last = await runBotTurn({ menu: MENU_FALLBACK, history, userMessage: t, sesion: 'nueva', meter });
    history.push({ role: 'user', content: t });
    history.push({ role: 'assistant', content: last.textoVisible });
  }
  const ok = resumenOk(last.textoVisible);
  console.log(`\n[${etiqueta}] resumen ${ok ? 'OK ✓' : 'VACÍO ✗'} | total=${last.total} | pedido=${!!last.pedido}`);
  if (!ok) console.log('  VISIBLE:', JSON.stringify(last.textoVisible));
  return ok;
}

console.log('=== Cobertura: el resumen debe aparecer en retiro Y delivery ===');
const retiro = await correrFlujo('lo paso a buscar al local', 'RETIRO');
const delivery = await correrFlujo('es delivery, a Los Aromos 123, casa', 'DELIVERY');

console.log('\n=== meter ===', JSON.stringify(meter.summary().byModel));
const fail = !retiro || !delivery;
console.log(fail ? '\n🔴 FALLA: el resumen no apareció en algún flujo' : '\n✅ TODO OK: resumen presente en ambos');
process.exit(fail ? 1 : 0);
