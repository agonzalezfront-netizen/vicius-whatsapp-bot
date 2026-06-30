// BUG7 (2026-06-30) — esEstadoFantasma: no resucitar un pedido ya emitido. DETERMINISTA, sin red.
// Discriminador = el estado FANTASMA se persistió por última vez ANTES/AL crearse el pedido (lo produjo);
// un cliente RECURRENTE arma su pedido nuevo DESPUÉS del viejo. Cubre el caso REAL de Alberto:
// estado CONFIRMAR + mismo total que un pedido ENTREGADO + 48 min (< 90).
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

const NOW = 1_700_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

// Estado en el resumen (CONFIRMAR) con 1 plato estándar = $7.000, sello _ts.
const enConfirmar = (ts) => ({ ...estadoInicial(), paso: PASOS.CONFIRMAR, tipo: 'local', _ts: ts,
  items: [{ proteina: 'Carne Mechada', esEspecial: false, agregados: ['Arroz', 'Tajadas'], bebida: 'Consomé', extras: [], componentes: [] }] });

// 1) 🔴 EL CASO REAL DE ALBERTO: estado CONFIRMAR a las T0, pedido creado ~30s después (lo produjo este estado),
//    ya ENTREGADO, mismo total $7.000, "hola" 48 min después (< 90). DEBE ser fantasma.
const T0 = NOW - 48 * 60_000;
check(esEstadoFantasma(enConfirmar(T0), { status: 'entregado', total: 7000, created_at: iso(T0 + 30_000) }, MENU, NOW) === true,
  '🔴 REAL: CONFIRMAR + mismo total que un ENTREGADO + 48 min (<90) → fantasma (resetea)');
// 2) ✅ Cliente RECURRENTE: pedido viejo entregado AYER, hoy arma uno nuevo (mismo total) → estado RECIENTE,
//    _ts MUY posterior al created_at del viejo → NO fantasma.
check(esEstadoFantasma(enConfirmar(NOW - 60_000), { status: 'entregado', total: 7000, created_at: iso(NOW - 86_400_000) }, MENU, NOW) === false,
  '✅ RECURRENTE: pedido entregado ayer + arma uno nuevo (mismo total) hoy → NO fantasma (se conserva)');
// 3) Recurrente con total DISTINTO → NO fantasma.
check(esEstadoFantasma(enConfirmar(NOW - 60_000), { status: 'entregado', total: 14000, created_at: iso(NOW - 86_400_000) }, MENU, NOW) === false,
  'Recurrente total distinto → NO fantasma');
// 4) Pedido EN PIPELINE mismo total (sin created_at) → fantasma (fallback duplicado inmediato).
check(esEstadoFantasma(enConfirmar(NOW - 60_000), { status: 'esperando_comprobante', total: 7000 }, MENU, NOW) === true,
  'Pipeline mismo total (sin created_at) → fantasma (anti-duplicado)');
// 5) Pipeline OTRO total → NO fantasma.
check(esEstadoFantasma(enConfirmar(NOW - 60_000), { status: 'esperando_comprobante', total: 14000 }, MENU, NOW) === false,
  'Pipeline otro total → NO fantasma (2º pedido)');
// 6) STALE (>90 min) → fantasma (fallback temporal).
check(esEstadoFantasma(enConfirmar(NOW - 2 * 3600_000), { status: 'entregado', total: 7000, created_at: iso(NOW - 2 * 3600_000 + 30_000) }, MENU, NOW) === true,
  'STALE >90 min → fantasma');
// 7) Sin _ts (pre-fix) → fantasma (limpieza de transición).
check(esEstadoFantasma({ ...enConfirmar(undefined) }, null, MENU, NOW) === true, 'CONFIRMAR sin _ts → fantasma');
// 8) Sin pedido emitido + estado reciente → NO fantasma (confirmación normal).
check(esEstadoFantasma(enConfirmar(NOW - 60_000), null, MENU, NOW) === false, 'CONFIRMAR reciente + sin pedido → NO fantasma');
// 9) FIN → fantasma; armando → NO.
check(esEstadoFantasma({ ...estadoInicial(), paso: PASOS.FIN, _ts: NOW - 60_000 }, null, MENU, NOW) === true, 'FIN → fantasma');
check(esEstadoFantasma({ ...estadoInicial(), paso: PASOS.ACOMP, _ts: NOW - 2 * 3600_000 }, { status: 'entregado', total: 7000, created_at: iso(NOW - 2 * 3600_000) }, MENU, NOW) === false, 'ACOMP (armando) → NO fantasma');
// 10) null → false.
check(esEstadoFantasma(null, { status: 'entregado', total: 7000 }, MENU, NOW) === false, 'estado null → false');

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK (BUG7)');
process.exit(fails ? 1 : 0);
