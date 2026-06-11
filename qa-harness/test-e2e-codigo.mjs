// E2E del flujo nuevo: Claude emite {{RESUMEN}} + <<PEDIDO>>; el código (réplica del
// handler) extrae el pedido, calcula y arma el resumen. Verifica que cuadre.
import { generarRespuesta } from '../src/claude.js';
import { extraerPedido } from '../src/handlers.js';
import { calcularPedido, construirResumen } from '../src/precios.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };

const turns = [
  'hola',
  'voy a pedir para 3: un menú de pollo asado con puré y ensalada, jugo, y un jugo extra aparte; un menú de carne mechada con puré y ensalada, consomé, y papas fritas; y un Pabellón criollo con jugo',
  'eso es todo',
  'para retiro',
  'efectivo',
];
const history=[]; let i=0; let render=null;
for (const u of turns){
  const { texto } = await generarRespuesta({ menu: MENU_FALLBACK, history, userMessage: u, sesion: i===0?'nueva':'continua' });
  // réplica del handler:
  const { limpio, pedido } = extraerPedido(texto);
  let visible = limpio;
  if (pedido && visible.includes('{{RESUMEN}}')) {
    const calc = calcularPedido(pedido.items, pedido.tipo, MENU_PRUEBA, MENU_FALLBACK);
    visible = visible.replace(/\{\{RESUMEN\}\}/g, construirResumen(calc));
    render = { visible, calc, pedido };
  }
  visible = visible.replace(/\{\{RESUMEN\}\}/g,'').replace(/\{\{TOTAL\}\}/g,'').replace(/<<CALC>>[\s\S]*?<<FIN>>/g,'').trim();
  history.push({role:'user',content:u}); history.push({role:'assistant',content:visible});
  i++;
}
if(!render){ console.log('⚠️ Claude NO emitió {{RESUMEN}}+<<PEDIDO>> en el flujo'); process.exit(2); }
console.log('=== RESUMEN RENDERIZADO POR CÓDIGO ===\n'+render.visible+'\n');
const total = render.calc.total;
// verificar cuadre del texto
const sinTotalSub = render.visible.replace(/\*Total:[^\n]*/,'').replace(/Subtotal:[^\n]*/g,'');
const montos=[...sinTotalSub.matchAll(/\$([\d.]+)/g)].map(m=>parseInt(m[1].replace(/\./g,'')));
const suma=montos.reduce((a,b)=>a+b,0);
console.log('total (código):', total);
console.log('suma líneas del texto:', suma, suma===total?'✅ CUADRA':'❌ NO CUADRA');
console.log('items:', render.pedido.items.length);
console.log('¿"natural"?', /natural/i.test(render.visible)?'❌':'✅ no');
