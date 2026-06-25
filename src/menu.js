import { readFileSync } from 'node:fs';

let cached = null;

export function loadMenu(path = process.env.MENU_PATH ?? './config/menu.json') {
  if (cached) return cached;
  const raw = readFileSync(path, 'utf-8');
  cached = JSON.parse(raw);
  return cached;
}

export function renderMenuForPrompt(menu) {
  const proteinas = (menu.proteinas_dia ?? [])
    .filter((p) => p.disponible !== false)
    .map((p) => `- ${p.nombre}`)
    .join('\n') || '- (sin proteínas definidas)';
  const incluidos = (menu.agregados_incluidos ?? []).join(', ');
  const extras = (menu.extras_pagados ?? [])
    .map((e) => `${e.nombre} ($${e.precio})`)
    .join(', ') || '(ninguno)';
  const incluyeN = menu.plato_estandar?.incluye_agregados ?? 2;
  const pago = (menu.pago_actual ?? []).join(' o ');

  return `MENÚ ESTÁNDAR (fallback — usar solo si no hay menú del día publicado)
- Un menú $${menu.plato_estandar.precio} CLP = proteína del día + ${incluyeN} agregados a elección + jugo natural.
- Proteínas del día:
${proteinas}
- Agregados incluidos (elige ${incluyeN}): ${incluidos}
- Extras opcionales (se cobran aparte): ${extras}
- Los primeros 2 agregados son gratis (aunque se repitan). Del 3º en adelante, +$${menu.extra_3er_agregado ?? 2000} c/u.
- Pago: ${pago}.`;
}
