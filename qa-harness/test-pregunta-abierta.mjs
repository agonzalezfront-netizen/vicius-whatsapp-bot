import { generarRespuesta } from '../src/claude.js';
import { extraerPedido } from '../src/handlers.js';
import { calcularPedido, construirResumen } from '../src/precios.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
const history=[]; let i=0; let render=null;
async function turno(u){ const {texto}=await generarRespuesta({menu:MENU_FALLBACK,history,userMessage:u,sesion:i===0?'nueva':'continua'});
  const {limpio,pedido}=extraerPedido(texto); let visible=limpio;
  if(pedido&&visible.includes('{{RESUMEN}}')){const calc=calcularPedido(pedido.items,pedido.tipo,MENU_PRUEBA,MENU_FALLBACK);visible=visible.replace(/\{\{RESUMEN\}\}/g,construirResumen(calc));render={calc,pedido};}
  visible=visible.replace(/\{\{RESUMEN\}\}/g,'').trim();
  history.push({role:'user',content:u});history.push({role:'assistant',content:visible});i++;return visible;}
await turno('hola');
await turno('un menú de pollo asado con puré y ensalada, jugo');
const t2 = await turno('2');
const abierta = /qué te gustaría cambiar o agregar/i.test(t2);
const pista = /papas fritas/i.test(t2) && /2\.?000/.test(t2);
const sinSubmenu = !/1️⃣.*cambiar algo/is.test(t2);
console.log('--- al elegir "2" ---\n'+t2+'\n');
console.log('¿pregunta abierta?', abierta?'✅':'❌', '| ¿pista extras+precio?', pista?'✅':'❌', '| ¿SIN sub-menú?', sinSubmenu?'✅':'❌');
// EL CASO LITERAL DE ALBERTO: compuesto en un solo mensaje
const t3 = await turno('quiero cambiar el jugo por consomé, y añádeme un jugo extra y papas fritas');
console.log('--- respuesta al compuesto ---\n'+t3.slice(0,350)+'\n');
const confirmaTodo = /consom/i.test(t3) && /jugo extra/i.test(t3) && /papas/i.test(t3);
console.log('¿confirma las 3 cosas en un mensaje?', confirmaTodo?'✅':'❌');
await turno('3'); await turno('para retiro'); await turno('efectivo');
if(render){
  const it = render.pedido.items[0];
  console.log('--- pedido final ---');
  console.log('bebida:', JSON.stringify(it.bebida), /consom/i.test(it.bebida||'')?'✅ (cambiada)':'❌');
  console.log('extras:', JSON.stringify(it.extras));
  const tieneJugoExtra = (it.extras||[]).some(e=>/jugo/i.test(e));
  const tienePapas = (it.extras||[]).some(e=>/papas/i.test(e));
  console.log('¿jugo extra + papas en extras?', tieneJugoExtra&&tienePapas?'✅':'❌');
  console.log('total:', render.calc.total, render.calc.total===11000?'✅ ($11.000 = 7000+2000+2000)':'❌');
} else console.log('⚠️ sin render final');
