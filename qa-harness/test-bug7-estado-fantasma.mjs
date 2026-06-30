// BUG7 (2026-06-30) — esEstadoFantasma: no resucitar un pedido ya emitido. DETERMINISTA, sin red.
// Discriminador = TIEMPO (estado viejo) + duplicado en pipeline. Un cliente recurrente (pedido anterior
// entregado) armando uno nuevo NO debe ser falso-reseteado.
import { esEstadoFantasma, estadoInicial, PASOS } from '../src/flujo-botones.js';

const MENU = {
  price_typical: 7000,
  proteinas_dia: [{ nombre: 'Carne Mechada', disponible: true }],
  agregados_incluidos: ['Arroz', 'Tajadas'],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }],
  bebida_incluida: ['Consomé'],
};
let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

const NOW = 1_000_000_000_000;
const FRESH = NOW - 60_000;        // recién persistido (1 min)
const STALE = NOW - 2 * 3600_000;  // 2 h atrás → viejo

// Estado en el resumen (CONFIRMAR) con 1 plato estándar = $7.000, con sello _ts.
const enConfirmar = (ts) => ({ ...estadoInicial(), paso: PASOS.CONFIRMAR, tipo: 'local', _ts: ts,
  items: [{ proteina: 'Carne Mechada', esEspecial: false, agregados: ['Arroz', 'Tajadas'], bebida: 'Consomé', extras: [], componentes: [] }] });

// 1) CONFIRMAR viejo (stale) → fantasma (EL bug: "hola" 2.5 h después de entregado).
check(esEstadoFantasma(enConfirmar(STALE), { status: 'entregado', total: 7000 }, MENU, NOW) === true,
  '🔴 CONFIRMAR viejo (stale) → fantasma (resetea, arranca fresco)');
// 2) CONFIRMAR RECIENTE + último pedido ENTREGADO → NO fantasma (cliente recurrente armando uno nuevo).
check(esEstadoFantasma(enConfirmar(FRESH), { status: 'entregado', total: 7000 }, MENU, NOW) === false,
  '✅ CONFIRMAR reciente + pedido anterior entregado → NO fantasma (sin falso reset al recurrente)');
// 3) CONFIRMAR reciente + pedido EN PIPELINE mismo total → fantasma (anti-duplicado inmediato).
check(esEstadoFantasma(enConfirmar(FRESH), { status: 'esperando_comprobante', total: 7000 }, MENU, NOW) === true,
  'CONFIRMAR reciente + esperando_comprobante mismo total → fantasma (anti-duplicado)');
// 4) CONFIRMAR reciente + pipeline OTRO total → NO fantasma (2º pedido legítimo).
check(esEstadoFantasma(enConfirmar(FRESH), { status: 'esperando_comprobante', total: 14000 }, MENU, NOW) === false,
  'CONFIRMAR reciente + pipeline otro total → NO fantasma (2º pedido)');
// 5) CONFIRMAR reciente + sin pedido → NO fantasma (confirmación normal).
check(esEstadoFantasma(enConfirmar(FRESH), null, MENU, NOW) === false,
  'CONFIRMAR reciente + sin pedido → NO fantasma (confirmación normal)');
// 6) CONFIRMAR sin _ts (estado de antes del fix) → fantasma (limpieza en transición del deploy).
check(esEstadoFantasma({ ...enConfirmar(undefined) }, null, MENU, NOW) === true,
  'CONFIRMAR sin _ts (pre-fix) → fantasma (limpieza de transición)');
// 7) FIN → fantasma siempre.
check(esEstadoFantasma({ ...estadoInicial(), paso: PASOS.FIN, _ts: FRESH }, null, MENU, NOW) === true, 'FIN → fantasma');
// 8) Armando → NUNCA fantasma (aunque viejo o con pedido entregado).
check(esEstadoFantasma({ ...estadoInicial(), paso: PASOS.ACOMP, _ts: STALE }, { status: 'entregado', total: 7000 }, MENU, NOW) === false,
  'ACOMP (armando) → NO fantasma aunque viejo');
check(esEstadoFantasma({ ...estadoInicial(), paso: PASOS.PROTEINA, _ts: STALE }, null, MENU, NOW) === false, 'PROTEINA → NO fantasma');
// 9) null → false.
check(esEstadoFantasma(null, { status: 'entregado', total: 7000 }, MENU, NOW) === false, 'estado null → false');

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK (BUG7)');
process.exit(fails ? 1 : 0);
