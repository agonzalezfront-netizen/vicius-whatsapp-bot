import { readFileSync } from 'node:fs';

let cached = null;

export function loadMenu(path = process.env.MENU_PATH ?? './config/menu.json') {
  if (cached) return cached;
  const raw = readFileSync(path, 'utf-8');
  cached = JSON.parse(raw);
  return cached;
}

export function renderMenuForPrompt(menu) {
  const platos = menu.platos_fuertes_rotativos
    .map((p) => `- ${p.nombre}: ${p.descripcion} (común: ${p.dias_frecuentes.join(', ')})`)
    .join('\n');
  const agregados = menu.agregados_posibles.join(', ');
  const jugos = menu.jugos_posibles.join(', ');
  const modalidad = menu.modalidad_entrega.join(' o ');
  const pago = menu.pago_actual.join(' o ');

  return `MENÚ ACTUAL
- Plato estándar $${menu.plato_estandar.precio} CLP = ${menu.plato_estandar.descripcion}
- Platos fuertes rotativos:
${platos}
- Agregados disponibles: ${agregados}
- Jugos: ${jugos}
- Entrega: ${modalidad}
- Pago: ${pago}`;
}
