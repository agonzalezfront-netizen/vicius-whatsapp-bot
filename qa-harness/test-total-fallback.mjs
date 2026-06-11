// Test DETERMINISTA del bug "total $0" multi-turno (2026-06-10) y su fix.
// No depende del LLM: simula el escenario exacto de mensajes del bot.
//   Turno A: resumen con <<CALC>>  → fija el total de la conversación.
//   Turno B: datos de transferencia con <<PEDIDO>> pero SIN <<CALC>>.
// Sin fix: el total cae al placeholder pedido.total=0. Con fix: usa el total de A.

import { procesarCalc, extraerPedido } from '../src/handlers.js';

// Réplica EXACTA de la resolución de total de handlers.js (con y sin fix) para
// probar el comportamiento de forma aislada y determinista.
function resolverTotal({ msgPedido, ultimoTotalCalc, conFix }) {
  const calc = procesarCalc(msgPedido);
  const { pedido } = extraerPedido(calc.limpio);
  if (!pedido) return { error: 'sin pedido' };
  const totalPedido = conFix
    ? (calc.total !== null ? calc.total : ultimoTotalCalc ?? pedido.total)
    : (calc.total !== null ? calc.total : pedido.total);
  return { totalPedido, calcTotal: calc.total, placeholder: pedido.total };
}

// Turno A: el bot mostró el resumen + total (con CALC). 3 items + especial + 2 extras + delivery.
const msgResumen = 'Tu pedido: ... Total: {{TOTAL}} <<CALC>>[7000,7000,9000,2000,2000,1000]<<FIN>>';
const totalA = procesarCalc(msgResumen).total; // = 28000
console.log('Turno A (resumen): total calculado =', totalA);

// Turno B: datos de transferencia + <<PEDIDO>> SIN <<CALC>> (el caso de producción).
const msgPedidoSinCalc =
  'Perfecto, te paso los datos para transferir... <<PEDIDO>>{"items":[{"proteina":"Carne mechada","agregados":["puré","ensalada"],"bebida":"consomé","extras":[],"modificaciones":""}],"total":0,"metodo_pago":"transferencia","tipo":"delivery","direccion":"Pudeto 6631 depto 602","status":"esperando_comprobante"}<<FIN>>';

const sinFix = resolverTotal({ msgPedido: msgPedidoSinCalc, ultimoTotalCalc: totalA, conFix: false });
const conFix = resolverTotal({ msgPedido: msgPedidoSinCalc, ultimoTotalCalc: totalA, conFix: true });

console.log('\nTurno B (PEDIDO sin CALC):');
console.log('  SIN fix → total guardado:', sinFix.totalPedido, sinFix.totalPedido === 0 ? '❌ (bug)' : '');
console.log('  CON fix → total guardado:', conFix.totalPedido, conFix.totalPedido === totalA ? '✅ (carry-forward)' : '❌');

// Control: si el PEDIDO SÍ trae su propio CALC (caso simple), ambos dan el total correcto.
const msgPedidoConCalc = 'Total: {{TOTAL}} <<CALC>>[7000,1000]<<FIN>> ... <<PEDIDO>>{"items":[{"proteina":"Pollo"}],"total":0,"metodo_pago":"transferencia","tipo":"delivery","direccion":"x","status":"esperando_comprobante"}<<FIN>>';
const conCalc = resolverTotal({ msgPedido: msgPedidoConCalc, ultimoTotalCalc: 999, conFix: true });
console.log('\nControl (PEDIDO con su propio CALC): total =', conCalc.totalPedido, conCalc.totalPedido === 8000 ? '✅' : '❌');

const ok = sinFix.totalPedido === 0 && conFix.totalPedido === 28000 && conCalc.totalPedido === 8000;
console.log('\n' + (ok ? '✅ BUG reproducido SIN fix y CORREGIDO con fix' : '❌ algo no cuadra'));
process.exit(ok ? 0 : 1);
