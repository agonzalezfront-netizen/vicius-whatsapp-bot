import { generarRespuesta } from '../src/claude.js';
import { extraerPedido } from '../src/handlers.js';
import { calcularPedido, construirResumen } from '../src/precios.js';
const { setActiveMenu } = await import('../src/active-menu.js');
const MENU_PROD = {
  day_label: 'Jueves 11', day_code: 'J',
  proteinas_dia: [{nombre:'Pescado empanizado',disponible:true},{nombre:'Carne mechada',disponible:true},{nombre:'Pollo',disponible:true},{nombre:'Albóndigas',disponible:true}],
  agregados_incluidos: ['Arroz','Tajadas','Ensalada','Puré'],
  extras_pagados: [{nombre:'Papas fritas',precio:2000},{nombre:'Tostones al ajillo',precio:2000}],
  bebida_incluida: ['Jugo natural','Consomé'],
  platos_especiales: [{nombre:'Pabellón criollo',precio:9000,desc:'Plato completo · viene preparado'},{nombre:'Sopa de gallina',precio:6500,desc:'Solo domingos'}],
  price_typical: 7000, published_at: new Date().toISOString(),
};
setActiveMenu(MENU_PROD);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
const history=[]; let i=0; let render=null;
async function turno(u){ const {texto}=await generarRespuesta({menu:MENU_FALLBACK,history,userMessage:u,sesion:i===0?'nueva':'continua'});
  const {limpio,pedido}=extraerPedido(texto); let visible=limpio;
  if(pedido&&visible.includes('{{RESUMEN}}')){const calc=calcularPedido(pedido.items,pedido.tipo,MENU_PROD,MENU_FALLBACK);visible=visible.replace(/\{\{RESUMEN\}\}/g,construirResumen(calc));render={calc,pedido};}
  visible=visible.replace(/\{\{RESUMEN\}\}/g,'').trim();
  history.push({role:'user',content:u});history.push({role:'assistant',content:visible});i++;return visible;}
await turno('hola');
const t2 = await turno('quiero una sopa de gallina');
const unTurno = /jugo|consom/i.test(t2) && /acompañamiento/i.test(t2);
console.log('pide 2º especial → ¿bebida+acompañamiento en 1 turno?', unTurno?'✅':'❌');
await turno('jugo, así está bien');
await turno('3'); await turno('para retiro'); await turno('efectivo');
if(render){
  const it=render.pedido.items[0];
  console.log('item:', JSON.stringify(it.proteina), /sopa/i.test(it.proteina)?'✅':'❌', '| total:', render.calc.total, render.calc.total===6500?'✅ ($6.500 precio propio)':'❌');
} else console.log('⚠️ sin render');
