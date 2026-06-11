import { generarRespuesta } from '../src/claude.js';
const { setActiveMenu } = await import('../src/active-menu.js');
// EL MENÚ EXACTO de prod ahora (2 especiales)
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
const { texto } = await generarRespuesta({ menu: MENU_FALLBACK, history: [], userMessage: 'hola', sesion: 'nueva' });
const visible = texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/g,'').trim();
console.log(visible);
const tienePabellon = /pabellón/i.test(visible);
const tieneSopa = /sopa de gallina/i.test(visible);
console.log('\n¿Pabellón en el saludo?', tienePabellon?'✅':'❌', '| ¿Sopa de gallina?', tieneSopa?'✅':'❌');
