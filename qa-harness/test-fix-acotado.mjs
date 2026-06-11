import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA); // bebida_incluida: ['Jugo natural','Consomé'], especial Pabellón
const turns = [
  'hola',
  'quiero un Pabellón criollo',          // especial → NO debe forzar acompañamiento
  'un jugo',                             // elige bebida
  'así está bien, nada más',            // debe avanzar SIN forzar acompañamiento
  'para retiro, efectivo',
];
const conv=[]; let i=0; let textos=[];
for (const u of turns) { const r = await runBotTurn({ menu: MENU_FALLBACK, history: conv.slice(), userMessage: u, sesion: i===0?'nueva':'continua' }); conv.push({role:'user',content:u}); conv.push({role:'assistant',content:r.textoVisible}); textos.push(r.textoVisible); i++; }
const todo = textos.join('\n---\n');
console.log('=== conversación ===\n'+todo.slice(0,1200));
const diceNatural = /jugo natural/i.test(todo);
// ¿forzó acompañamiento? buscamos si tras "así está bien" siguió insistiendo con acompañamientos obligatorios
const ultimo = textos[textos.length-1].toLowerCase();
const avanzo = /total|pago|efectivo|retir|confirm|tomad|listo/.test(ultimo);
console.log('\n¿dice "jugo natural"?', diceNatural?'❌ SÍ (falla)':'✅ NO');
console.log('¿avanzó sin forzar acompañamiento?', avanzo?'✅ SÍ':'⚠️ revisar (último turno no parece avanzar)');
