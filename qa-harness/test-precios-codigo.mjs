import { calcularPedido, construirResumen } from '../src/precios.js';
const menu = {
  price_typical: 7000,
  platos_especiales: [{ nombre: 'Pescado frito', precio: 8500 }, { nombre:'Pabellón criollo', precio:9000 }],
  extras_pagados: [{ nombre: 'Papas fritas', precio: 2000 }, { nombre: 'Tostones al ajillo', precio: 2000 }],
};
// Pedido REAL de la 3ª pasada
const items = [
  { proteina: 'Pollo', agregados: ['puré','ensalada'], bebida: 'jugo', extras: ['jugo extra'] },
  { proteina: 'Carne mechada', agregados: ['puré','ensalada'], bebida: 'consomé', extras: ['papas fritas'] },
  { proteina: 'Pescado frito', agregados: [], bebida: 'jugo', extras: [] },
];
const calc = calcularPedido(items, 'delivery', menu, null);
const resumen = construirResumen(calc);
console.log(resumen);
console.log('\n--- checks ---');
console.log('total código:', calc.total, calc.total===27500?'✅ ($27.500)':'❌');
// verificar que la suma de subtotales + delivery == total (cuadre interno)
const sumSub = calc.lineas.reduce((a,l)=>a+l.subtotal,0)+calc.delivery;
console.log('suma subtotales+delivery:', sumSub, sumSub===calc.total?'✅ cuadra':'❌');
// parsear el texto del resumen y verificar que las líneas con $ sumen el total (excl. Total y Subtotal)
const sinTotal = resumen.replace(/\*Total:[^\n]*/,'').replace(/Subtotal:[^\n]*/g,'');
const montos=[...sinTotal.matchAll(/\$([\d.]+)/g)].map(m=>parseInt(m[1].replace(/\./g,'')));
const sumaTexto=montos.reduce((a,b)=>a+b,0);
console.log('suma líneas del TEXTO:', montos.join('+'),'=',sumaTexto, sumaTexto===27500?'✅ cuadra con total':'❌');

// caso simple: 1 menú delivery = 8000
const c2 = calcularPedido([{proteina:'Pollo',agregados:['puré','ensalada'],bebida:'jugo',extras:[]}],'delivery',menu,null);
console.log('\nsimple (1 menú+delivery):', c2.total, c2.total===8000?'✅ ($8.000)':'❌');
// 3er agregado
const c3 = calcularPedido([{proteina:'Pollo',agregados:['puré','arroz','ensalada'],bebida:'jugo',extras:[]}],'local',menu,null);
console.log('3 agregados (3º paga):', c3.total, c3.total===9000?'✅ ($9.000)':'❌');
