// Verifica el flujo de retiro PULIDO (encargo Alberto 2026-06-26):
//  - Tras elegir retiro → resumen con Total + "¿Confirmamos?" DIRECTO (sin "¿algún ajuste?").
//  - Tras confirmar → pago "¿Pagas en el local o por transferencia?" (NO "efectivo o transferencia").
import { runBotTurn, CostMeter, MENU_FALLBACK, MENU_PRUEBA } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const meter = new CostMeter({ capUSD: 3.0 });
const history = [];
let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

async function t(msg) {
  const r = await runBotTurn({ menu: MENU_FALLBACK, history, userMessage: msg, sesion: 'nueva', meter });
  history.push({ role: 'user', content: msg }, { role: 'assistant', content: r.textoVisible });
  return r;
}

await t('hola');
await t('quiero 2 carne mechada');
await t('a la primera arroz y ensalada, a la segunda puré y papas');
await t('jugo para las dos');
await t('eso es todo');
const rMod = await t('lo paso a buscar al local');
console.log('\n[T6 retiro] VISIBLE:', JSON.stringify(rMod.textoVisible));
check(/total:\s*\$/i.test(rMod.textoVisible), 'T6 muestra el resumen con Total');
check(/confirmamos/i.test(rMod.textoVisible), 'T6 pregunta "¿Confirmamos?"');
check(!/ajuste/i.test(rMod.textoVisible), 'T6 NO repregunta "¿algún ajuste?" (paso redundante eliminado)');

const rPago = await t('sí, confirmo');
console.log('\n[T7 confirma] VISIBLE:', JSON.stringify(rPago.textoVisible));
check(/en el local/i.test(rPago.textoVisible), 'T7 pago retiro dice "en el local"');
check(!/efectivo/i.test(rPago.textoVisible), 'T7 retiro NO usa "efectivo" (usa "en el local")');

console.log('\n=== meter ===', JSON.stringify(meter.summary().byModel));
console.log(fails ? `\n🔴 ${fails} FALLO(S)` : '\n✅ TODO OK');
process.exit(fails ? 1 : 0);
