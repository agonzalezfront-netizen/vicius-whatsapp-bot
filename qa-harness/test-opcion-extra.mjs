import { generarRespuesta } from '../src/claude.js';
import { extraerPedido } from '../src/handlers.js';
import { calcularPedido, construirResumen } from '../src/precios.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
const history=[]; let i=0; let opciones=null; let render=null;
async function turno(u){ const {texto}=await generarRespuesta({menu:MENU_FALLBACK,history,userMessage:u,sesion:i===0?'nueva':'continua'});
  const { limpio, pedido } = extraerPedido(texto);
  let visible=limpio;
  if(pedido && visible.includes('{{RESUMEN}}')){ const calc=calcularPedido(pedido.items,pedido.tipo,MENU_PRUEBA,MENU_FALLBACK); visible=visible.replace(/\{\{RESUMEN\}\}/g,construirResumen(calc)); render={calc,pedido}; }
  visible=visible.replace(/\{\{RESUMEN\}\}/g,'').trim();
  history.push({role:'user',content:u}); history.push({role:'assistant',content:visible}); i++; return visible; }
await turno('hola');
const t2 = await turno('un menú de pollo asado con puré y ensalada, jugo');
const tiene3 = /1️⃣/.test(t2) && /2️⃣/.test(t2) && /3️⃣/.test(t2);
const ofreceExtra = /extra/i.test(t2);
console.log('--- tras 1er menú ---\n'+t2.slice(0,400)+'\n');
console.log('¿3 opciones numeradas?', tiene3?'✅':'❌', '| ¿opción de extra?', ofreceExtra?'✅':'❌');
const t3 = await turno('2');
console.log('--- tras elegir "2" ---\n'+t3.slice(0,300)+'\n');
const listaExtras = /papas fritas/i.test(t3) && /2\.?000/.test(t3);
console.log('¿muestra lista de extras con precio?', listaExtras?'✅':'❌');
const t4 = await turno('papas fritas');
const t5 = await turno('3');
const t6 = await turno('para retiro');
const t7 = await turno('efectivo');
if(render){
  console.log('--- resumen final ---\n'+construirResumen(render.calc));
  const item = render.pedido.items[0];
  const tienePapas = (item.extras||[]).some(e=>/papas/i.test(e));
  console.log('\n¿extra "papas fritas" en el item?', tienePapas?'✅':'❌', '| total:', render.calc.total, render.calc.total===9000?'✅ ($9.000)':'❌');
} else console.log('⚠️ no hubo render del resumen');
