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

// Acepta dos shapes:
//   - NUEVO: { proteinas_dia: [{nombre, disponible}], agregados_incluidos: [], extras_pagados: [{nombre,precio}] }
//   - VIEJO (Menu Manager actual de Cortex): { protein: "x", aggregates: [], specials: [{name,price,desc,active}] }
// Mantenemos retrocompat hasta que la UI del Menu Manager emita el shape nuevo.
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

  const tieneModeloNuevo = Array.isArray(body.proteinas_dia);
  if (tieneModeloNuevo) {
    const dispo = body.proteinas_dia.filter((p) => p && p.disponible !== false);
    if (dispo.length === 0) errors.push('proteinas_dia debe tener al menos 1 proteína disponible');
    body.proteinas_dia.forEach((p, i) => {
      if (typeof p?.nombre !== 'string' || !p.nombre.trim()) errors.push(`proteinas_dia[${i}].nombre requerido`);
    });
  } else {
    if (typeof body.protein !== 'string' || body.protein.trim().length === 0) {
      errors.push('protein (o proteinas_dia) requerido');
    }
  }

  // agregados: modelo nuevo usa agregados_incluidos; viejo usa aggregates (máx 2 por compat).
  if (body.agregados_incluidos !== undefined && !Array.isArray(body.agregados_incluidos)) {
    errors.push('agregados_incluidos debe ser array');
  }
  if (body.aggregates !== undefined) {
    if (!Array.isArray(body.aggregates)) errors.push('aggregates debe ser array');
    else if (body.aggregates.some((a) => typeof a !== 'string')) errors.push('aggregates debe contener solo strings');
  }

  // extras pagados (modelo nuevo) — opcional pero si viene valida shape.
  if (body.extras_pagados !== undefined) {
    if (!Array.isArray(body.extras_pagados)) errors.push('extras_pagados debe ser array');
    else body.extras_pagados.forEach((e, i) => {
      if (typeof e?.nombre !== 'string' || !e.nombre.trim()) errors.push(`extras_pagados[${i}].nombre requerido`);
      if (!Number.isInteger(e?.precio) || e.precio < 0) errors.push(`extras_pagados[${i}].precio entero >= 0 requerido`);
    });
  }

  // specials (modelo viejo) — opcional, validar si viene.
  if (body.specials !== undefined) {
    if (!Array.isArray(body.specials)) errors.push('specials debe ser array');
    else body.specials.forEach((s, i) => {
      if (typeof s?.name !== 'string' || !s.name.trim()) errors.push(`specials[${i}].name requerido`);
      if (!Number.isInteger(s?.price) || s.price < 0) errors.push(`specials[${i}].price entero >= 0 requerido`);
      if (typeof s?.active !== 'boolean') errors.push(`specials[${i}].active boolean requerido`);
    });
  }

  if (body.price_typical !== undefined && (!Number.isInteger(body.price_typical) || body.price_typical < 0)) {
    errors.push('price_typical debe ser entero >= 0');
  }
  if (typeof body.published_at !== 'string' || isNaN(Date.parse(body.published_at))) {
    errors.push('published_at debe ser ISO 8601 string parseable');
  }

  return { valid: errors.length === 0, errors };
}

export function setActiveMenu(payload) {
  // Normalizar ambos shapes a un modelo interno único.
  const proteinas = Array.isArray(payload.proteinas_dia)
    ? payload.proteinas_dia.map((p) => ({ nombre: p.nombre.trim(), disponible: p.disponible !== false }))
    : [{ nombre: (payload.protein || '').trim(), disponible: true }];

  const incluidos = (payload.agregados_incluidos ?? payload.aggregates ?? [])
    .map((a) => String(a).trim())
    .filter(Boolean);

  // extras: del modelo nuevo (extras_pagados) o derivados de specials activos del viejo.
  let extras = [];
  if (Array.isArray(payload.extras_pagados)) {
    extras = payload.extras_pagados.map((e) => ({ nombre: e.nombre.trim(), precio: e.precio }));
  } else if (Array.isArray(payload.specials)) {
    extras = payload.specials
      .filter((s) => s.active)
      .map((s) => ({ nombre: s.name.trim(), precio: s.price }));
  }

  // Bebida incluida (gratis, el cliente elige 1). Default jugo natural si no viene.
  const bebidas = (Array.isArray(payload.bebida_incluida) && payload.bebida_incluida.length
    ? payload.bebida_incluida
    : ['Jugo natural'])
    .map((b) => String(b).trim())
    .filter(Boolean);

  // Platos especiales (pedido único, precio propio, sin agregados ni bebida).
  const especiales = Array.isArray(payload.platos_especiales)
    ? payload.platos_especiales
        .filter((e) => e && e.nombre)
        .map((e) => ({ nombre: String(e.nombre).trim(), precio: Number(e.precio) || 0, desc: (e.desc ?? '').trim() }))
    : [];

  activeMenu = {
    id: `menu_${randomUUID().slice(0, 8)}`,
    day_label: payload.day_label.trim(),
    day_code: payload.day_code,
    day_name: dayCodeToName(payload.day_code),
    proteinas_dia: proteinas,
    agregados_incluidos: incluidos,
    extras_pagados: extras,
    bebida_incluida: bebidas,
    platos_especiales: especiales,
    price_typical: payload.price_typical ?? 7000,
    published_at: payload.published_at,
    received_at: new Date().toISOString(),
  };
  return activeMenu;
}

export function renderActiveMenuForPrompt(menu) {
  if (!menu) return null;

  const proteinas = menu.proteinas_dia
    .filter((p) => p.disponible !== false)
    .map((p) => `- ${p.nombre}`)
    .join('\n');
  const incluidos = menu.agregados_incluidos.join(', ');
  const extras = (menu.extras_pagados ?? [])
    .map((e) => `${e.nombre} ($${e.precio})`)
    .join(', ') || '(ninguno hoy)';
  const bebidas = (menu.bebida_incluida ?? ['Jugo'])
    .map((b) => String(b).replace(/\s+natural$/i, '').trim()) // "Jugo natural" → "Jugo" (cara al cliente)
    .join(' o ');
  const especiales = (menu.platos_especiales ?? []);
  const especialesStr = especiales.length
    ? especiales.map((e) => `  • ${e.nombre} — $${e.precio}${e.desc ? ` — ${e.desc}` : ''}`).join('\n')
    : null;

  return `MENÚ DEL DÍA (publicado ${menu.published_at} — ${menu.day_label}, ${menu.day_name})
- Un menú $${menu.price_typical} = 1 proteína del día + 2 acompañamientos a elección + 1 jugo o consomé.
- Proteínas de hoy:
${proteinas}
- Acompañamientos incluidos (elegí 2): ${incluidos}
- Jugo o consomé (elegí 1, gratis — nombralo por su nombre, NO "bebida"): ${bebidas}
- Extras opcionales (se cobran aparte): ${extras}
- Los primeros 2 acompañamientos son gratis (aunque se repitan, ej. doble puré = gratis). Del 3º en adelante, +$2.000 c/u.${especialesStr ? `
- PLATOS ESPECIALES (precio propio; incluyen 1 jugo o consomé gratis; los acompañamientos se cobran $2.000 c/u):
${especialesStr}
  🚨 TODOS estos especiales están DISPONIBLES HOY (la dueña los activó para hoy). La descripción entre guiones es texto informativo del catálogo (ej. "Solo domingos" describe su día típico) — NUNCA la uses para negar disponibilidad ni rechazar el pedido: si figura acá, se vende HOY.` : ''}

REGLA PARA EL BOT: usá estos datos exactos del menú del día. Ignorá el menú de fallback.`;
}
