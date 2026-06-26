// Stress del TURNO exacto del bug (staging 2026-06-26): historia primada hasta "¿delivery o
// retiro?", y se manda la elección de retiro N veces. Cada vez el bot debe mostrar el resumen
// con Total. Como el LLM es no-determinista, repetir aumenta la chance de pescar un primer
// intento SIN <<PEDIDO>> → ahí debe entrar el guard de regeneración de claude.js y rescatarlo.
// Invariante dura: NUNCA debe quedar "Aquí va tu pedido:" sin Total.
import { runBotTurn, CostMeter, MENU_FALLBACK, MENU_PRUEBA } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);

const N = parseInt(process.argv[2] ?? '8', 10);
const meter = new CostMeter({ capUSD: 4.0 });

const HISTORY_BASE = [
  { role: 'user', content: 'hola' },
  { role: 'assistant', content: 'Este es el menú de hoy. ¿Qué te gustaría? 🙂' },
  { role: 'user', content: 'quiero 2 carne mechada' },
  { role: 'assistant', content: 'Perfecto. Para cada una, ¿qué 2 acompañamientos y jugo o consomé?' },
  { role: 'user', content: 'a la primera arroz y ensalada, a la segunda puré y papas' },
  { role: 'assistant', content: 'Listo. ¿Jugo o consomé para cada una?' },
  { role: 'user', content: 'jugo para las dos' },
  { role: 'assistant', content: 'Anotado: 2 carne mechada (arroz+ensalada / puré+papas), jugo en ambas. ¿Cerramos?' },
  { role: 'user', content: 'eso es todo' },
  { role: 'assistant', content: '¿Es para delivery o retiro en local?' },
];

function resumenOk(v) { return /aqu[ií] va tu pedido/i.test(v) && /total:\s*\$/i.test(v); }

let fails = 0, callsAntes = 0;
for (let i = 1; i <= N; i++) {
  const r = await runBotTurn({
    menu: MENU_FALLBACK,
    history: HISTORY_BASE.map((h) => ({ ...h })),
    userMessage: 'lo paso a buscar al local',
    sesion: 'activa',
    meter,
  });
  const callsTurno = meter.summary().byModel['claude-haiku-4-5'].calls - callsAntes;
  callsAntes += callsTurno;
  const ok = resumenOk(r.textoVisible);
  const regen = callsTurno > 1 ? ' (GUARD regeneró ✦)' : '';
  console.log(`#${i}: resumen ${ok ? 'OK' : 'VACÍO ✗'} | total=${r.total} | llamadas=${callsTurno}${regen}`);
  if (!ok) { fails++; console.log('   VISIBLE:', JSON.stringify(r.textoVisible)); }
}
console.log('\n=== meter ===', JSON.stringify(meter.summary().byModel));
console.log(fails ? `\n🔴 ${fails}/${N} salieron VACÍOS` : `\n✅ ${N}/${N} con resumen completo`);
process.exit(fails ? 1 : 0);
