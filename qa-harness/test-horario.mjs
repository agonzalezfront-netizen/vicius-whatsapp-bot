// Handoff v1 Fase 3 — horario de atención. Verifica estaAbierto() en/fuera de horario
// (L-S 12-19, Dom 12-18) con fechas inyectadas (TZ America/Santiago, junio = UTC-4).
//
// Uso: node qa-harness/test-horario.mjs

const { estaAbierto, mensajeCerrado } = await import('../src/horario.js');

const menu = { horario: {
  lunes:{abre:'12:00',cierra:'19:00'}, martes:{abre:'12:00',cierra:'19:00'},
  'miércoles':{abre:'12:00',cierra:'19:00'}, jueves:{abre:'12:00',cierra:'19:00'},
  viernes:{abre:'12:00',cierra:'19:00'}, 'sábado':{abre:'12:00',cierra:'19:00'},
  domingo:{abre:'12:00',cierra:'18:00'},
}};
const TZ = 'America/Santiago';
// junio (invierno Chile) = UTC-4 → hora Santiago = UTC - 4.
const stgo = (iso) => new Date(iso); // pasamos UTC explícito
let pass=0, fail=0;
const check=(n,c)=>{ if(c){pass++;console.log('  ✅ '+n);}else{fail++;console.log('  ❌ '+n);} };

// 2026-06-09 es MARTES. 15:00 Santiago = 19:00 UTC → abierto.
check('martes 15:00 → abierto', estaAbierto(menu, TZ, stgo('2026-06-09T19:00:00Z')) === true);
// martes 20:00 Santiago = 00:00 UTC del 10 → cerrado (cierra 19).
check('martes 20:00 → cerrado', estaAbierto(menu, TZ, stgo('2026-06-10T00:00:00Z')) === false);
// martes 11:00 Santiago = 15:00 UTC → cerrado (abre 12).
check('martes 11:00 → cerrado (antes de abrir)', estaAbierto(menu, TZ, stgo('2026-06-09T15:00:00Z')) === false);
// 2026-06-14 es DOMINGO. 13:00 Santiago = 17:00 UTC → abierto.
check('domingo 13:00 → abierto', estaAbierto(menu, TZ, stgo('2026-06-14T17:00:00Z')) === true);
// domingo 18:30 Santiago = 22:30 UTC → cerrado (Dom cierra 18).
check('domingo 18:30 → cerrado (Dom cierra 18)', estaAbierto(menu, TZ, stgo('2026-06-14T22:30:00Z')) === false);
// sábado (2026-06-13) 18:30 = 22:30 UTC → abierto (L-S cierra 19).
check('sábado 18:30 → abierto (L-S cierra 19)', estaAbierto(menu, TZ, stgo('2026-06-13T22:30:00Z')) === true);

check('mensajeCerrado menciona 12 a 19', /12 a 19/.test(mensajeCerrado()));

console.log(`\n=== HORARIO: ${pass} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
