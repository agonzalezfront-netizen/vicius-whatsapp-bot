import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const turns = [
  'hola',
  'un menú de carne mechada con puré y ensalada, jugo natural, y un Pabellón criollo con jugo natural',
  'eso es todo',
  'para retiro',
];
const conv = []; let last=null; let i=0;
for (const u of turns) { last = await runBotTurn({ menu: MENU_FALLBACK, history: conv.slice(), userMessage: u, sesion: i===0?'nueva':'continua' }); conv.push({role:'user',content:u}); conv.push({role:'assistant',content:last.textoVisible}); i++; }
console.log('RESUMEN:\n'+last.textoVisible);
const t=last.textoVisible;
const tienePrecioMenu = /7\.?000/.test(t);
const tienePrecioEspecial = /9\.?000|8\.?500/.test(t);
console.log('\n¿muestra precio menú base ($7.000)?', tienePrecioMenu?'✅':'❌');
console.log('¿muestra precio especial?', tienePrecioEspecial?'✅':'❌');
