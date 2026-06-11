import { generarRespuesta } from '../src/claude.js';
import { extraerPedido } from '../src/handlers.js';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu({
  day_label: 'Jueves 11', day_code: 'J',
  proteinas_dia: [{nombre:'Pescado empanizado',disponible:true},{nombre:'Carne mechada',disponible:true},{nombre:'Pollo',disponible:true},{nombre:'Albóndigas',disponible:true}],
  agregados_incluidos: ['Arroz','Tajadas','Ensalada','Puré'],
  extras_pagados: [{nombre:'Papas fritas',precio:2000},{nombre:'Tostones al ajillo',precio:2000}],
  bebida_incluida: ['Jugo natural','Consomé'],
  platos_especiales: [{nombre:'Pabellón criollo',precio:9000,desc:'Plato completo · viene preparado'},{nombre:'Sopa de gallina',precio:6500,desc:'Solo domingos'}],
  price_typical: 7000, published_at: new Date().toISOString(),
});
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
const history=[]; let i=0;
async function turno(u){ const {texto}=await generarRespuesta({menu:MENU_FALLBACK,history,userMessage:u,sesion:i===0?'nueva':'continua'});
  const m = texto.match(/<<PEDIDO>>([\s\S]*?)<<FIN>>/);
  if(m) console.log('['+i+'] PEDIDO crudo: '+m[1].trim().slice(0,250));
  const {limpio}=extraerPedido(texto);
  history.push({role:'user',content:u});history.push({role:'assistant',content:limpio.replace(/\{\{RESUMEN\}\}/g,'[RESUMEN]').trim()});i++;}
await turno('hola');
await turno('quiero una sopa de gallina');
await turno('jugo, así está bien');
await turno('3');
await turno('para retiro');
await turno('efectivo');
