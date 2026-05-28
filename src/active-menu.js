import { randomUUID } from 'node:crypto';

let activeMenu = null;

const VALID_DAY_CODES = new Set(['D', 'L', 'M', 'X', 'J', 'V', 'S']);

const DAY_CODE_TO_NAME = {
  D: 'domingo',
  L: 'lunes',
  M: 'martes',
  X: 'miércoles',
  J: 'jueves',
  V: 'viernes',
  S: 'sábado',
};

export function getActiveMenu() {
  return activeMenu;
}

export function clearActiveMenu() {
  activeMenu = null;
}

export function dayCodeToName(code) {
  return DAY_CODE_TO_NAME[code] ?? null;
}

export function validateMenuPayload(body) {
  const errors = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { valid: false, errors: ['body debe ser un objeto JSON'] };
  }

  if (typeof body.day_label !== 'string' || body.day_label.trim().length === 0) {
    errors.push('day_label debe ser string no vacío');
  }
  if (!VALID_DAY_CODES.has(body.day_code)) {
    errors.push(`day_code debe ser uno de: D L M X J V S (recibido: ${JSON.stringify(body.day_code)})`);
  }
  if (typeof body.protein !== 'string' || body.protein.trim().length === 0) {
    errors.push('protein debe ser string no vacío');
  }
  if (!Array.isArray(body.aggregates)) {
    errors.push('aggregates debe ser array (puede ser vacío)');
  } else if (body.aggregates.length > 2) {
    errors.push(`aggregates máximo 2 elementos (recibidos ${body.aggregates.length})`);
  } else if (body.aggregates.some((a) => typeof a !== 'string')) {
    errors.push('aggregates debe contener solo strings');
  }
  if (!Number.isInteger(body.price_typical) || body.price_typical < 0) {
    errors.push('price_typical debe ser entero >= 0');
  }
  if (!Array.isArray(body.specials)) {
    errors.push('specials debe ser array (puede ser vacío)');
  } else {
    body.specials.forEach((s, i) => {
      if (typeof s !== 'object' || s === null) {
        errors.push(`specials[${i}] debe ser objeto`);
        return;
      }
      if (typeof s.name !== 'string' || s.name.trim().length === 0) {
        errors.push(`specials[${i}].name debe ser string no vacío`);
      }
      if (!Number.isInteger(s.price) || s.price < 0) {
        errors.push(`specials[${i}].price debe ser entero >= 0`);
      }
      if (s.desc !== undefined && typeof s.desc !== 'string') {
        errors.push(`specials[${i}].desc debe ser string si está presente`);
      }
      if (typeof s.active !== 'boolean') {
        errors.push(`specials[${i}].active debe ser boolean`);
      }
    });
  }
  if (typeof body.published_at !== 'string' || isNaN(Date.parse(body.published_at))) {
    errors.push('published_at debe ser ISO 8601 string parseable');
  }

  return { valid: errors.length === 0, errors };
}

export function setActiveMenu(payload) {
  activeMenu = {
    id: `menu_${randomUUID().slice(0, 8)}`,
    day_label: payload.day_label.trim(),
    day_code: payload.day_code,
    day_name: dayCodeToName(payload.day_code),
    protein: payload.protein.trim(),
    aggregates: payload.aggregates.map((a) => a.trim()).filter(Boolean),
    price_typical: payload.price_typical,
    specials: payload.specials.map((s) => ({
      name: s.name.trim(),
      price: s.price,
      desc: (s.desc ?? '').trim(),
      active: s.active,
    })),
    published_at: payload.published_at,
    received_at: new Date().toISOString(),
  };
  return activeMenu;
}

export function renderActiveMenuForPrompt(menu) {
  if (!menu) return null;

  let agregadosStr;
  if (menu.aggregates.length === 0) agregadosStr = 'sin agregados';
  else if (menu.aggregates.length === 1) agregadosStr = `con ${menu.aggregates[0]}`;
  else agregadosStr = `con ${menu.aggregates[0]} y ${menu.aggregates[1]}`;

  const especialesActivos = menu.specials.filter((s) => s.active);
  const especialesStr = especialesActivos.length
    ? especialesActivos
        .map((s) => `- ${s.name}${s.desc ? ` (${s.desc})` : ''} — $${s.price} CLP`)
        .join('\n')
    : '(ninguno hoy)';

  return `MENÚ ACTIVO (publicado ${menu.published_at} desde Menu Manager)
- Día: ${menu.day_label} (${menu.day_name})
- Plato del día: ${menu.protein} ${agregadosStr}
- Precio típico (combo): $${menu.price_typical} CLP = plato del día + jugo natural
- Especiales del día:
${especialesStr}

REGLA PARA EL BOT
Construye la respuesta de saludo usando estos datos exactos del menú activo. Ignora el menú de fallback (config/menu.json).
- Si hay 0 agregados, presenta solo la proteína.
- Si hay 1 agregado, formato singular: "con [agregado]".
- Si hay 2 agregados, formato "con [agregado1] y [agregado2]".
- Si hay especiales activos, los listas DESPUÉS del plato típico con precio aparte.`;
}
