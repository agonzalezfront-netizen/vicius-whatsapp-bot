// Smoke test del harness de QA — valida que podemos llamar al bot real
// (mismo system prompt + lógica) SIN WhatsApp. Carga la API key del .env del repo.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

const { setActiveMenu } = await import('../src/active-menu.js');
const { generarRespuesta } = await import('../src/claude.js');

// Menú de prueba representativo (2 proteínas, agregados, extras, 1 especial, bebidas)
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

// menu fallback (solo se usa datos_transferencia cuando hay active menu seteado)
export const MENU_FALLBACK = {
  datos_transferencia: { configurado: false },
  plato_estandar: { precio: 7000, incluye_agregados: 2 },
};

setActiveMenu(MENU_PRUEBA);

console.log('=== SMOKE TEST: ¿conecta el harness con el bot real? ===\n');
console.log('Cliente: "hola"\n');
const r = await generarRespuesta({
  menu: MENU_FALLBACK,
  history: [],
  userMessage: 'hola',
  sesion: 'nueva',
});
console.log('Bot:\n' + r.texto);
console.log('\n=== tokens:', JSON.stringify(r.usage), '===');
