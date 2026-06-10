// Auditoría de los 4 refinamientos (2026-06-10) contra el modelo REAL (Haiku).
// No es el runner formal con juez: acá capturo el <<PEDIDO>> JSON + el texto visible
// para INSPECCIONAR la estructura (lo que pidió Cortex: "mostrá el JSON + el render").
//
// Cubre: #1 robustez multi-item, #2 contexto post-entrega, #3 jugo extra $2.000.
// (#4 mensaje de cierre es backend+poller, se verifica en el E2E, no por prompt.)
//
// Uso: ANTHROPIC_API_KEY=... node qa-harness/audit-refinamientos.mjs

import { CostMeter, runBotTurn, MENU_FALLBACK } from './lib.mjs';
import { MENU_PRUEBA } from './fixtures.mjs';

const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);

const meter = new CostMeter({ capUSD: 2 });

// Corre una secuencia de turnos del cliente y devuelve el último resultado completo
// (textoVisible + pedido + total), más toda la conversación.
async function correr(turns, estadoPedido = null) {
  const conv = [];
  let last = null;
  let i = 0;
  for (const userMsg of turns) {
    const sesion = i === 0 ? 'nueva' : 'continua';
    last = await runBotTurn({ menu: MENU_FALLBACK, history: conv.slice(), userMessage: userMsg, sesion, estadoPedido, meter });
    conv.push({ role: 'user', content: userMsg });
    conv.push({ role: 'assistant', content: last.textoVisible });
    i++;
  }
  return { last, conv };
}

function sep(t) { console.log('\n' + '═'.repeat(70) + '\n' + t + '\n' + '═'.repeat(70)); }

// ── #1 MULTI-ITEM COMPLEJO ───────────────────────────────────────────────
sep('#1 ROBUSTEZ MULTI-ITEM — 3 platos distintos, campos por item');
{
  const turns = [
    'hola',
    'somos 3, anoto: 1) menú de carne mechada con puré y ensalada, jugo natural, sin cilantro. 2) menú de pollo asado con arroz y papas, consomé. 3) un Pabellón criollo con papas fritas, jugo natural. todo para retirar',
    'eso es todo',
    'pago en efectivo, sin vuelto',
  ];
  const { last } = await correr(turns);
  console.log('\n📋 TEXTO VISIBLE (último turno):\n' + last.textoVisible);
  console.log('\n🔧 <<PEDIDO>> JSON capturado:');
  console.log(JSON.stringify(last.pedido, null, 2));
  console.log('\n🧮 Total calculado:', last.total);
  const items = last.pedido?.items ?? [];
  console.log(`\n✅ AUDIT: items.length = ${items.length} (esperado 3)`);
  items.forEach((it, n) => console.log(`   item ${n + 1}: proteina=${JSON.stringify(it.proteina)} agregados=${JSON.stringify(it.agregados)} bebida=${JSON.stringify(it.bebida)} extras=${JSON.stringify(it.extras)} modif=${JSON.stringify(it.modificaciones)}`));
}

// ── #3 JUGO EXTRA $2.000 ─────────────────────────────────────────────────
sep('#3 JUGO EXTRA $2.000 — el 1º incluido gratis, el 2º cuesta $2.000');
{
  const turns = [
    'hola',
    'un menú de pollo asado con puré y arroz, para retirar',
    'jugo natural',
    'y agregame otro jugo natural aparte',
    'eso es todo, pago en efectivo',
  ];
  const { last } = await correr(turns);
  console.log('\n📋 TEXTO VISIBLE (último turno):\n' + last.textoVisible);
  console.log('\n🧮 Total calculado:', last.total, '(esperado $9.000 = 7000 menú + 2000 jugo extra)');
}

// ── #2 CONTEXTO POST-ENTREGA ─────────────────────────────────────────────
sep('#2 CONTEXTO POST-ENTREGA — pedido ya entregado, cliente agradece');
{
  const { last } = await correr(['hola, muchas gracias, todo riquísimo!'], { status: 'entregado', id: 'ped_test', total: 7000 });
  console.log('\n📋 TEXTO VISIBLE:\n' + last.textoVisible);
  const t = last.textoVisible.toLowerCase();
  const mencionaComprobante = /comprobante|transfer|atento|esper(o|amos) (la|el|tu)|foto/.test(t);
  console.log(`\n✅ AUDIT: ¿menciona comprobante/espera? ${mencionaComprobante ? '❌ SÍ (FALLA — bug post-entrega)' : '✅ NO (correcto)'}`);
}

sep('FIN — costo total: $' + meter.spentUSD.toFixed(4));
