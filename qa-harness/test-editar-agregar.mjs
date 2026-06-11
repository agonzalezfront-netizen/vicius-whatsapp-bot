import { generarRespuesta } from '../src/claude.js';
import { extraerPedido } from '../src/handlers.js';
import { calcularPedido, construirResumen } from '../src/precios.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
function mkConvo(){ const history=[]; let i=0; let render=null;
  return { async turno(u){ const {texto}=await generarRespuesta({menu:MENU_FALLBACK,history,userMessage:u,sesion:i===0?'nueva':'continua'});
    const {limpio,pedido}=extraerPedido(texto); let visible=limpio;
    if(pedido&&visible.includes('{{RESUMEN}}')){const calc=calcularPedido(pedido.items,pedido.tipo,MENU_PRUEBA,MENU_FALLBACK);visible=visible.replace(/\{\{RESUMEN\}\}/g,construirResumen(calc));render={calc,pedido};}
    visible=visible.replace(/\{\{RESUMEN\}\}/g,'').trim();
    history.push({role:'user',content:u});history.push({role:'assistant',content:visible});i++;return visible;},
    get render(){return render;} };
}
// CASO A: sub-flujo opción 2 → desambigua cambiar-vs-agregar
const A=mkConvo(); await A.turno('hola'); await A.turno('un menú de pollo asado con puré y ensalada, jugo');
const a2=await A.turno('2');
const subflujo=/cambiar algo/i.test(a2)&&/agregar un extra/i.test(a2)&&/1️⃣|1\)/.test(a2);
console.log('A) opción 2 → sub-flujo cambiar/agregar:', subflujo?'✅':'❌', '\n   «'+a2.slice(0,180).replace(/\n/g,' | '));
// CASO B: cambiar proteína → el <<PEDIDO>> final refleja el cambio
const B=mkConvo(); await B.turno('hola'); await B.turno('un menú de pollo asado con puré y ensalada, jugo');
await B.turno('mejor carne mechada en vez de pollo'); await B.turno('3'); await B.turno('para retiro'); await B.turno('efectivo');
const bi=B.render?.pedido.items??[];
const cambioProteina=bi.length===1&&/carne/i.test(bi[0].proteina);
console.log('B) cambiar proteína → item final:', JSON.stringify(bi.map(x=>x.proteina)), cambioProteina?'✅':'❌', '| total:', B.render?.calc.total);
// CASO C: quitar ítem → de 2 items queda 1, total recalculado
const C=mkConvo(); await C.turno('hola'); await C.turno('dos menús: uno de pollo asado con puré y ensalada, jugo; y uno de carne mechada con arroz y papas, consomé');
await C.turno('mejor sacá el de carne mechada'); await C.turno('3'); await C.turno('para retiro'); await C.turno('efectivo');
const ci=C.render?.pedido.items??[];
const quito=ci.length===1&&/pollo/i.test(ci[0].proteina)&&C.render?.calc.total===7000;
console.log('C) quitar ítem → items:', JSON.stringify(ci.map(x=>x.proteina)), '| total:', C.render?.calc.total, quito?'✅ ($7.000)':'❌');
