// Runner del harness de QA del bot Sazón.
//
// Para cada caso: corre la conversación (scripted = turnos fijos del cliente;
// persona = cliente LLM adversarial dinámico), la evalúa con el juez, y acumula
// el veredicto. Respeta el CostMeter: si se alcanza el tope (default $5), corta
// limpio y reporta lo hecho hasta ahí (los casos restantes quedan "no corridos").
//
// Uso:
//   node qa-harness/runner.mjs                 # todos los casos
//   node qa-harness/runner.mjs C1-B2 C2        # solo esos ids
//   CAP_USD=0.50 node qa-harness/runner.mjs    # tope custom
//   ANTHROPIC_MODEL=claude-sonnet-4-6 node qa-harness/runner.mjs   # otro modelo de bot

import { CostMeter, CapExceededError, runBotTurn, MENU_PRUEBA, MENU_FALLBACK } from './lib.mjs';
import { judge } from './judge.mjs';
import { personaTurn } from './persona.mjs';
import { CASOS } from './casos.mjs';

const { setActiveMenu } = await import('../src/active-menu.js');

// Cada caso puede traer su propio menú activo (caso.menu). Default MENU_PRUEBA.
// Se aplica ANTES de correr el caso para que el bot vea el menú del día correcto.
function aplicarMenu(caso) {
  setActiveMenu(caso.menu ?? MENU_PRUEBA);
}

const CAP_USD = parseFloat(process.env.CAP_USD ?? '5');
const BOT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
// RUNS = veces que se corre CADA caso (para promediar y medir varianza —
// Haiku/Sonnet son estocásticos, un solo run es ruidoso). Default 1.
const RUNS = parseInt(process.env.RUNS ?? '1', 10);

// Filtro opcional por ids pasados como args.
const filtro = process.argv.slice(2);
const casos = filtro.length ? CASOS.filter((c) => filtro.includes(c.id)) : CASOS;

const meter = new CostMeter({ capUSD: CAP_USD });

console.log(`=== HARNESS QA bot Sazón ===`);
console.log(`Bot: ${BOT_MODEL} | cap: $${CAP_USD} | casos: ${casos.length}\n`);

// Corre una conversación scripted (turnos fijos del cliente).
async function correrScripted(caso) {
  const conversacion = [];
  let i = 0;
  for (const userMsg of caso.turns) {
    const sesion = i === 0 ? 'nueva' : 'continua';
    const r = await runBotTurn({
      menu: MENU_FALLBACK,
      history: conversacion.slice(),
      userMessage: userMsg,
      sesion,
      estadoPedido: caso.estadoPedido ?? null,
      meter,
    });
    conversacion.push({ role: 'user', content: userMsg });
    conversacion.push({ role: 'assistant', content: r.textoVisible });
    i++;
  }
  return conversacion;
}

// Corre una conversación con cliente-persona dinámico.
async function correrPersona(caso) {
  const conversacion = [];
  const maxTurns = caso.maxTurns ?? 10;
  for (let t = 0; t < maxTurns; t++) {
    const pt = await personaTurn({ persona: caso.persona, conversacion: conversacion.slice(), meter });
    if (!pt.mensaje) { if (pt.fin) break; else continue; }
    const sesion = t === 0 ? 'nueva' : 'continua';
    const r = await runBotTurn({
      menu: MENU_FALLBACK,
      history: conversacion.slice(),
      userMessage: pt.mensaje,
      sesion,
      meter,
    });
    conversacion.push({ role: 'user', content: pt.mensaje });
    conversacion.push({ role: 'assistant', content: r.textoVisible });
    if (pt.fin) break;
  }
  return conversacion;
}

const resultados = [];
let cortadoPorCap = false;

console.log(RUNS > 1 ? `(cada caso × ${RUNS} corridas)\n` : '');

outer:
for (const caso of casos) {
  const runs = [];
  for (let run = 1; run <= RUNS; run++) {
    try {
      process.stdout.write(`▶ ${caso.id}${RUNS > 1 ? ` ${run}/${RUNS}` : ` (${caso.desc})`}... `);
      aplicarMenu(caso);
      const conversacion = caso.tipo === 'persona' ? await correrPersona(caso) : await correrScripted(caso);
      const v = await judge({ conversacion, criterios: caso.criterios, meter });
      runs.push(v);
      console.log(`${v.pass ? '✅' : '❌'} ${v.score}/10 — $${meter.spentUSD.toFixed(3)}`);
    } catch (err) {
      if (err instanceof CapExceededError) {
        console.log(`\n⛔ ${err.message}`);
        cortadoPorCap = true;
        break outer;
      }
      console.log(`💥 ERROR: ${err.message}`);
      runs.push({ pass: false, score: 0, issues: [err.message], razon: 'excepción', error: true });
    }
  }
  if (!runs.length) continue;
  const passCount = runs.filter((r) => r.pass).length;
  const avgScore = runs.reduce((a, r) => a + r.score, 0) / runs.length;
  const lastFail = runs.find((r) => !r.pass);
  resultados.push({
    id: caso.id, desc: caso.desc, tipo: caso.tipo,
    runs: runs.length, passCount, passRate: passCount / runs.length,
    avgScore: Number(avgScore.toFixed(1)),
    issues: lastFail?.issues ?? [], razon: lastFail?.razon ?? '',
  });
  if (RUNS > 1) console.log(`   → ${caso.id}: ${passCount}/${runs.length} PASS, avg ${avgScore.toFixed(1)}/10`);
  else if (lastFail) console.log(`    issues: ${lastFail.issues.join('; ')}`);
}

// ── Reporte agregado (clasificado por varianza) ─────────────────────────────
console.log(`\n${'═'.repeat(60)}\nREPORTE${RUNS > 1 ? ` (${RUNS} corridas/caso)` : ''}`);
const corridos = resultados.length;
const solidos = resultados.filter((r) => r.passRate >= 0.8);
const fluct = resultados.filter((r) => r.passRate >= 0.2 && r.passRate < 0.8);
const rotos = resultados.filter((r) => r.passRate < 0.2);
const totalPass = resultados.reduce((a, r) => a + r.passCount, 0);
const totalRuns = resultados.reduce((a, r) => a + r.runs, 0);
console.log(`Casos: ${corridos}/${casos.length}${cortadoPorCap ? ' (cortado por tope $)' : ''} | corridas totales: ${totalRuns}`);
console.log(`PASS-rate global: ${totalPass}/${totalRuns} (${(100 * totalPass / totalRuns).toFixed(0)}%)`);
console.log(`✅ sólidos (≥80%): ${solidos.length}  |  🟡 fluctuantes (20-80%): ${fluct.length}  |  ❌ rotos (<20%): ${rotos.length}`);

if (rotos.length) {
  console.log(`\n❌ ROTOS (fallan sistemáticamente):`);
  for (const r of rotos) console.log(`  [${r.id}] ${r.desc} — ${r.passCount}/${r.runs} (avg ${r.avgScore}/10): ${r.razon}`);
}
if (fluct.length) {
  console.log(`\n🟡 FLUCTUANTES (borde del umbral, varianza del modelo):`);
  for (const r of fluct) console.log(`  [${r.id}] ${r.desc} — ${r.passCount}/${r.runs} (avg ${r.avgScore}/10)`);
}

console.log(`\n--- costo ---`);
console.log(JSON.stringify(meter.summary(), null, 2));

// Salida JSON para procesamiento posterior (loop de refinamiento).
import { writeFileSync } from 'node:fs';
const out = {
  fecha_bot_model: BOT_MODEL, cap_usd: CAP_USD, runs_por_caso: RUNS, cortado_por_cap: cortadoPorCap,
  resumen: { corridos, total_pass: totalPass, total_runs: totalRuns, solidos: solidos.length, fluctuantes: fluct.length, rotos: rotos.length },
  costo: meter.summary(), resultados,
};
writeFileSync(new URL('./ultimo-reporte.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`\n📄 Reporte completo → qa-harness/ultimo-reporte.json`);
process.exit(rotos.length ? 1 : 0);
