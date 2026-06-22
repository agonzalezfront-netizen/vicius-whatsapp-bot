// Red de seguridad determinista: derivacionVerbal() detecta cuando el bot deriva EN EL TEXTO
// aunque NO emita <<ESCALAR>> (bug real 2026-06-22: consulta de pago con tarjeta → el bot dijo
// "déjame consultarle a la pareja" sin marcador → no se marcó requiere_humano y siguió).
// Unit puro, sin LLM ni red.  Uso: node qa-harness/test-derivacion-unit.mjs
import { derivacionVerbal } from '../src/claude.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

// ── POSITIVOS: frases de derivación → deben detectarse ──
const POSITIVOS = [
  // EL CASO REAL del bug (pago con tarjeta):
  'Claro, déjame consultarle a la pareja sobre eso y te confirmo en un ratito 🙂. Mientras tanto, ¿delivery o retiro?',
  'Déjame consultarle a la pareja y vuelvo en un ratito',
  'Déjame consultar ese detalle con el local y te confirmo enseguida 🙂',
  'Eso lo consulto con la pareja y te aviso',
  'Para coordinar los detalles de tu reserva déjame avisarle a la pareja',
  'Dejame verificar con el local si se puede',
  'Lo consulto y vuelvo en un ratito',
  'Disculpa, tuve un problema técnico. Déjame consultarle a la pareja y vuelvo en un ratito.',
];
for (const t of POSITIVOS) check('detecta derivación: "' + t.slice(0, 48) + '…"', derivacionVerbal(t) === true);

// ── NEGATIVOS: NO son derivación → NO deben dispararse ──
const NEGATIVOS = [
  '¿Querés delivery o retiro?',
  '¡Hola! Hoy tenemos Carne mechada con arroz, puré o ensalada. ¿Querés un menú? 🙂',
  'Tu pedido quedó confirmado, total $7.000. ¡Gracias!',
  'Perfecto, anoté carne mechada con arroz y consomé.',
  // Transferencia: dice "validar con la pareja y te confirmo enseguida" — NO matchea (va con <<PEDIDO>>,
  // y el caller además la excluye por el guard !pedido).
  'Apenas me mandes la foto del comprobante, lo paso a validar con la pareja y te confirmo enseguida.',
];
for (const t of NEGATIVOS) check('NO dispara: "' + t.slice(0, 48) + '…"', derivacionVerbal(t) === false);

console.log(`\n=== DERIVACIÓN UNIT: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
