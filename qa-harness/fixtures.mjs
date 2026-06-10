// Datos de prueba puros (sin side-effects). Compartidos por el harness y el
// smoke test. Menú representativo del Sazón: 2 proteínas, agregados incluidos,
// 2 extras pagados, 1 especial, bebidas.

export const MENU_PRUEBA = {
  day_label: 'Jueves de prueba',
  day_code: 'J',
  proteinas_dia: [
    { nombre: 'Carne mechada', disponible: true },
    { nombre: 'Pollo asado', disponible: true },
  ],
  agregados_incluidos: ['puré', 'arroz', 'ensalada', 'papas', 'porotos', 'tajadas'],
  extras_pagados: [
    { nombre: 'Papas fritas', precio: 2000 },
    { nombre: 'Tostones al ajillo', precio: 2000 },
  ],
  bebida_incluida: ['Jugo natural', 'Consomé'],
  platos_especiales: [
    { nombre: 'Pabellón criollo', precio: 9000, desc: 'Plato completo, viene preparado' },
  ],
  price_typical: 7000,
  published_at: new Date().toISOString(),
};

// Variante del día CON papa mayo habilitada (para probar que la acepta como
// agregado incluido y el modelo de precios por cantidad).
export const MENU_CON_PAPAMAYO = {
  ...MENU_PRUEBA,
  agregados_incluidos: ['puré', 'arroz', 'ensalada', 'papas', 'porotos', 'tajadas', 'papa mayo'],
  day_label: 'Jueves de prueba (con papa mayo)',
};

export const MENU_FALLBACK = {
  datos_transferencia: { configurado: false },
  plato_estandar: { precio: 7000, incluye_agregados: 2 },
};
