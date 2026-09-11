// Test UNITARIO (sin red): contrato A5 (Cortex 18:00, opción A) — la copy la fija el WIZARD en notif_razon y
// el bot la manda VERBATIM para 'ya_casi', 'sin_respuesta' y 'listo'-con-razón. Verbatim = verbatim: el bot NO
// reformula ni concatena nada. 'listo' sin razón conserva el aviso de retiro con la dirección (legacy).
//
// Uso: node qa-harness/test-notif-a5.mjs
import { textoPara } from '../src/notif-poller.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

const YA = 'Hoy hay más pedidos de lo habitual. Ya casi está: estamos terminando tu pedido.';
const SR = 'Tu pedido sigue en preparación. Puedes escribirnos o cancelar sin costo.';
const LISTO_OK = '¡Tu pedido está listo!';
const LISTO_DISC = '¡Tu pedido está listo! Perdón por la espera de hoy.';

console.log('— A5: el bot manda notif_razon VERBATIM —');
check('ya_casi devuelve la razón EXACTA (verbatim, sin agregar nada)', textoPara({ tipo: 'ya_casi', razon: YA }) === YA);
check('sin_respuesta verbatim', textoPara({ tipo: 'sin_respuesta', razon: SR }) === SR);
check('listo con razón (a tiempo) verbatim', textoPara({ tipo: 'listo', razon: LISTO_OK }) === LISTO_OK);
check('listo con razón (disculpa) verbatim', textoPara({ tipo: 'listo', razon: LISTO_DISC }) === LISTO_DISC);

console.log('\n— Bordes —');
check('ya_casi sin razón → null (no manda basura)', textoPara({ tipo: 'ya_casi' }) === null);
check('sin_respuesta sin razón → null', textoPara({ tipo: 'sin_respuesta', razon: '   ' }) === null);
check('listo SIN razón conserva el aviso de retiro con dirección (legacy)', /retirar/i.test(textoPara({ tipo: 'listo' })));

console.log('\n— Regresión: tipos previos intactos —');
check('validado', /cocina|confirmad/i.test(textoPara({ tipo: 'validado' })));
check('cancelado sigue avisando', /cancel/i.test(textoPara({ tipo: 'cancelado', razon: 'x' })));
check('tipo desconocido → null', textoPara({ tipo: 'inventado' }) === null);

console.log(`\n=== NOTIF A5: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
