// Auditoría de costos Anthropic — escenarios representativos (encargo Cortex 2026-06-27).
// Corre del más corto al más largo y desglosa tokens: cache_write (system prompt) / cache_read /
// input fresco / output. Pricing Haiku 4.5 (lib.mjs). NO rediseña nada: solo mide.
//
// ⚠️ ARTEFACTO DEL CACHE (importante al leer): el prompt cache de Anthropic vive 5 min server-side.
// El PRIMER escenario que corre escribe el cache (cache_write=12429 = system prompt) y los
// siguientes, si corren dentro de los 5 min, lo leen CALIENTE (cache_write=0). Por eso solo el 1er
// escenario muestra write. Para el costo REAL por pedido AISLADO (conversación nueva tras pausa),
// normalizar: 1 cache_write (12429 tok) + (N-1) cache_read por escenario. El system prompt cacheado
// es constante = 12429 tokens (verificable: cacheR / N_turnos = 12429 en todos).
import { runBotTurn, CostMeter, MENU_FALLBACK, MENU_PRUEBA } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);

const P = { in: 1.0, out: 5.0 }; // USD/MTok Haiku 4.5
const cw = (t) => t * P.in * 1.25 / 1e6;   // cache write
const cr = (t) => t * P.in * 0.10 / 1e6;   // cache read
const fi = (t) => t * P.in / 1e6;          // input fresco
const fo = (t) => t * P.out / 1e6;         // output

const ESCENARIOS = {
  'rapido (1 ítem, retiro, directo)': [
    'hola, quiero un pollo asado con arroz y ensalada y un jugo',
    'retiro en el local',
    'sí confirmo',
    'pago en el local',
  ],
  'medio (2 ítems + 1 pregunta, delivery efectivo)': [
    'hola',
    'tienen algo vegetariano?',
    'ya, dame 2 carne mechada',
    'a una arroz y ensalada, a la otra puré y papas',
    'jugo para las dos',
    'eso es todo',
    'delivery, Los Aromos 123, es casa',
    'efectivo',
  ],
  'medio-cambios (cambia bebida y acompañamiento)': [
    'hola',
    'un pollo asado con puré y papas y un consomé',
    'mejor cambia el consomé por jugo',
    'y cambia las papas por ensalada',
    'nada más',
    'retiro',
    'sí',
    'en el local',
  ],
  'largo (agrega/quita/pregunta/se arrepiente)': [
    'hola',
    'qué especiales hay hoy?',
    'cuánto sale el pabellón criollo?',
    'dame 2 carne mechada con arroz y ensalada',
    'agrega un pollo asado con puré',
    'a todos jugo',
    'sabes qué, quita el pollo',
    'mejor agrega papas fritas a una carne',
    'cuánto va quedando?',
    'ya está, eso es todo',
    'delivery a Av Vicuña Mackenna 6571, edificio, depto 302',
    'transferencia',
  ],
};

const filas = [];
for (const [nombre, msgs] of Object.entries(ESCENARIOS)) {
  const meter = new CostMeter({ capUSD: 3.0 });
  const history = [];
  let cwT = 0, crT = 0, fiT = 0, foT = 0, llm = 0;
  for (const m of msgs) {
    const r = await runBotTurn({ menu: MENU_FALLBACK, history, userMessage: m, sesion: 'nueva', meter });
    history.push({ role: 'user', content: m }, { role: 'assistant', content: r.textoVisible });
    const u = r.usage || {}; llm++;
    cwT += u.cache_creation_input_tokens || 0;
    crT += u.cache_read_input_tokens || 0;
    fiT += u.input_tokens || 0;
    foT += u.output_tokens || 0;
  }
  const costo = cw(cwT) + cr(crT) + fi(fiT) + fo(foT);
  filas.push({ nombre, turnos: msgs.length, llm, cwT, crT, fiT, foT, costo, costoCW: cw(cwT) });
}

console.log('\n================ AUDITORÍA COSTOS ANTHROPIC (Haiku 4.5) ================');
for (const f of filas) {
  console.log('\n● ' + f.nombre);
  console.log(`  turnos cliente=${f.turnos} · llamadas LLM=${f.llm}`);
  console.log(`  tokens: cache_write=${f.cwT}  cache_read=${f.crT}  input_fresco=${f.fiT}  output=${f.foT}`);
  console.log(`  costo total = $${f.costo.toFixed(5)}  (cache_write system prompt = $${f.costoCW.toFixed(5)} = ${Math.round(100*f.costoCW/f.costo)}%)`);
}
console.log('\n--- TABLA RESUMEN (USD) ---');
console.log('escenario | turnos | LLM | cacheW tok | cacheR tok | inFresco | output | $total | $cacheW | %cacheW');
for (const f of filas) {
  console.log(`${f.nombre} | ${f.turnos} | ${f.llm} | ${f.cwT} | ${f.crT} | ${f.fiT} | ${f.foT} | ${f.costo.toFixed(4)} | ${f.costoCW.toFixed(4)} | ${Math.round(100*f.costoCW/f.costo)}%`);
}
const prom = filas.reduce((a,f)=>a+f.costo,0)/filas.length;
console.log(`\npromedio de los ${filas.length} escenarios: $${prom.toFixed(4)}/pedido`);
