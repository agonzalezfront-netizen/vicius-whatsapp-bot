// Unit del detector del guard de resumen (bug staging 2026-06-26). Función PURA, sin LLM.
// `_tienePedidoConItems(texto)` decide si el texto trae un <<PEDIDO>> parseable y con ítems;
// es la condición que dispara la regeneración cuando el bot puso {{RESUMEN}} sin el bloque.
import { _tienePedidoConItems } from '../src/claude.js';

const PEDIDO_OK = '<<PEDIDO>>{"items":[{"proteina":"Carne mechada","agregados":["arroz"]}],"tipo":"local"}<<FIN>>';
const casos = [
  ['con <<PEDIDO>> válido y 1 ítem', `Aquí va tu pedido:\n{{RESUMEN}}\n${PEDIDO_OK}`, true],
  ['sin <<PEDIDO>> (el bug)', 'Aquí va tu pedido:\n{{RESUMEN}}\n¿Confirmamos?', false],
  ['<<PEDIDO>> con JSON inválido', 'x <<PEDIDO>>{items: no-json}<<FIN>>', false],
  ['<<PEDIDO>> con items vacío', '<<PEDIDO>>{"items":[],"tipo":"local"}<<FIN>>', false],
  ['texto plano sin nada', 'Hola, ¿en qué te ayudo?', false],
];

let fails = 0;
for (const [desc, texto, esperado] of casos) {
  const got = _tienePedidoConItems(texto);
  const ok = got === esperado;
  console.log((ok ? '  OK  ' : 'FAIL  ') + desc + ` (esperado ${esperado}, got ${got})`);
  if (!ok) fails++;
}
console.log(fails ? `\n${fails} FALLO(S)` : '\nTODO OK');
process.exit(fails ? 1 : 0);
