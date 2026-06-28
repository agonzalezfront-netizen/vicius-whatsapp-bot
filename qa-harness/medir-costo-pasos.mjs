// Mide el costo por turno de un pedido de retiro completo, etiquetando cada turno como
// ESTRUCTURADO (candidato a botones + ruteo sin LLM) o LIBRE (armado del pedido, sigue con LLM).
// Objetivo: cuantificar el ahorro POTENCIAL de migrar los pasos estructurados (encargo tokens 2026-06-27).
import { runBotTurn, CostMeter, MENU_FALLBACK, MENU_PRUEBA, usageCostUSD } from './lib.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);

const meter = new CostMeter({ capUSD: 2.0 });
const history = [];
const turnos = [
  ['hola', 'LIBRE (saludo+menú)'],
  ['quiero 2 carne mechada', 'LIBRE (arma carrito)'],
  ['a la primera arroz y ensalada, a la segunda puré y papas', 'LIBRE (acompañamientos)'],
  ['jugo para las dos', 'SEMI (bebida)'],
  ['eso es todo', 'ESTRUCTURADO (pregunta modalidad)'],
  ['lo paso a buscar al local', 'LIBRE (resumen por código)'],
  ['sí, confirmo', 'ESTRUCTURADO (pregunta pago)'],
  ['pago en el local', 'ESTRUCTURADO (cierre + PEDIDO)'],
];

let totalUSD = 0, estructUSD = 0;
const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
for (const [msg, tipo] of turnos) {
  const r = await runBotTurn({ menu: MENU_FALLBACK, history, userMessage: msg, sesion: 'nueva', meter });
  history.push({ role: 'user', content: msg }, { role: 'assistant', content: r.textoVisible });
  const c = usageCostUSD(r.usage, model);
  totalUSD += c;
  if (tipo.startsWith('ESTRUCTURADO')) estructUSD += c;
  const u = r.usage || {};
  console.log(`[${tipo}]  in=${u.input_tokens||0} cacheR=${u.cache_read_input_tokens||0} out=${u.output_tokens||0}  $${c.toFixed(5)}`);
}
console.log('\n--- RESUMEN ---');
console.log('costo total del pedido:    $' + totalUSD.toFixed(5));
console.log('costo pasos estructurados: $' + estructUSD.toFixed(5) + ' (' + Math.round(100*estructUSD/totalUSD) + '% del total)');
console.log('→ ahorro MÁX si se rutean sin LLM: ~$' + estructUSD.toFixed(5) + '/pedido');
console.log('a 20 ped/día: ~$' + (estructUSD*20*30).toFixed(2) + '/mes | a 100 ped/día: ~$' + (estructUSD*100*30).toFixed(2) + '/mes');
