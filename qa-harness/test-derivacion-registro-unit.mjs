// GUARDA DE CLASE del contrato WhatsApp (p6): EXACTAMENTE 1 saliente de derivación por (tenant, cliente) por
// ventana; reenvío pasada la ventana; aislamiento por tenant; contadores por mes. Unit puro, sin LLM ni red.
// Uso: node qa-harness/test-derivacion-registro-unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Archivo temporal ANTES de importar el módulo (lee la env al cargar).
const TMP = path.join(os.tmpdir(), `deriv-registro-test-${process.pid}.json`);
process.env.DERIVACION_REGISTRO_PATH = TMP;
try { fs.rmSync(TMP, { force: true }); } catch { /* no existe */ }

const { registrarContactoDerivacion, registrarAvisoSaliente, contadoresDelMes, _resetCacheParaTest } =
  await import('../src/derivacion-registro.js');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

const H = 3600 * 1000;
const VENTANA = 24 * H;
const t0 = Date.parse('2026-09-11T13:00:00-03:00');

// ── 1. Primer contacto → envía como 'entrada' ──
const r1 = registrarContactoDerivacion('sazon', 'jidA', VENTANA, t0);
check('primer contacto envía (tipo entrada)', r1.enviar === true && r1.tipo === 'entrada');

// ── 2. Dentro de la ventana → NO reenvía (guarda de clase: exactamente 1) ──
const r2 = registrarContactoDerivacion('sazon', 'jidA', VENTANA, t0 + 1 * H);
const r3 = registrarContactoDerivacion('sazon', 'jidA', VENTANA, t0 + 23 * H);
check('2º mensaje dentro de la ventana NO envía (1h)', r2.enviar === false && r2.tipo === null);
check('3º mensaje dentro de la ventana NO envía (23h)', r3.enviar === false);

// ── 3. Pasada la ventana → REENVÍA como 'reenvio' (ADDENDUM 2) ──
const r4 = registrarContactoDerivacion('sazon', 'jidA', VENTANA, t0 + 25 * H);
check('pasada la ventana reenvía (tipo reenvio)', r4.enviar === true && r4.tipo === 'reenvio');
// justo en el borde (== ventana) cuenta como fuera (>=): a las 24h exactas del reenvío, reenvía otra vez
const r5 = registrarContactoDerivacion('sazon', 'jidA', VENTANA, t0 + 25 * H + VENTANA);
check('otra ventana cumplida reenvía de nuevo', r5.enviar === true && r5.tipo === 'reenvio');

// ── 4. Aislamiento por tenant y por cliente ──
const rB = registrarContactoDerivacion('sazon', 'jidB', VENTANA, t0 + 2 * H);
check('otro cliente del mismo tenant recibe su primer contacto', rB.enviar === true && rB.tipo === 'entrada');
const rOtro = registrarContactoDerivacion('asushi', 'jidA', VENTANA, t0 + 2 * H);
check('mismo jid en otro tenant es independiente (entrada)', rOtro.enviar === true && rOtro.tipo === 'entrada');

// ── 5. Contadores del mes: entrada + reenvio de sazon en septiembre ──
// jidA: 1 entrada + 2 reenvíos; jidB: 1 entrada → entrada=2, reenvio=2
const cS = contadoresDelMes('sazon', t0);
check('contador sazon: entrada=2', cS.entrada === 2);
check('contador sazon: reenvio=2', cS.reenvio === 2);
check('contador asushi aislado: entrada=1', contadoresDelMes('asushi', t0).entrada === 1);

// ── 6. Ventana configurable corta (2h): reenvía antes ──
const r6a = registrarContactoDerivacion('sazon', 'jidC', 2 * H, t0);
const r6b = registrarContactoDerivacion('sazon', 'jidC', 2 * H, t0 + 1 * H);   // dentro de 2h → no
const r6c = registrarContactoDerivacion('sazon', 'jidC', 2 * H, t0 + 3 * H);   // fuera de 2h → reenvía
check('ventana 2h: 1h no envía, 3h reenvía', r6a.enviar && !r6b.enviar && r6c.enviar && r6c.tipo === 'reenvio');

// ── 7. Avisos salientes → 2º contador ──
registrarAvisoSaliente('sazon', t0);
registrarAvisoSaliente('sazon', t0);
check('contador avisos sazon=2', contadoresDelMes('sazon', t0).aviso === 2);

// ── 8. Durabilidad: nuevo "arranque" (reset cache) lee el archivo y respeta la ventana ──
_resetCacheParaTest();
const r8 = registrarContactoDerivacion('sazon', 'jidB', VENTANA, t0 + 3 * H);   // jidB ya contactado a t0+2h
check('tras reinicio (reload de archivo) sigue en silencio dentro de la ventana', r8.enviar === false);

try { fs.rmSync(TMP, { force: true }); } catch { /* limpieza best-effort */ }
console.log(`\n=== DERIVACIÓN REGISTRO UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
