import { generarRespuesta } from '../src/claude.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
// Historial post-entrega real: pedido completo + turno sintético de entrega (como inyecta el handler)
const base = [
  { role: 'user', content: 'hola' },
  { role: 'assistant', content: '¡Hola! Este es el menú de hoy... ¿Qué te gustaría?' },
  { role: 'user', content: 'un menú de pollo asado con puré y ensalada, jugo, para retiro, efectivo' },
  { role: 'assistant', content: 'Perfecto, tu pedido está tomado. ¡Te esperamos!' },
  { role: 'assistant', content: '¡Gracias por pasar a retirar tu pedido! 🙂 Que lo disfrutes.' }, // sintético retirado
];
async function caso(msg){ const {texto}=await generarRespuesta({menu:MENU_FALLBACK,history:base.slice(),userMessage:msg,sesion:'continua',estadoPedido:{id:'ped_x',status:'retirado',total:7000}}); return texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/g,'').trim(); }
// C1: saludo → menú COMPLETO
const c1 = await caso('hola');
const c1menu = /MENÚ DEL DÍA|Proteínas|Carne mechada|Pollo asado/i.test(c1) && /acompañamiento/i.test(c1);
console.log('C1 "hola" post-entrega → ¿menú completo?', c1menu?'✅':'❌', '\n  «'+c1.slice(0,150).replace(/\n/g,' | '));
// C2: gracias → cierre sin menú
const c2 = await caso('gracias, todo muy rico!');
const c2ok = !/Proteínas.*elegí|MENÚ DEL DÍA/is.test(c2) && /gracias|disfrut/i.test(c2);
console.log('\nC2 "gracias" → ¿cierre sin menú?', c2ok?'✅':'❌', '\n  «'+c2.slice(0,120).replace(/\n/g,' | '));
// C3: reclamo → atiende sin menú
const c3 = await caso('me faltó el jugo en el pedido');
const c3ok = !/MENÚ DEL DÍA|Proteínas.*elegí/is.test(c3) && /pareja|consult|avis|solucion|jugo/i.test(c3);
console.log('\nC3 reclamo → ¿atiende sin menú?', c3ok?'✅':'❌', '\n  «'+c3.slice(0,150).replace(/\n/g,' | '));
