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

// Repertorio = TODO lo que el local ofrece ALGUNA vez (catálogo acumulado en el wizard:
// proteinas/agregados/extras/bebidas/especiales). El menú del día es el subconjunto
// activo hoy. Con el repertorio, "en repertorio pero no hoy" es un universo cerrado →
// el bot puede decir "hoy no tenemos X, otros días sí" sin inventar ni negar que existe.
// Lo guarda setActiveMenu al publicar (viaja dentro del payload del menú).
export function getRepertorio() {
  return activeMenu?.repertorio ?? null;
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
        .map((e) => ({
          nombre: String(e.nombre).trim(), precio: Number(e.precio) || 0, desc: (e.desc ?? '').trim(),
          // Agregados INCLUIDOS en el precio del especial (cupo propio). Cambiar/quitar = gratis;
          // añadir más allá del cupo = $2.000 c/u (lo aplica precios.js). Retrocompat: si falta → [].
          agregados_incluidos: Array.isArray(e.agregados_incluidos)
            ? e.agregados_incluidos.map((x) => String(x).trim()).filter(Boolean) : [],
          // Composición opcional del especial (pieza 1 wizard): [{nombre, reemplazable}]. La pieza 2 la usa
          // para ofrecer sustituir componentes reemplazables por los agregados del día. Retrocompat: [].
          componentes: Array.isArray(e.componentes)
            ? e.componentes.filter((c) => c && c.nombre).map((c) => ({ nombre: String(c.nombre).trim(), reemplazable: !!c.reemplazable })) : [],
        }))
    : [];

  // Repertorio (catálogo completo). Opcional y retrocompatible: si el wizard no lo manda
  // (versión vieja), queda null y el bot opera como antes. Normalizamos nombres a strings.
  let repertorio = null;
  if (payload.repertorio && typeof payload.repertorio === 'object') {
    const r = payload.repertorio;
    const strs = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean) : []);
    const objs = (arr) =>
      Array.isArray(arr)
        ? arr.filter((e) => e && e.nombre).map((e) => ({
            nombre: String(e.nombre).trim(),
            precio: Number(e.precio) || 0,
            ...(e.desc !== undefined ? { desc: String(e.desc ?? '').trim() } : {}),
          }))
        : [];
    repertorio = {
      proteinas: strs(r.proteinas),
      agregados: strs(r.agregados),
      extras: objs(r.extras),
      bebidas: strs(r.bebidas),
      especiales: objs(r.especiales),
    };
  }

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
    repertorio,
  };
  return activeMenu;
}

// Bebidas incluidas REALMENTE disponibles hoy, normalizadas cara al cliente
// ("Jugo natural" → "Jugo"). Fuente de verdad para qué ofrecer/cobrar como
// bebida: el bot NUNCA ofrece una bebida fuera de esta lista (bug 2026-06-15).
export function bebidasCliente(menu) {
  return (Array.isArray(menu?.bebida_incluida) && menu.bebida_incluida.length
    ? menu.bebida_incluida
    : ['Jugo'])
    .map((b) => String(b).replace(/\s+natural$/i, '').trim())
    .filter(Boolean);
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
  const bebidasArr = bebidasCliente(menu); // ["Consomé"] o ["Jugo","Consomé"], ya normalizadas
  const bebidas = bebidasArr.join(' o ');
  const bebidaUnidad = bebidasArr.join(' o '); // "1 ${bebidaUnidad}" → "1 consomé" o "1 jugo o consomé"
  const especiales = (menu.platos_especiales ?? []);
  const especialesStr = especiales.length
    ? especiales.map((e) => {
        const inc = Array.isArray(e.agregados_incluidos) && e.agregados_incluidos.length
          ? ` — viene con: ${e.agregados_incluidos.join(', ')} (cambiar/quitar gratis; agregar más = $2.000 c/u)`
          : '';
        return `  • ${e.nombre} — $${e.precio}${e.desc ? ` — ${e.desc}` : ''}${inc}`;
      }).join('\n')
    : null;

  // Repertorio (otros días): ítems que el local ofrece ALGÚN día pero HOY no están.
  // Permite al bot decir "hoy no tenemos X, otros días sí" sin inventar ni negar que existe.
  const _n = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const rep = menu.repertorio;
  let repertorioStr = null;
  if (rep) {
    const activos = new Set([
      ...menu.proteinas_dia.filter((p) => p.disponible !== false).map((p) => _n(p.nombre)),
      ...(menu.platos_especiales ?? []).map((e) => _n(e.nombre)),
      ...(menu.extras_pagados ?? []).map((e) => _n(e.nombre)),
      ...bebidasArr.map(_n),
      ...menu.agregados_incluidos.map(_n),
    ]);
    const esActivo = (nombre) => {
      const x = _n(nombre);
      return [...activos].some((a) => a && (x.includes(a) || a.includes(x)));
    };
    const noHoy = [
      ...(rep.proteinas ?? []),
      ...(rep.extras ?? []).map((e) => e?.nombre),
      ...(rep.especiales ?? []).map((e) => e?.nombre),
      ...(rep.bebidas ?? []).map((b) => String(b).replace(/\s+natural$/i, '').trim()),
    ].filter((nombre) => nombre && !esActivo(nombre));
    // dedup por nombre normalizado
    const vistos = new Set();
    const noHoyUniq = noHoy.filter((nm) => { const k = _n(nm); if (vistos.has(k)) return false; vistos.add(k); return true; });
    if (noHoyUniq.length) repertorioStr = noHoyUniq.join(', ');
  }

  return `MENÚ DEL DÍA (publicado ${menu.published_at} — ${menu.day_label}, ${menu.day_name})
- Un menú $${menu.price_typical} = 1 proteína del día + 2 acompañamientos a elección + 1 ${bebidaUnidad}.
- Proteínas de hoy:
${proteinas}
- Acompañamientos incluidos (elige 2): ${incluidos}
- Bebida incluida (elige 1, gratis — nombrala por su nombre, NO "bebida"): ${bebidas}
  🚨 BEBIDAS DISPONIBLES HOY (fuente de verdad): SOLO ${bebidas}. Esta lista —no el título genérico "jugo o consomé"— manda. Si el cliente pide una bebida que NO está aquí (ej. pide "jugo" y hoy solo hay consomé), respondé "hoy no tenemos jugo, solo ${bebidas} 🙂": NO la ofrezcas, NO la agregues al carrito, NO inventes precio (ni gratis ni $2.000 de extra). La bebida extra de $2.000 SOLO aplica a bebidas que SÍ están en esta lista.
- Extras opcionales (se cobran aparte): ${extras}
- Los primeros 2 acompañamientos son gratis (aunque se repitan, ej. doble puré = gratis). Del 3º en adelante, +$2.000 c/u.${especialesStr ? `
- PLATOS ESPECIALES (precio propio; incluyen 1 ${bebidaUnidad} gratis; los acompañamientos se cobran $2.000 c/u):
${especialesStr}
  🚨 TODOS estos especiales están DISPONIBLES HOY (la dueña los activó para hoy). La descripción entre guiones es texto informativo del catálogo (ej. "Solo domingos" describe su día típico) — NUNCA la uses para negar disponibilidad ni rechazar el pedido: si figura aquí, se vende HOY.` : ''}${repertorioStr ? `
- REPERTORIO (el local los ofrece OTROS días, HOY NO están): ${repertorioStr}
  🚨 Estos ítems EXISTEN pero HOY NO se venden. Si el cliente pide uno, NO lo ofrezcas como disponible hoy y NO lo agregues al pedido. Declinalo así: "hoy no tenemos [ítem], pero otros días sí 🙂" e INMEDIATAMENTE listá TODAS las opciones que SÍ hay hoy (todas las proteínas del día + especiales si hay), no una sola — ej: "hoy tenemos ${proteinas.replace(/^- /gm, '').split('\n').join(', ')}". Que el cliente vea el abanico completo del día. Tampoco digas que "no existe" (sí existe, otro día). Solo HOY no.` : ''}

REGLA PARA EL BOT: usa estos datos exactos del menú del día. Ignorá el menú de fallback.`;
}
