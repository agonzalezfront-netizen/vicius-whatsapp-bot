import { generarRespuesta } from '../src/claude.js';
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
const history=[
  {role:'user',content:'hola'},
  {role:'assistant',content:'¡Hola! Este es el menú... 🌟 PLATOS ESPECIALES: Pabellón criollo $9.000, Sopa de gallina $6.500'},
  {role:'user',content:'quiero una sopa de gallina'},
  {role:'assistant',content:'¡Perfecto! Una sopa de gallina. ¿Jugo o consomé? (gratis) Y si querés sumá un acompañamiento (opcional $2.000) — si no, seguimos así.'},
  {role:'user',content:'jugo, así está bien'},
  {role:'assistant',content:'Listo 🙂 Anotado: sopa de gallina con jugo. ¿Cómo seguimos? 1️⃣ otro menú 2️⃣ cambiar/agregar 3️⃣ cerrar'},
  {role:'user',content:'3'},
  {role:'assistant',content:'¿Delivery o retiro?'},
];
const { texto } = await generarRespuesta({ menu: MENU_FALLBACK, history, userMessage: 'retiro, pago en efectivo', sesion: 'continua' });
const m = texto.match(/<<PEDIDO>>([\s\S]*?)<<FIN>>/);
console.log('PEDIDO crudo:', m ? m[1].trim() : '(no emitido)');
