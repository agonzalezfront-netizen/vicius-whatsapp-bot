// Test UNITARIO (sin red): el poller de notificaciones avisa al cliente cuando el local CANCELA.
// Antes 'cancelado' caía en default:null → se descartaba en silencio (el cliente nunca se enteraba).
//
// Uso: node qa-harness/test-notif-cancelado.mjs
import { textoPara } from '../src/notif-poller.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

console.log('— Cancelación → mensaje al cliente —');
const t = textoPara({ tipo: 'cancelado', razon: 'se agotó el plato' });
check('cancelado devuelve texto (no null)', typeof t === 'string' && t.length > 0);
check('menciona la cancelación', /cancel/i.test(t));
check('incluye la razón de la dueña', /se agot/i.test(t));

const t2 = textoPara({ tipo: 'cancelado' });
check('cancelado sin razón igual avisa', typeof t2 === 'string' && /cancel/i.test(t2));

check('alias cancelado_por_dueño también avisa', /cancel/i.test(textoPara({ tipo: 'cancelado_por_dueño' }) || ''));

console.log('\n— Regresión: otros tipos intactos —');
check('validado', /cocina|confirmad/i.test(textoPara({ tipo: 'validado' })));
check('rechazado', /comprobante/i.test(textoPara({ tipo: 'rechazado', razon: 'ilegible' })));
check('tipo desconocido → null (se descarta, no loopea)', textoPara({ tipo: 'inventado' }) === null);

console.log(`\n=== NOTIF CANCELADO: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
