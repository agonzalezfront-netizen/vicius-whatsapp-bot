// Tier básico (MODE=buttons) — máquina de estados DETERMINISTA del pedido por botones, SIN LLM.
// (Encargo Alberto 2026-06-28; diseño aprobado en a-cortex/vicius/2026-06-28-DISENO-arbol-botones-tier-basico.md)
//
// 🔑 PURA y AISLADA: `procesar(estado, input, menu)` → { estado, salidas, pedido? }. No toca red, ni
// WhatsApp, ni el flujo LLM de producción. La capa de transporte traduce las `salidas` abstractas a
// sendButtons/sendList; la capa de persistencia guarda/carga `estado` por jid. Así es testeable 100%
// sin tokens (innegociable #5) y el premium con IA queda intacto (innegociable #1).
//
// input  = { tipo: 'button'|'list'|'text', id?, texto? }   (id = el id del botón/fila; texto = libre)
// salida = { tipo:'text', text } | { tipo:'buttons', text, buttons:[{id,title}] (≤3) }
//        | { tipo:'list', text, button, sections:[{title, rows:[{id,title,description?}] }] (≤10 filas) }
// pedido = objeto listo para crearPedido (cuando paso === FIN).
import { calcularPedido, construirResumen } from './precios.js';

export const PASOS = Object.freeze({
  PROTEINA: 'PROTEINA', ACOMP_ASK: 'ACOMP_ASK', ACOMP: 'ACOMP', BEBIDA: 'BEBIDA', EXTRAS: 'EXTRAS',
  MAS_MENUS: 'MAS_MENUS', MODALIDAD: 'MODALIDAD', DIRECCION: 'DIRECCION',
  CONFIRMA_DIR: 'CONFIRMA_DIR', PAGO: 'PAGO', CONFIRMAR: 'CONFIRMAR',
  // Edición granular del pedido (pieza 2 FASE A): desde el resumen, editar un plato sin re-armarlo.
  EDIT_PICK: 'EDIT_PICK', EDIT_ITEM: 'EDIT_ITEM', EDIT_ACOMP_FROM: 'EDIT_ACOMP_FROM',
  EDIT_ACOMP_TO: 'EDIT_ACOMP_TO', EDIT_BEBIDA: 'EDIT_BEBIDA',
  EDIT_COMP_FROM: 'EDIT_COMP_FROM', EDIT_COMP_TO: 'EDIT_COMP_TO',
  EDIT_ESPECIAL_TXT: 'EDIT_ESPECIAL_TXT', RESET_CONFIRM: 'RESET_CONFIRM',
  FIN: 'FIN',
});

const MAX_ROWS = 10;     // límite de filas por list message (WhatsApp)
const MAX_ACOMP = 6;     // tope anti-loop del multi-select de acompañamientos
const MAX_ITEMS = 10;    // tope de menús por pedido

// ── helpers de menú ──────────────────────────────────────────────────────────
const proteinasDisponibles = (menu) => (menu?.proteinas_dia ?? []).filter((p) => p?.disponible !== false);
const especiales = (menu) => menu?.platos_especiales ?? [];
const acompañamientos = (menu) => menu?.agregados_incluidos ?? [];
const bebidas = (menu) => menu?.bebida_incluida ?? [];
const extras = (menu) => menu?.extras_pagados ?? [];
const clp = (n) => '$' + Number(n).toLocaleString('es-CL');

// Lista paginada genérica: si los items superan MAX_ROWS, reserva la última fila para "▶ Ver más"
// (id = `${idPrefix}:more:<offset>`). Devuelve las filas de ESTA página.
function pagedRows(items, idPrefix, offset = 0, mapRow) {
  const cap = items.length > MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS;
  const page = items.slice(offset, offset + cap);
  const rows = page.map((it, i) => mapRow(it, offset + i));
  if (offset + cap < items.length) rows.push({ id: `${idPrefix}:more:${offset + cap}`, title: '▶ Ver más' });
  return rows;
}

// ── estado inicial ───────────────────────────────────────────────────────────
export function estadoInicial() {
  return { paso: PASOS.PROTEINA, items: [], actual: nuevoItem(), tipo: null, direccion: null, metodo_pago: null, intentos: 0, editIdx: null, editAcompIdx: null, editCompIdx: null, solicitud: null, editReturn: null };
}
function nuevoItem() { return { proteina: null, esEspecial: false, agregados: [], bebida: null, extras: [], componentes: [] }; }

// ── render por paso (salidas abstractas) ─────────────────────────────────────
function renderProteina(menu, offset = 0) {
  const dia = proteinasDisponibles(menu).map((p) => ({ k: 'd', nombre: p.nombre }));
  const esp = especiales(menu).map((e) => ({ k: 'e', nombre: e.nombre, precio: e.precio }));
  const todos = [...dia, ...esp];
  const rows = pagedRows(todos, 'prot', offset, (it, idx) =>
    it.k === 'e'
      ? { id: `prot:${idx}`, title: it.nombre.slice(0, 24), description: `Especial ${clp(it.precio)}` }
      : { id: `prot:${idx}`, title: it.nombre.slice(0, 24) });
  return { tipo: 'list', text: '¿Qué plato quieres? 🍽️', button: 'Ver platos',
    sections: [{ title: 'Menú del día', rows }] };
}
function renderAcomp(menu, actual) {
  const ac = acompañamientos(menu);
  const n = actual.agregados.length;
  const cupo = cupoIncluidos(actual, menu); // estándar=2, especial=su cupo (Pabellón=0 → todos pagan)
  const rows = pagedRows(ac, 'ac', 0, (nombre, idx) => ({ id: `ac:${idx}`, title: String(nombre).slice(0, 24) }));
  // Regla de precio dinámica EN EL TEXTO (ajuste UX QA 2026-06-29): el "+$2.000" SOLO aparece cuando ya no
  // quedan incluidos gratis (n >= cupo). Mientras haya gratis → mostrar cuántos quedan, SIN mencionar el costo
  // (evita que el cliente crea que ya le cobran). Especial (cupo 0): no hay gratis → "cada uno $2.000" desde
  // el inicio (fix BUG4 intacto). Listamos las opciones en el texto, antes de la lista interactiva.
  let regla;
  if (cupo === 0) regla = `cada uno ${clp(2000)}`;
  else if (n >= cupo) regla = `el siguiente suma ${clp(2000)}`;
  else { const restan = cupo - n; regla = `te queda${restan === 1 ? '' : 'n'} ${restan} gratis`; }
  const lista = ac.length ? '\n' + ac.map((nombre) => `· ${nombre}`).join('\n') : '';
  const titulo = cupo > 0 ? `${cupo} incluidos gratis` : `Cada uno ${clp(2000)}`;
  return { tipo: 'list', text: `Elige un acompañamiento (${regla}). Llevas ${n}.${lista}`, button: 'Acompañamientos',
    sections: [{ title: titulo, rows }] };
}
// Cupo de acompañamientos INCLUIDOS (gratis) del ítem actual: estándar = 2; especial = su cupo propio.
function cupoIncluidos(actual, menu) {
  // H4/B1 (2026-06-30): el ESPECIAL nunca tiene cupo de "elegí N gratis del día" — su composición es FIJA
  // (vive en `componentes`, materializada al elegirlo). Siempre 0 → va a ACOMP_ASK (acompañamiento EXTRA
  // opcional y PAGADO). Solo el menú del DÍA tiene 2 incluidos a elegir de la lista.
  if (actual?.esEspecial) return 0;
  return 2;
}
// Aviso del costo EN EL PUNTO DE DECISIÓN (mejora QA 2026-06-29): si ya superó el cupo, el próximo paga.
function botonesAcompMas(n, cupo = 2) {
  const proxPaga = n >= cupo;
  const aviso = proxPaga ? ` (el siguiente suma ${clp(2000)})` : '';
  const tituloOtro = proxPaga ? '➕ Otro +$2.000' : '➕ Otro';
  return { tipo: 'buttons', text: `Llevas ${n} acompañamiento(s). ¿Agregar otro?${aviso}`,
    buttons: [{ id: 'ac_mas', title: tituloOtro.slice(0, 20) }, { id: 'ac_listo', title: '✅ Listo' }] };
}
// Pregunta opcional (ajuste UX QA 2026-06-29): SOLO para especiales (cupo 0). Sus acompañamientos son
// opcionales y pagos (el plato viene preparado) → preguntar antes de forzar la lista, como con los extras.
function botonesAcompAsk() {
  return { tipo: 'buttons', text: `¿Querés agregar acompañamientos? (cada uno ${clp(2000)})`,
    buttons: [{ id: 'acask_si', title: '✅ Sí, agregar' }, { id: 'acask_no', title: 'No, seguir' }] };
}
function renderBebida(menu) {
  const bs = bebidas(menu);
  const btns = bs.slice(0, 2).map((b, i) => ({ id: `beb:${i}`, title: String(b).slice(0, 20) }));
  btns.push({ id: 'beb_no', title: 'Sin bebida' });
  return { tipo: 'buttons', text: '¿Qué bebida? (incluida) 🥤', buttons: btns.slice(0, 3) };
}
// Paso de extras — selección DIRECTA según cantidad, sin iteración intermedia (UX QA 2026-06-29 §item1):
// 0 extras → el caller saltea el paso; 1-2 → reply buttons directos (extra(s) + "No, seguir"); ≥3 → List
// "Ver extras" (extras + "No, seguir" como última fila). El cliente toca el extra al toque, sin abrir una
// 2ª lista. Devuelve null si no quedan extras por ofrecer (→ el caller avanza). Los ids usan el índice
// ORIGINAL del menú (precios.js los matchea por índice).
function extrasDisponibles(menu, actual) {
  const tomados = new Set(actual?.extras ?? []);
  return extras(menu).map((e, idx) => ({ ...e, idx })).filter((e) => !tomados.has(e.nombre));
}
function renderExtras(menu, actual) {
  const rem = extrasDisponibles(menu, actual);
  if (!rem.length) return null; // nada que ofrecer → avanzar
  const yaTiene = (actual?.extras ?? []).length > 0;
  const txt = yaTiene ? '¿Otro extra?' : '¿Querés agregar un extra? (opcional)';
  const salir = { id: 'ex_no', title: yaTiene ? '✅ Listo' : 'No, seguir' };
  if (rem.length <= 2) {
    const btns = rem.map((e) => ({ id: `ex:${e.idx}`, title: `${e.nombre} ${clp(e.precio)}`.slice(0, 20) }));
    btns.push(salir);
    return { tipo: 'buttons', text: txt, buttons: btns.slice(0, 3) };
  }
  const rows = rem.slice(0, 9).map((e) => ({ id: `ex:${e.idx}`, title: String(e.nombre).slice(0, 24), description: clp(e.precio) }));
  rows.push({ id: 'ex_no', title: salir.title });
  return { tipo: 'list', text: txt, button: 'Ver extras', sections: [{ title: 'Extras pagados', rows }] };
}
// Entra al paso de extras (o lo saltea si el menú no tiene extras).
function entrarExtras(e, menu) {
  e.paso = PASOS.EXTRAS;
  const r = renderExtras(menu, e.actual);
  return r ? { estado: e, salidas: [r] } : avanzarTrasExtras(e, menu);
}
// Cierra el ítem actual y va a "¿otro menú o seguir?" (o modalidad si llegó al tope de ítems).
function avanzarTrasExtras(e, menu) {
  e.items.push(e.actual); e.actual = nuevoItem();
  if (e.items.length >= MAX_ITEMS) { e.paso = PASOS.MODALIDAD; return { estado: e, salidas: [botonesModalidad()] }; }
  e.paso = PASOS.MAS_MENUS; return { estado: e, salidas: [renderMasMenus(e, menu)] };
}
// Paso "¿otro menú o seguir?" con RESUMEN PARCIAL + Editar (UX 2026-06-29 §7): muestra lo que lleva + total
// parcial, y deja editar (reusa EDIT_PICK de la Fase A) antes de avanzar. 3 botones (cabe en reply buttons).
function renderMasMenus(e, menu) {
  const calc = calcularPedido(e.items, e.tipo, menu, null);
  return { tipo: 'buttons', text: `${construirResumen(calc)}\n\n¿Agregar otro menú, editar, o seguir?`,
    buttons: [{ id: 'mm_otro', title: '➕ Otro menú' }, { id: 'mm_editar', title: '✏️ Editar' }, { id: 'mm_seguir', title: '✅ Seguir' }] };
}
function botonesModalidad() {
  return { tipo: 'buttons', text: '¿Cómo lo quieres?',
    buttons: [{ id: 'mod_delivery', title: '🛵 Delivery' }, { id: 'mod_local', title: '🏠 Retiro local' }] };
}
// Confirmación de dirección (mejora UX 2026-06-29-B): la dirección es el único texto libre y no hay IA
// para validarla → un "last chance" explícito baja errores de entrega. Recuerda el nº de depto.
function confirmarDireccion(dir) {
  return { tipo: 'buttons',
    text: `Anoté: *${dir}*. ¿Es correcta? 📍 Si es *departamento*, asegurate de incluir el número de depto.`,
    buttons: [{ id: 'dir_ok', title: '✅ Confirmar' }, { id: 'dir_fix', title: '✏️ Corregir' }] };
}
function botonesPago(tipo) {
  const presencial = tipo === 'local'
    ? { id: 'pay_local', title: 'En el local' }
    : { id: 'pay_efectivo', title: 'Efectivo' };
  return { tipo: 'buttons', text: '¿Cómo pagas?', buttons: [presencial, { id: 'pay_transfer', title: 'Transferencia' }] };
}
function renderResumen(estado, menu) {
  const calc = calcularPedido(estado.items, estado.tipo, menu, null);
  const sol = estado.solicitud;
  const dirTxt = estado.tipo === 'delivery' && estado.direccion ? `\n\n🛵 ${estado.direccion}` : '';
  // Solicitud fuera-de-carta PENDIENTE (UX 2026-06-29 §8): "esperar" es el default (va en TEXTO, no botón) y
  // NO hay "¿Confirmamos?" (no se puede confirmar con el costo pendiente). Botones = SOLO acciones reales.
  // El [✅ Confirmar] aparece DESPUÉS, cuando el local resuelve (panel B-3) y el bot re-emite el resumen.
  if (sol && sol.status === 'pendiente') {
    const txt = construirResumen(calc) + dirTxt
      + `\n\n⏳ Tu pedido especial ("${sol.descripcion}") quedó pendiente: el local lo revisa y te confirma el costo en un momento. Te aviso apenas esté. Mientras, podés agregar otro plato, editar, o seguir sin ese ajuste.`;
    return { calc, salida: { tipo: 'buttons', text: txt, buttons: [
      { id: 'mm_otro', title: '➕ Otro menú' },
      { id: 'conf_editar', title: '✏️ Editar' },
      { id: 'conf_sin_ajuste', title: '🗑️ Sin el especial' },
    ] } };
  }
  // Solicitud APLICADA → suma al total. Sin solicitud → resumen normal.
  const extrasPedido = (sol && sol.status === 'aplicado') ? [{ nombre: `🙋 ${sol.descripcion}`, costo: Number(sol.costo) || 0 }] : [];
  const txt = construirResumen(calc, extrasPedido) + dirTxt;
  return { calc, salida: { tipo: 'buttons', text: txt + '\n\n¿Confirmamos?', buttons: [
    { id: 'conf_si', title: '✅ Confirmar' }, { id: 'conf_editar', title: '✏️ Editar' }, { id: 'conf_reset', title: '🔄 Empezar de nuevo' },
  ] } };
}

// El flujo de edición (Fase A) se entra desde el resumen final (CONFIRMAR) o desde "¿otro menú?" (MAS_MENUS,
// §7). Al volver, regresa al PUNTO DE ENTRADA — no siempre a CONFIRMAR (eso saltaría modalidad/pago). El
// origen vive en estado.editReturn; este helper setea el paso destino, limpia el flag y arma la salida.
function vuelveEdicion(e, menu, textoPrefijo) {
  const aMasMenus = e.editReturn === PASOS.MAS_MENUS;
  e.editReturn = null;
  e.paso = aMasMenus ? PASOS.MAS_MENUS : PASOS.CONFIRMAR;
  const salida = aMasMenus ? renderMasMenus(e, menu) : renderResumen(e, menu).salida;
  return { estado: e, salidas: textoPrefijo ? [{ tipo: 'text', text: textoPrefijo }, salida] : [salida] };
}

// ── edición granular (pieza 2 FASE A): editar un plato del pedido sin re-armarlo ────────────────
// Filas paginadas + una fila final "↩ Volver" (respeta el tope de 10 filas de WhatsApp, gap 2 §6).
function rowsConVolver(items, prefix, offset, mapRow, volverId, volverTitle) {
  const cap = items.length > 9 ? 8 : 9; // 1 fila reservada para Volver (+1 para "Ver más" si pagina)
  const page = items.slice(offset, offset + cap);
  const rows = page.map((it, i) => mapRow(it, offset + i));
  if (offset + cap < items.length) rows.push({ id: `${prefix}:more:${offset + cap}`, title: '▶ Ver más' });
  rows.push({ id: volverId, title: volverTitle });
  return rows;
}
const nombreItem = (it) => it?.proteina || 'Plato';
function renderEditPick(estado, offset = 0) {
  const rows = rowsConVolver(estado.items, 'ep', offset,
    (it, idx) => {
      const det = [...(it.agregados || []), it.bebida].filter(Boolean).join(', ');
      return { id: `ep:${idx}`, title: nombreItem(it).slice(0, 24), ...(det ? { description: det.slice(0, 72) } : {}) };
    }, 'ep_volver', '↩ Volver');
  return { tipo: 'list', text: '¿Qué plato querés editar?', button: 'Editar plato', sections: [{ title: 'Tus platos', rows }] };
}
function renderEditItem(estado, menu) {
  const it = estado.items[estado.editIdx];
  const rows = [];
  if (it && (it.componentes || []).some((c) => c.reemplazable)) rows.push({ id: 'ei_comp', title: '🧩 Cambiar componente' });
  if (it && (it.agregados || []).length) rows.push({ id: 'ei_acomp', title: '🍽 Cambiar acompañamiento' });
  if (bebidas(menu).length) rows.push({ id: 'ei_bebida', title: '🥤 Cambiar bebida' });
  rows.push({ id: 'ei_especial', title: '🙋 Pedir algo especial' });
  rows.push({ id: 'ei_quitar', title: '🗑 Quitar este plato' });
  rows.push({ id: 'ei_volver', title: '↩ Volver' });
  return { tipo: 'list', text: `Editar: *${nombreItem(it)}*. ¿Qué cambiás?`, button: 'Opciones', sections: [{ title: 'Editar plato', rows }] };
}
// Sustitución de COMPONENTES del especial componible (pieza 2). Opciones del día = acompañamientos (gratis)
// + extras pagados (con su precio). Se reconstruye igual en render y handler → el índice es estable.
function opcionesComponente(menu) {
  const acs = acompañamientos(menu).map((n) => ({ nombre: String(n), costo: 0 }));
  const exs = extras(menu).map((e) => ({ nombre: e.nombre, costo: Number(e.precio) || 0 }));
  return [...acs, ...exs];
}
function renderEditCompFrom(estado) {
  const it = estado.items[estado.editIdx];
  const comps = (it.componentes || []);
  // Solo los reemplazables; el id lleva el índice REAL dentro de it.componentes.
  const reemplazables = comps.map((c, i) => ({ c, i })).filter((x) => x.c.reemplazable);
  const rows = rowsConVolver(reemplazables, 'ecf', 0,
    (x) => ({ id: `ecf:${x.i}`, title: String(x.c.nombre).slice(0, 24) }), 'ecf_volver', '↩ Volver');
  return { tipo: 'list', text: '¿Qué componente cambiás?', button: 'Componentes', sections: [{ title: 'Reemplazables', rows }] };
}
function renderEditCompTo(estado, menu, offset = 0) {
  const opts = opcionesComponente(menu);
  const rows = rowsConVolver(opts, 'ect', offset,
    (o, idx) => ({ id: `ect:${idx}`, title: (o.costo ? `${o.nombre} +${clp(o.costo)}` : o.nombre).slice(0, 24) }), 'ect_volver', '↩ Volver');
  return { tipo: 'list', text: '¿Por cuál lo cambiás? (los pagados suman su precio)', button: 'Opciones', sections: [{ title: 'Del día', rows }] };
}
function renderEditAcompFrom(estado) {
  const it = estado.items[estado.editIdx];
  const rows = rowsConVolver(it.agregados || [], 'eaf', 0,
    (nombre, idx) => ({ id: `eaf:${idx}`, title: String(nombre).slice(0, 24) }), 'eaf_volver', '↩ Volver');
  return { tipo: 'list', text: '¿Cuál acompañamiento cambiás?', button: 'Acompañamientos', sections: [{ title: 'Actuales', rows }] };
}
function renderEditAcompTo(estado, menu, offset = 0) {
  const it = estado.items[estado.editIdx];
  const cupo = cupoIncluidos(it, menu);
  const usados = (it.agregados || []).length;
  // El reemplazo paga si la posición editada cae fuera del cupo incluido (regla de costo existente).
  const pagaAviso = usados > cupo ? ` (los que exceden ${cupo} incluidos suman ${clp(2000)} c/u)` : '';
  const rows = rowsConVolver(acompañamientos(menu), 'eat', offset,
    (nombre, idx) => ({ id: `eat:${idx}`, title: String(nombre).slice(0, 24) }), 'eat_volver', '↩ Volver');
  return { tipo: 'list', text: `¿Por cuál lo cambiás?${pagaAviso}`, button: 'Acompañamientos', sections: [{ title: 'Del día', rows }] };
}
function botonesResetConfirm() {
  return { tipo: 'buttons', text: '¿Seguro que querés empezar de nuevo? Perdés el pedido armado.',
    buttons: [{ id: 'reset_si', title: '🔄 Sí, de nuevo' }, { id: 'reset_no', title: '↩ No, volver' }] };
}

// ── pedido final (formato crearPedido) ───────────────────────────────────────
function armarPedido(estado, menu) {
  const calc = calcularPedido(estado.items, estado.tipo, menu, null);
  // Ajuste fuera-de-carta APLICADO por el local (pieza 2 FASE B): suma al total y viaja al board.
  const sol = estado.solicitud;
  const ajuste = (sol && sol.status === 'aplicado') ? { descripcion: sol.descripcion, costo: Number(sol.costo) || 0, plato: sol.plato } : null;
  return {
    items: estado.items,
    total: calc.total + (ajuste ? ajuste.costo : 0),
    desglose: calc,
    ...(ajuste ? { ajuste_especial: ajuste } : {}),
    metodo_pago: estado.metodo_pago,
    tipo: estado.tipo,
    direccion: estado.direccion,
    status: estado.metodo_pago === 'transferencia' ? 'esperando_comprobante' : 'en_cocina',
  };
}

// ── MATCH DE TEXTO (mejora 2026-06-28): el cliente puede ESCRIBIR el nombre en vez de tocar ──
// Sin IA: normaliza (minúsculas, sin tildes) y matchea el texto contra las opciones del paso actual.
// Devuelve el id equivalente (como si hubiera tocado) o null si no reconoce.
const _norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
function _matchNombre(texto, nombre) {
  const t = _norm(texto), n = _norm(nombre);
  if (!t || !n) return false;
  return t === n || t.includes(n) || n.includes(t);
}
// Busca el texto en una lista de nombres → índice o -1.
function _idxEnLista(texto, nombres) {
  return (nombres ?? []).findIndex((n) => _matchNombre(texto, n));
}
function _algunaPalabra(texto, palabras) {
  const t = _norm(texto);
  return palabras.some((p) => t.includes(p));
}

export function matchTexto(paso, texto, menu) {
  const t = _norm(texto);
  if (!t) return null;
  switch (paso) {
    case PASOS.PROTEINA: {
      const todos = [...proteinasDisponibles(menu).map((p) => p.nombre), ...especiales(menu).map((e) => e.nombre)];
      const i = _idxEnLista(texto, todos);
      return i >= 0 ? `prot:${i}` : null;
    }
    case PASOS.ACOMP_ASK: {
      // Orden: chequear NO primero ("sin" contiene "si") para no confundir.
      if (_algunaPalabra(t, ['no', 'seguir', 'sin', 'nada', 'asi esta', 'así esta', 'listo', 'continuar', 'paso'])) return 'acask_no';
      if (_algunaPalabra(t, ['si', 'sí', 'agregar', 'dale', 'quiero', 'ok', 'bueno', 'sumar', 'agrega'])) return 'acask_si';
      return null;
    }
    case PASOS.ACOMP: {
      if (_algunaPalabra(t, ['listo', 'nada mas', 'nada más', 'ya esta', 'eso es todo', 'asi esta'])) return 'ac_listo';
      if (_algunaPalabra(t, ['otro', 'agregar', 'mas', 'más', 'sumar'])) return 'ac_mas';
      const i = _idxEnLista(texto, acompañamientos(menu));
      return i >= 0 ? `ac:${i}` : null;
    }
    case PASOS.BEBIDA: {
      if (_algunaPalabra(t, ['sin', 'no quiero', 'ninguna', 'nada'])) return 'beb_no';
      const i = _idxEnLista(texto, bebidas(menu));
      return i >= 0 ? `beb:${i}` : null;
    }
    case PASOS.EXTRAS: {
      const i = _idxEnLista(texto, extras(menu).map((e) => e.nombre));
      if (i >= 0) return `ex:${i}`;
      if (_algunaPalabra(t, ['listo', 'ninguno', 'no', 'nada', 'seguir', 'eso es todo'])) return 'ex_no';
      return null; // los extras se eligen por su nombre (botones directos); ya no hay "agregar" genérico
    }
    case PASOS.MAS_MENUS: {
      if (_algunaPalabra(t, ['otro', 'agregar', 'mas', 'más', 'sumar'])) return 'mm_otro';
      if (_algunaPalabra(t, ['editar', 'cambiar', 'corregir', 'modificar'])) return 'mm_editar';
      if (_algunaPalabra(t, ['seguir', 'no', 'listo', 'eso es todo', 'nada mas', 'continuar'])) return 'mm_seguir';
      return null;
    }
    case PASOS.MODALIDAD: {
      if (_algunaPalabra(t, ['delivery', 'despacho', 'envio', 'envío', 'domicilio', 'reparto'])) return 'mod_delivery';
      if (_algunaPalabra(t, ['retiro', 'local', 'buscar', 'paso a', 'paso', 'retirar'])) return 'mod_local';
      return null;
    }
    case PASOS.CONFIRMA_DIR: {
      if (_algunaPalabra(t, ['si', 'sí', 'correcta', 'correcto', 'confirmo', 'confirmar', 'ok', 'dale', 'listo', 'esta bien', 'está bien', 'asi es', 'así es', 'perfecto'])) return 'dir_ok';
      if (_algunaPalabra(t, ['no', 'corregir', 'cambiar', 'mal', 'otra', 'error', 'equivoque', 'equivoqué', 'arreglar'])) return 'dir_fix';
      return null;
    }
    case PASOS.PAGO: {
      if (_algunaPalabra(t, ['transfer', 'transferencia', 'deposito', 'depósito'])) return 'pay_transfer';
      if (_algunaPalabra(t, ['local', 'al retirar', 'retiro'])) return 'pay_local';
      if (_algunaPalabra(t, ['efectivo', 'cash', 'plata', 'al recibir'])) return 'pay_efectivo';
      return null;
    }
    case PASOS.CONFIRMAR: {
      if (_algunaPalabra(t, ['si', 'sí', 'confirmo', 'confirmar', 'dale', 'ok', 'listo', 'correcto'])) return 'conf_si';
      if (_algunaPalabra(t, ['no', 'reiniciar', 'cambiar', 'empezar', 'mal'])) return 'conf_reset';
      return null;
    }
    default:
      return null;
  }
}
function hintNoEntendi() {
  return { tipo: 'text', text: 'No te entendí 🙂. Tocá una opción del menú o escribí su nombre.' };
}

// ── núcleo: una transición ───────────────────────────────────────────────────
// Idempotente (innegociable #3): un input cuyo id no corresponde al paso actual se IGNORA
// (devuelve re-render del paso actual, sin avanzar).
export function procesar(estado, input, menu) {
  const e = estado ?? estadoInicial();
  const texto = (input?.texto ?? '').trim();

  // Mejora (2026-06-28): si el cliente ESCRIBIÓ (texto, no tocó) en un paso de selección, intentamos
  // resolver el texto a una opción del paso. Si no se reconoce: re-render con hint; al 2º fallo seguido
  // → escalar a humano (flag para el router). DIRECCION usa el texto tal cual; FIN no aplica.
  let id = input?.id ?? '';
  if (input?.tipo === 'text' && texto && e.paso !== PASOS.DIRECCION && e.paso !== PASOS.EDIT_ESPECIAL_TXT && e.paso !== PASOS.FIN) {
    const resuelto = matchTexto(e.paso, texto, menu);
    if (resuelto) { id = resuelto; e.intentos = 0; }
    else {
      e.intentos = (e.intentos || 0) + 1;
      const escalar = e.intentos >= 2;
      if (escalar) e.intentos = 0;
      return { estado: e, salidas: [hintNoEntendi(), renderPaso(e, menu)], ...(escalar ? { escalar: true } : {}) };
    }
  }
  const reRender = (extra) => ({ estado: e, salidas: [renderPaso(e, menu)], ...(extra || {}) });

  switch (e.paso) {
    case PASOS.PROTEINA: {
      const mMore = id.match(/^prot:more:(\d+)$/);
      if (mMore) return { estado: e, salidas: [renderProteina(menu, Number(mMore[1]))] };
      const m = id.match(/^prot:(\d+)$/);
      if (!m) return reRender();
      const dia = proteinasDisponibles(menu);
      const esp = especiales(menu);
      const idx = Number(m[1]);
      const todos = [...dia.map((p) => ({ nombre: p.nombre, esp: false })), ...esp.map((x) => ({ nombre: x.nombre, esp: true }))];
      if (idx < 0 || idx >= todos.length) return reRender();
      e.actual = nuevoItem();
      e.actual.proteina = todos[idx].nombre;
      e.actual.esEspecial = todos[idx].esp;
      // Composición FIJA del especial (H4/B1, 2026-06-30): lo que el plato TRAE va en `componentes` —
      // los agregados del día que incluye (Arroz, Tajadas: gratis, del pool del día, reemplazables) + los
      // exclusivos (porotos negros). NO es un cupo "elegí N gratis del día": su composición ya está en el
      // precio. Así B1 (ofrecía "2 gratis") y H4 (unificar incluidos+composición) quedan resueltos de raíz.
      // `exclusivo` marca el origen: el exclusivo es reemplazable DENTRO de su plato, pero NO va al pool general.
      if (todos[idx].esp) {
        const espObj = esp.find((x) => _norm(x.nombre) === _norm(todos[idx].nombre));
        const comp = [];
        for (const a of (espObj?.agregados_incluidos ?? [])) comp.push({ nombre: String(a), base: String(a), reemplazable: true, costo: 0, exclusivo: false });
        for (const c of (espObj?.componentes ?? [])) if (c && c.nombre) comp.push({ nombre: String(c.nombre), base: String(c.nombre), reemplazable: !!c.reemplazable, costo: 0, exclusivo: true });
        e.actual.componentes = comp;
      }
      // Especial → cupo 0 (composición fija): acompañamiento EXTRA opcional y PAGADO → PREGUNTAR antes.
      // Menú del día (cupo 2): los incluidos son a elegir de la lista → ir DIRECTO a elegir.
      if (cupoIncluidos(e.actual, menu) === 0) { e.paso = PASOS.ACOMP_ASK; return { estado: e, salidas: [botonesAcompAsk()] }; }
      e.paso = PASOS.ACOMP;
      return { estado: e, salidas: [renderAcomp(menu, e.actual)] };
    }
    case PASOS.ACOMP_ASK: {
      if (id === 'acask_si') { e.paso = PASOS.ACOMP; return { estado: e, salidas: [renderAcomp(menu, e.actual)] }; }
      if (id === 'acask_no') { e.paso = PASOS.BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
      return reRender();
    }
    case PASOS.ACOMP: {
      const m = id.match(/^ac:(\d+)$/);
      if (m) {
        const ac = acompañamientos(menu);
        const idx = Number(m[1]);
        if (idx >= 0 && idx < ac.length && e.actual.agregados.length < MAX_ACOMP) e.actual.agregados.push(ac[idx]);
        return { estado: e, salidas: [botonesAcompMas(e.actual.agregados.length, cupoIncluidos(e.actual, menu))] };
      }
      if (id === 'ac_mas') {
        if (e.actual.agregados.length >= MAX_ACOMP) { e.paso = PASOS.BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
        return { estado: e, salidas: [renderAcomp(menu, e.actual)] };
      }
      if (id === 'ac_listo') { e.paso = PASOS.BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
      return reRender();
    }
    case PASOS.BEBIDA: {
      const m = id.match(/^beb:(\d+)$/);
      if (m) { e.actual.bebida = bebidas(menu)[Number(m[1])] ?? null; return entrarExtras(e, menu); }
      if (id === 'beb_no') { e.actual.bebida = null; return entrarExtras(e, menu); }
      return reRender();
    }
    case PASOS.EXTRAS: {
      const m = id.match(/^ex:(\d+)$/);
      if (m) {
        const ex = extras(menu)[Number(m[1])];
        if (ex && !e.actual.extras.includes(ex.nombre)) e.actual.extras.push(ex.nombre);
        const r = renderExtras(menu, e.actual);
        return r ? { estado: e, salidas: [r] } : avanzarTrasExtras(e, menu); // sin más extras → avanzar
      }
      if (id === 'ex_no') return avanzarTrasExtras(e, menu);
      return reRender();
    }
    case PASOS.MAS_MENUS: {
      if (id === 'mm_otro') { e.paso = PASOS.PROTEINA; return { estado: e, salidas: [renderProteina(menu)] }; }
      if (id === 'mm_editar') { e.editReturn = PASOS.MAS_MENUS; e.paso = PASOS.EDIT_PICK; return { estado: e, salidas: [renderEditPick(e)] }; }
      if (id === 'mm_seguir') { e.paso = PASOS.MODALIDAD; return { estado: e, salidas: [botonesModalidad()] }; }
      return reRender();
    }
    case PASOS.MODALIDAD: {
      if (id === 'mod_delivery') { e.tipo = 'delivery'; e.paso = PASOS.DIRECCION; return { estado: e, salidas: [{ tipo: 'text', text: '¿A qué dirección te lo enviamos? (calle, número, depto)' }] }; }
      if (id === 'mod_local') { e.tipo = 'local'; e.paso = PASOS.PAGO; return { estado: e, salidas: [botonesPago('local')] }; }
      return reRender();
    }
    case PASOS.DIRECCION: {
      // Tras recibir la dirección NO avanzamos directo a pago: pasamos por confirmación (mejora UX-B).
      if (input?.tipo === 'text' && texto) { e.direccion = texto.slice(0, 200); e.paso = PASOS.CONFIRMA_DIR; return { estado: e, salidas: [confirmarDireccion(e.direccion)] }; }
      return { estado: e, salidas: [{ tipo: 'text', text: 'Escríbeme la dirección por favor (calle, número, depto).' }] };
    }
    case PASOS.CONFIRMA_DIR: {
      if (id === 'dir_ok') { e.paso = PASOS.PAGO; return { estado: e, salidas: [botonesPago('delivery')] }; }
      if (id === 'dir_fix') { e.direccion = null; e.paso = PASOS.DIRECCION; return { estado: e, salidas: [{ tipo: 'text', text: 'Dale 🙂. Escribime de nuevo la dirección (calle, número, depto).' }] }; }
      return reRender();
    }
    case PASOS.PAGO: {
      if (id === 'pay_local') e.metodo_pago = 'en_local';
      else if (id === 'pay_efectivo') e.metodo_pago = 'efectivo';
      else if (id === 'pay_transfer') e.metodo_pago = 'transferencia';
      else return reRender();
      e.paso = PASOS.CONFIRMAR;
      const { salida } = renderResumen(e, menu);
      return { estado: e, salidas: [salida] };
    }
    case PASOS.CONFIRMAR: {
      if (id === 'conf_si') { e.paso = PASOS.FIN; return { estado: e, salidas: [{ tipo: 'text', text: cierreTexto(e) }], pedido: armarPedido(e, menu) }; }
      if (id === 'conf_editar') { e.editReturn = PASOS.CONFIRMAR; e.paso = PASOS.EDIT_PICK; return { estado: e, salidas: [renderEditPick(e)] }; }
      if (id === 'conf_reset') { e.paso = PASOS.RESET_CONFIRM; return { estado: e, salidas: [botonesResetConfirm()] }; }
      // Ajuste especial PENDIENTE (§8): "Agregar otro menú" aprovecha la espera del local armando otro plato
      // (el ajuste sigue pendiente al volver al resumen); "Seguir sin el especial" descarta el ajuste y cierra.
      if (id === 'mm_otro') { e.paso = PASOS.PROTEINA; return { estado: e, salidas: [renderProteina(menu)] }; }
      if (id === 'conf_sin_ajuste') { e.solicitud = null; e.paso = PASOS.FIN; return { estado: e, salidas: [{ tipo: 'text', text: cierreTexto(e) }], pedido: armarPedido(e, menu) }; }
      if (id === 'conf_esperar') { return { estado: e, salidas: [renderResumen(e, menu).salida] }; } // defensivo (botón removido §8)
      return reRender();
    }
    case PASOS.RESET_CONFIRM: {
      if (id === 'reset_si') { const ne = estadoInicial(); return { estado: ne, salidas: [renderProteina(menu)] }; }
      if (id === 'reset_no') { e.paso = PASOS.CONFIRMAR; return { estado: e, salidas: [renderResumen(e, menu).salida] }; }
      return reRender();
    }
    case PASOS.EDIT_PICK: {
      const mMore = id.match(/^ep:more:(\d+)$/);
      if (mMore) return { estado: e, salidas: [renderEditPick(e, Number(mMore[1]))] };
      if (id === 'ep_volver') return vuelveEdicion(e, menu);
      const m = id.match(/^ep:(\d+)$/);
      if (m) { const idx = Number(m[1]); if (idx >= 0 && idx < e.items.length) { e.editIdx = idx; e.paso = PASOS.EDIT_ITEM; return { estado: e, salidas: [renderEditItem(e, menu)] }; } }
      return reRender();
    }
    case PASOS.EDIT_ITEM: {
      if (id === 'ei_volver') return vuelveEdicion(e, menu);
      if (id === 'ei_comp') {
        const it = e.items[e.editIdx];
        if (!it || !(it.componentes || []).some((c) => c.reemplazable)) return { estado: e, salidas: [renderEditItem(e, menu)] };
        e.paso = PASOS.EDIT_COMP_FROM; return { estado: e, salidas: [renderEditCompFrom(e)] };
      }
      if (id === 'ei_acomp') {
        const it = e.items[e.editIdx];
        if (!it || !(it.agregados || []).length) return { estado: e, salidas: [renderEditItem(e, menu)] };
        e.paso = PASOS.EDIT_ACOMP_FROM; return { estado: e, salidas: [renderEditAcompFrom(e)] };
      }
      if (id === 'ei_bebida') { e.paso = PASOS.EDIT_BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
      if (id === 'ei_especial') { e.paso = PASOS.EDIT_ESPECIAL_TXT; return { estado: e, salidas: [{ tipo: 'text', text: 'Escribime qué te gustaría que no está en el menú 🙂. Se lo paso al local y lo confirman antes de cerrar.' }] }; }
      if (id === 'ei_quitar') {
        if (e.editIdx != null) e.items.splice(e.editIdx, 1);
        e.editIdx = null;
        if (!e.items.length) { const ne = estadoInicial(); return { estado: ne, salidas: [{ tipo: 'text', text: 'Quité el plato y quedó vacío el pedido. Armemos uno nuevo 🙂' }, renderProteina(menu)] }; }
        return vuelveEdicion(e, menu, 'Listo, quité el plato.');
      }
      return reRender();
    }
    case PASOS.EDIT_ACOMP_FROM: {
      if (id === 'eaf_volver') { e.paso = PASOS.EDIT_ITEM; return { estado: e, salidas: [renderEditItem(e, menu)] }; }
      const m = id.match(/^eaf:(\d+)$/);
      if (m) { const idx = Number(m[1]); const it = e.items[e.editIdx]; if (it && idx >= 0 && idx < (it.agregados || []).length) { e.editAcompIdx = idx; e.paso = PASOS.EDIT_ACOMP_TO; return { estado: e, salidas: [renderEditAcompTo(e, menu)] }; } }
      return reRender();
    }
    case PASOS.EDIT_ACOMP_TO: {
      const mMore = id.match(/^eat:more:(\d+)$/);
      if (mMore) return { estado: e, salidas: [renderEditAcompTo(e, menu, Number(mMore[1]))] };
      if (id === 'eat_volver') { e.paso = PASOS.EDIT_ACOMP_FROM; return { estado: e, salidas: [renderEditAcompFrom(e)] }; }
      const m = id.match(/^eat:(\d+)$/);
      if (m) {
        const ac = acompañamientos(menu); const idx = Number(m[1]); const it = e.items[e.editIdx];
        if (it && idx >= 0 && idx < ac.length && e.editAcompIdx != null && e.editAcompIdx < (it.agregados || []).length) {
          it.agregados[e.editAcompIdx] = ac[idx]; // sustitución Nivel 1; calcularItem recalcula el costo
        }
        e.editAcompIdx = null;
        return vuelveEdicion(e, menu, 'Listo, cambié el acompañamiento.');
      }
      return reRender();
    }
    case PASOS.EDIT_BEBIDA: {
      const m = id.match(/^beb:(\d+)$/);
      if (m || id === 'beb_no') {
        const it = e.items[e.editIdx];
        if (it) it.bebida = m ? (bebidas(menu)[Number(m[1])] ?? null) : null;
        return vuelveEdicion(e, menu, 'Listo, cambié la bebida.');
      }
      return reRender();
    }
    case PASOS.EDIT_COMP_FROM: {
      if (id === 'ecf_volver') { e.paso = PASOS.EDIT_ITEM; return { estado: e, salidas: [renderEditItem(e, menu)] }; }
      const m = id.match(/^ecf:(\d+)$/);
      if (m) { const idx = Number(m[1]); const it = e.items[e.editIdx]; if (it && it.componentes && it.componentes[idx] && it.componentes[idx].reemplazable) { e.editCompIdx = idx; e.paso = PASOS.EDIT_COMP_TO; return { estado: e, salidas: [renderEditCompTo(e, menu)] }; } }
      return reRender();
    }
    case PASOS.EDIT_COMP_TO: {
      const mMore = id.match(/^ect:more:(\d+)$/);
      if (mMore) return { estado: e, salidas: [renderEditCompTo(e, menu, Number(mMore[1]))] };
      if (id === 'ect_volver') { e.paso = PASOS.EDIT_COMP_FROM; return { estado: e, salidas: [renderEditCompFrom(e)] }; }
      const m = id.match(/^ect:(\d+)$/);
      if (m) {
        const opts = opcionesComponente(menu); const idx = Number(m[1]); const it = e.items[e.editIdx];
        if (it && opts[idx] && e.editCompIdx != null && it.componentes[e.editCompIdx]) {
          it.componentes[e.editCompIdx] = { ...it.componentes[e.editCompIdx], nombre: opts[idx].nombre, costo: opts[idx].costo }; // incluido→incluido gratis; →pagado suma
        }
        e.editCompIdx = null;
        return vuelveEdicion(e, menu, 'Listo, cambié el componente.');
      }
      return reRender();
    }
    case PASOS.EDIT_ESPECIAL_TXT: {
      // Nivel 2 (fuera de carta): captura el texto crudo y crea una solicitud PENDIENTE. La red la hace el
      // router (señal `crearSolicitud`); acá dejamos la solicitud "draft" para que el resumen ya la muestre.
      if (input?.tipo === 'text' && texto) {
        const plato = nombreItem(e.items[e.editIdx]);
        const descripcion = texto.slice(0, 300);
        e.solicitud = { id: null, plato, descripcion, status: 'pendiente', costo: null };
        const r = vuelveEdicion(e, menu, 'Le paso tu pedido especial al local 🙂. Seguimos armando el resto y lo confirman antes de cerrar.');
        return { ...r, crearSolicitud: { plato, descripcion } };
      }
      return { estado: e, salidas: [{ tipo: 'text', text: 'Escribime qué querés (algo que no está en el menú).' }] };
    }
    case PASOS.FIN:
    default:
      return reRender();
  }
}

function cierreTexto(e) {
  if (e.metodo_pago === 'transferencia') return '¡Listo! Te paso los datos de transferencia y, apenas envíes el comprobante, lo validamos. 🙂';
  if (e.tipo === 'local') return '¡Listo! Tu pedido entró a preparación 🙂. Pagas al retirarlo en el local. Te aviso apenas esté listo.';
  return '¡Listo! Tu pedido entró a preparación 🙂. Pagas en efectivo al recibir. Te aviso cuando vaya en camino.';
}

// Re-render del paso actual (para idempotencia / inputs inválidos).
function renderPaso(e, menu) {
  switch (e.paso) {
    case PASOS.PROTEINA: return renderProteina(menu);
    case PASOS.ACOMP_ASK: return botonesAcompAsk();
    case PASOS.ACOMP: return e.actual.agregados.length ? botonesAcompMas(e.actual.agregados.length, cupoIncluidos(e.actual, menu)) : renderAcomp(menu, e.actual);
    case PASOS.BEBIDA: return renderBebida(menu);
    case PASOS.EXTRAS: return renderExtras(menu, e.actual) ?? renderMasMenus(e, menu);
    case PASOS.MAS_MENUS: return renderMasMenus(e, menu);
    case PASOS.MODALIDAD: return botonesModalidad();
    case PASOS.DIRECCION: return { tipo: 'text', text: 'Escríbeme la dirección (calle, número, depto).' };
    case PASOS.CONFIRMA_DIR: return confirmarDireccion(e.direccion ?? '');
    case PASOS.PAGO: return botonesPago(e.tipo);
    case PASOS.CONFIRMAR: return renderResumen(e, menu).salida;
    case PASOS.RESET_CONFIRM: return botonesResetConfirm();
    case PASOS.EDIT_PICK: return renderEditPick(e);
    case PASOS.EDIT_ITEM: return renderEditItem(e, menu);
    case PASOS.EDIT_ACOMP_FROM: return renderEditAcompFrom(e);
    case PASOS.EDIT_ACOMP_TO: return renderEditAcompTo(e, menu);
    case PASOS.EDIT_BEBIDA: return renderBebida(menu);
    case PASOS.EDIT_COMP_FROM: return renderEditCompFrom(e);
    case PASOS.EDIT_COMP_TO: return renderEditCompTo(e, menu);
    case PASOS.EDIT_ESPECIAL_TXT: return { tipo: 'text', text: 'Escribime qué querés (algo que no está en el menú).' };
    default: return { tipo: 'text', text: '🙂' };
  }
}

// Saludo inicial (la capa de transporte lo manda + el primer render de proteína).
export function saludoInicial() {
  return { tipo: 'text', text: '¡Hola! 👋 Bienvenido a El Sazón.' };
}

// Menú COMPLETO cara-cliente en texto (mejora UX 2026-06-29-A): se manda al inicio, ANTES del 1er paso de
// botones, para que el cliente vea el panorama antes de elegir. SIN IA. NOTA: NO reutilizo
// renderActiveMenuForPrompt (ese texto lleva instrucciones internas del bot 🚨/"REGLA PARA EL BOT" — no es
// cara-cliente); armo uno limpio con los MISMOS datos del menú activo. Devuelve null si no hay menú.
export function renderMenuCliente(menu) {
  if (!menu) return null;
  const prot = proteinasDisponibles(menu).map((p) => `• ${p.nombre}`).join('\n');
  if (!prot) return null; // sin proteínas no hay menú que mostrar
  const base = menu.price_typical ?? 7000;
  const inc = acompañamientos(menu).join(', ') || '(consultar)';
  const beb = bebidas(menu).map((b) => String(b).replace(/\s+natural$/i, '').trim()).join(' o ') || 'incluida';
  const ex = extras(menu).map((e) => `${e.nombre} (${clp(e.precio)})`).join(', ');
  const esp = especiales(menu).map((e) => {
    const c = Array.isArray(e.agregados_incluidos) && e.agregados_incluidos.length
      ? ` (incluye ${e.agregados_incluidos.join(', ')}; acompañamiento extra ${clp(2000)} c/u)`
      : ` (acompañamientos ${clp(2000)} c/u)`;
    return `• ${e.nombre} — ${clp(e.precio)}${e.desc ? ` · ${e.desc}` : ''}${c}`;
  }).join('\n');
  // Orden de secciones (ajuste UX QA 2026-06-29): el plato del día + sus componentes (acompañamientos,
  // bebida, extras) forman un bloque coherente; los ESPECIALES van AL FINAL como alternativa aparte.
  let t = `📋 *Menú de hoy*${menu.day_label ? ` — ${menu.day_label}` : ''}\n\n`;
  t += `🍽️ *Plato del día* — ${clp(base)}\n_(incluye 2 acompañamientos + 1 bebida)_\n${prot}\n`;
  t += `\n🥗 *Acompañamientos* (2 incluidos · extra ${clp(2000)} c/u): ${inc}`;
  t += `\n🥤 *Bebida incluida*: ${beb}`;
  if (ex) t += `\n➕ *Extras*: ${ex}`;
  if (esp) t += `\n\n⭐ *Especiales* (platos aparte, precio propio)\n${esp}`;
  t += `\n\nArmemos tu pedido tocando los botones 👇`;
  return { tipo: 'text', text: t };
}
