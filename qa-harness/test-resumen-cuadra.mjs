import { runBotTurn, MENU_FALLBACK } from './lib.mjs';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const turns = [
  'hola',
  'un menú de pollo asado con puré y ensalada, jugo, y agregale otro jugo aparte; otro menú de carne mechada con puré y ensalada, jugo, y papas fritas; y un Pabellón criollo con jugo',
  'eso es todo',
  'para retiro',
  'efectivo',
];
const conv=[]; let i=0; let resumen=null;
for (const u of turns){ const r=await runBotTurn({menu:MENU_FALLBACK,history:conv.slice(),userMessage:u,sesion:i===0?'nueva':'continua'}); conv.push({role:'user',content:u}); conv.push({role:'assistant',content:r.textoVisible}); if(/Total:\s*\$/i.test(r.textoVisible)) resumen=r.textoVisible; i++; }
if(!resumen){ console.log('⚠️ no se mostró resumen con Total'); process.exit(2); }
console.log('=== RESUMEN ===\n'+resumen+'\n');
// parsear: Total = el monto tras "Total:"; líneas = el resto de los $montos
const totalM = resumen.match(/Total:\s*\$?([\d.]+)/i);
const total = totalM ? parseInt(totalM[1].replace(/\./g,'')) : null;
// quitar la línea del Total y extraer montos $ del resto
const sinTotal = resumen.replace(/Total:\s*\$?[\d.]+/i,'');
const montos = [...sinTotal.matchAll(/\$([\d.]+)/g)].map(m=>parseInt(m[1].replace(/\./g,'')));
const suma = montos.reduce((a,b)=>a+b,0);
console.log('líneas con $:', montos.join(' + '), '=', suma);
console.log('Total mostrado:', total);
console.log(suma===total ? '✅ LA SUMA DE LÍNEAS CUADRA CON EL TOTAL' : `❌ NO CUADRA (líneas $${suma} ≠ total $${total}, dif $${total-suma})`);
const diceNatural=/jugo natural/i.test(resumen);
console.log('¿"jugo natural"?', diceNatural?'❌ SÍ':'✅ NO');
