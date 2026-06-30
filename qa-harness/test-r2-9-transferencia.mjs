// R2-9 (2026-06-30) — resolución de los datos de transferencia para el tier básico. DETERMINISTA, sin red.
// Verifica que la env var SAZON_TRANSFER_INFO mande, con fallback al menu.datos_transferencia, y null si nada.
import { resolverDatosTransferencia } from '../src/flujo-botones-router.js';

let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

const prev = process.env.SAZON_TRANSFER_INFO;

// 1) env var presente → manda sobre todo.
process.env.SAZON_TRANSFER_INFO = 'Banco Estado · Cuenta 123 · César · RUT 11.111.111-1';
check(resolverDatosTransferencia({ datos_transferencia: { configurado: false } }) === 'Banco Estado · Cuenta 123 · César · RUT 11.111.111-1',
  'env SAZON_TRANSFER_INFO presente → la usa (manda sobre el menú)');

// 2) sin env, menú configurado → usa el texto del menú.
delete process.env.SAZON_TRANSFER_INFO;
check(resolverDatosTransferencia({ datos_transferencia: { configurado: true, texto: 'Datos del menú' } }) === 'Datos del menú',
  'sin env + menú configurado → usa el texto del menú');

// 3) sin env, menú NO configurado → null (el caller NO inventa).
check(resolverDatosTransferencia({ datos_transferencia: { configurado: false, texto: 'PENDIENTE...' } }) === null,
  'sin env + menú no configurado → null (no inventa datos)');

// 4) sin nada → null.
check(resolverDatosTransferencia(null) === null, 'menú nulo → null');
check(resolverDatosTransferencia({}) === null, 'menú sin datos_transferencia → null');

// 5) env con solo espacios → se ignora (cae al menú/null).
process.env.SAZON_TRANSFER_INFO = '   ';
check(resolverDatosTransferencia({ datos_transferencia: { configurado: true, texto: 'Del menú' } }) === 'Del menú',
  'env vacía (solo espacios) → no la usa, cae al menú');

if (prev === undefined) delete process.env.SAZON_TRANSFER_INFO; else process.env.SAZON_TRANSFER_INFO = prev;

console.log('\n=== RESULTADO ===');
console.log(fails ? `${fails} FALLO(S)` : 'TODO OK (R2-9)');
process.exit(fails ? 1 : 0);
