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
  PROTEINA: 'PROTEINA', ACOMP: 'ACOMP', BEBIDA: 'BEBIDA', EXTRAS: 'EXTRAS', ESP_AGREGAR: 'ESP_AGREGAR',
  MAS_MENUS: 'MAS_MENUS', MODALIDAD: 'MODALIDAD', DIRECCION: 'DIRECCION',
  CONFIRMA_DIR: 'CONFIRMA_DIR', PAGO: 'PAGO', CONFIRMAR: 'CONFIRMAR',
  // Edición granular del pedido (pieza 2 FASE A): desde el resumen, editar un plato sin re-armarlo.
  EDIT_PICK: 'EDIT_PICK', EDIT_ITEM: 'EDIT_ITEM', EDIT_ACOMP_FROM: 'EDIT_ACOMP_FROM',
  EDIT_ACOMP_TO: 'EDIT_ACOMP_TO', EDIT_BEBIDA: 'EDIT_BEBIDA', EDIT_PARTE_FROM: 'EDIT_PARTE_FROM',
  EDIT_COMP_FROM: 'EDIT_COMP_FROM', EDIT_COMP_TO: 'EDIT_COMP_TO', EDIT_AGREGAR: 'EDIT_AGREGAR',
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
// Acompañamientos del PLATO DEL DÍA (solo normal): 2 incluidos gratis. R2-5 (2026-06-30): tope = 2 gratis y
// punto, NO hay 3er acompañamiento normal pagado → al llegar a 2 el handler avanza SOLO a la bebida (sin
// preguntar "elige otro +$2.000"). "Listo así" sigue para quien quiere 0 o 1. El especial NO pasa por acá
// (va bebida → ESP_AGREGAR). Por eso la regla solo informa los gratis restantes; nunca un costo.
function renderAcomp(menu, actual) {
  const ac = acompañamientos(menu);
  const n = actual.agregados.length;
  const restan = Math.max(0, 2 - n);
  const regla = `te queda${restan === 1 ? '' : 'n'} ${restan} gratis`;
  const lista = ac.length ? '\n' + ac.map((nombre) => `· ${nombre}`).join('\n') : '';
  // H1 (2026-06-30): elegir SIN iteración intermedia — la lista trae los acompañamientos (repetibles) + la
  // salida "Listo así" ADENTRO. Tras elegir uno, el handler re-despliega la lista directo (sin el "+ Otro").
  // R3-2b (2026-06-30): la salida va PRIMERO (quien no quiere agregar la ve sin scrollear).
  const rows = [{ id: 'ac_listo', title: '✅ Listo así', description: 'No agregar más acompañamientos' },
    ...ac.slice(0, 9).map((nombre, idx) => ({ id: `ac:${idx}`, title: String(nombre).slice(0, 24) }))];
  return { tipo: 'list', text: `Elige un acompañamiento (${regla}). Llevas ${n}.${lista}`, button: 'Ver opciones',
    sections: [{ title: '2 incluidos gratis', rows }] };
}
// R2-4 (2026-06-30) — paso COMBINADO del ESPECIAL: un solo "¿agregar algo más? ($2.000 c/u)" con la lista
// unificada acompañamientos + extras, TODO pagado a $2.000. Reemplaza los 2 pasos del especial (el normal NO
// combina: ahí los gratis y los pagados van separados para no confundir). R2-7: el precio va en la BAJADA de
// cada fila ("Especial $2.000"), nunca en el título (se trunca). Ids: ac:i (acompañamiento) / ex:i (extra).
function renderEspAgregar(menu, actual) {
  const ac = acompañamientos(menu);
  const ex = extras(menu); // R3-3 (2026-06-30): TODOS los extras, REPETIBLES (no se filtran los ya elegidos).
  const yaTiene = (actual.agregados.length + (actual.extras?.length ?? 0)) > 0;
  const opts = [];
  ac.forEach((nombre, idx) => opts.push({ id: `ac:${idx}`, title: String(nombre).slice(0, 24), description: `Especial ${clp(2000)}` }));
  ex.forEach((e, idx) => opts.push({ id: `ex:${idx}`, title: String(e.nombre).slice(0, 24), description: `Especial ${clp(e.precio)}` }));
  // R3-2b: la salida va PRIMERO; reservo su fila → el resto cabe en MAX_ROWS-1.
  const salida = { id: 'esp_listo', title: yaTiene ? '✅ Listo' : 'No, seguir', description: 'No agregar nada más' };
  const rows = [salida, ...opts.slice(0, MAX_ROWS - 1)];
  return { tipo: 'list', text: '¿Querés agregar algo más? (cada uno cuesta $2.000)', button: 'Ver opciones', // R3-2a
    sections: [{ title: 'Agregados del especial', rows }] };
}
function renderBebida(menu) {
  const bs = bebidas(menu);
  const btns = bs.slice(0, 2).map((b, i) => ({ id: `beb:${i}`, title: String(b).slice(0, 20) }));
  btns.push({ id: 'beb_no', title: 'Sin bebida' });
  return { tipo: 'buttons', text: '¿Qué bebida? (incluida) 🥤', buttons: btns.slice(0, 3) };
}
// Paso de extras (solo plato del día) — selección DIRECTA: 0 extras en el menú → el caller saltea el paso;
// 1-2 → reply buttons directos (extra(s) + salida); ≥3 → List con la salida PRIMERO (R3-2b). R3-3: los extras
// son REPETIBLES (no se filtran los ya elegidos). Los ids usan el índice ORIGINAL del menú (precios.js matchea por índice).
function renderExtras(menu, actual) {
  const all = extras(menu); // R3-3 (2026-06-30): TODOS los extras, REPETIBLES (no se filtran los ya elegidos).
  if (!all.length) return null; // nada que ofrecer → avanzar
  const yaTiene = (actual?.extras ?? []).length > 0;
  const cab = yaTiene ? '¿Otro extra?' : '¿Querés agregar un extra? (opcional)';
  const salir = { id: 'ex_no', title: yaTiene ? '✅ Listo' : 'No, seguir' };
  // R2-3 (2026-06-30): el precio NUNCA en el label del botón (se trunca, ~20 chars) → va en el TEXTO de arriba.
  if (all.length <= 2) {
    const lista = '\n' + all.map((e) => `· ${e.nombre} — ${clp(e.precio)}`).join('\n');
    const btns = all.map((e, idx) => ({ id: `ex:${idx}`, title: String(e.nombre).slice(0, 20) }));
    btns.push(salir);
    return { tipo: 'buttons', text: cab + lista, buttons: btns.slice(0, 3) };
  }
  // R3-2b: la salida va PRIMERO. R2-7: en el List el precio va en la BAJADA ("Especial $2.000"), no en el título.
  const rows = [{ id: 'ex_no', title: salir.title, description: 'No agregar más' },
    ...all.slice(0, 9).map((e, idx) => ({ id: `ex:${idx}`, title: String(e.nombre).slice(0, 24), description: `Especial ${clp(e.precio)}` }))];
  return { tipo: 'list', text: cab, button: 'Ver opciones', sections: [{ title: 'Extras pagados', rows }] };
}
// Entra al paso de extras (o lo saltea si el menú no tiene extras).
function entrarExtras(e, menu) {
  e.paso = PASOS.EXTRAS;
  const r = renderExtras(menu, e.actual);
  return r ? { estado: e, salidas: [r] } : avanzarTrasExtras(e, menu);
}
// Entra al paso COMBINADO del especial (R2-4): acompañamientos + extras, todo $2.000. Si el menú no tiene ni
// acompañamientos ni extras para ofrecer, saltea y cierra el ítem.
function entrarEspAgregar(e, menu) {
  if (!acompañamientos(menu).length && !extras(menu).length) return avanzarTrasExtras(e, menu);
  e.paso = PASOS.ESP_AGREGAR;
  return { estado: e, salidas: [renderEspAgregar(menu, e.actual)] };
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
  // R3-5 (2026-06-30): solo en DELIVERY, recordar que verificar la dirección es responsabilidad del cliente.
  const avisoDir = (estado.tipo === 'delivery' && estado.direccion)
    ? '\n\n⚠️ Revisá que tu dirección esté correcta — la entrega depende de eso.' : '';
  const txt = construirResumen(calc, extrasPedido) + dirTxt + avisoDir;
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
  // H3: UNA sola "Cambiar algo del plato" (fusiona componente + acompañamiento — para el cliente son lo
  // mismo: una parte de su plato). H2: bajadas descriptivas por fila (los labels eran poco claros en QA).
  const tieneParts = it && ((it.componentes || []).some((c) => c.reemplazable) || (it.agregados || []).length);
  if (tieneParts) rows.push({ id: 'ei_parte', title: '🍽 Cambiar algo del plato', description: 'Cambiá una parte por otra del día o un extra' });
  if (bebidas(menu).length) rows.push({ id: 'ei_bebida', title: '🥤 Cambiar bebida', description: 'Elegí otra bebida incluida' });
  // R3-4 (2026-06-30): sumar un acompañamiento o extra a un plato ya armado (precio según el cupo del plato).
  if (acompañamientos(menu).length || extras(menu).length) rows.push({ id: 'ei_agregar', title: '➕ Agregar algo más', description: 'Sumá un acompañamiento o un extra' });
  rows.push({ id: 'ei_especial', title: '🙋 Pedir algo especial', description: 'Algo que no está en el menú — lo confirma el local' });
  rows.push({ id: 'ei_quitar', title: '🗑 Quitar este plato', description: 'Sacá este plato del pedido' });
  rows.push({ id: 'ei_volver', title: '↩ Volver', description: 'Volvé sin cambios' });
  return { tipo: 'list', text: `Editar: *${nombreItem(it)}*. ¿Qué cambiás?`, button: 'Opciones', sections: [{ title: 'Editar plato', rows }] };
}
// R3-4 (2026-06-30): cupo de acompañamientos GRATIS que le queda al ítem (normal = 2 − usados; especial = 0).
function cupoLibreItem(it) {
  if (it?.esEspecial) return 0;
  return Math.max(0, 2 - ((it?.agregados ?? []).length));
}
// R3-4 — "Agregar algo más" a un plato ya armado. El PRECIO lo decide precios.js por posición (los normales
// dentro del cupo de 2 van gratis; el resto $2.000; el especial no tiene cupo) → acá solo MOSTRAMOS la bajada
// correcta. Reglas de UX: salida PRIMERO (R3-2b) y repetible (R3-3). Ids `ea_ac:i` / `ea_ex:i` (índice del menú).
function renderEditAgregar(estado, menu) {
  const it = estado.items[estado.editIdx];
  const libre = cupoLibreItem(it); // normales gratis restantes (0 si especial o cupo lleno)
  const ac = acompañamientos(menu);
  const ex = extras(menu);
  const opts = [];
  ac.forEach((nombre, idx) => opts.push({ id: `ea_ac:${idx}`, title: String(nombre).slice(0, 24), description: libre > 0 ? 'Incluido' : `Especial ${clp(2000)}` }));
  ex.forEach((e, idx) => opts.push({ id: `ea_ex:${idx}`, title: String(e.nombre).slice(0, 24), description: `Especial ${clp(e.precio)}` }));
  const salida = { id: 'ea_listo', title: '✅ Listo', description: 'No agregar más' };
  const rows = [salida, ...opts.slice(0, MAX_ROWS - 1)];
  const cab = libre > 0
    ? `¿Qué le sumás? (te queda${libre === 1 ? '' : 'n'} ${libre} gratis · extras ${clp(2000)})`
    : `¿Qué le sumás? (cada uno ${clp(2000)})`;
  return { tipo: 'list', text: cab, button: 'Ver opciones', sections: [{ title: 'Agregar al plato', rows }] };
}
// H3 — "Cambiar algo del plato": lista unificada de las partes del plato (componentes reemplazables del
// especial + acompañamientos del menú del día). El id codifica el tipo (c=componente, a=acompañamiento) +
// su índice real, para enrutar al reemplazo correcto. Pool de reemplazo en AMBOS = día (gratis) + extras (pagados).
function renderEditParteFrom(estado) {
  const it = estado.items[estado.editIdx];
  const partes = [];
  (it.componentes || []).forEach((c, i) => { if (c.reemplazable) partes.push({ t: 'c', i, nombre: c.nombre }); });
  (it.agregados || []).forEach((a, i) => partes.push({ t: 'a', i, nombre: String(a) }));
  const rows = rowsConVolver(partes, 'epf', 0,
    (p) => ({ id: `epf:${p.t}:${p.i}`, title: String(p.nombre).slice(0, 24) }), 'epf_volver', '↩ Volver');
  return { tipo: 'list', text: '¿Qué parte de tu plato cambiás?', button: 'Partes', sections: [{ title: nombreItem(it), rows }] };
}
// Sustitución de COMPONENTES del especial componible (pieza 2). Opciones del día = acompañamientos (gratis)
// + extras pagados (con su precio). Se reconstruye igual en render y handler → el índice es estable.
function opcionesComponente(menu) {
  const acs = acompañamientos(menu).map((n) => ({ nombre: String(n), costo: 0 }));
  const exs = extras(menu).map((e) => ({ nombre: e.nombre, costo: Number(e.precio) || 0 }));
  return [...acs, ...exs];
}
// R2-7 (2026-06-30): el precio va en la BAJADA de la fila, nunca en el título (se trunca "+$2.0"). Pagado →
// "Especial $2.000"; del día (gratis) → "Incluido".
function bajadaOpcion(o) { return o.costo ? `Especial ${clp(o.costo)}` : 'Incluido'; }
function renderEditCompTo(estado, menu, offset = 0) {
  const opts = opcionesComponente(menu);
  const rows = rowsConVolver(opts, 'ect', offset,
    (o, idx) => ({ id: `ect:${idx}`, title: String(o.nombre).slice(0, 24), description: bajadaOpcion(o) }), 'ect_volver', '↩ Volver');
  return { tipo: 'list', text: '¿Por cuál lo cambiás? (los pagados suman su precio)', button: 'Opciones', sections: [{ title: 'Del día', rows }] };
}
function renderEditAcompTo(estado, menu, offset = 0) {
  // H3: pool unificado = día (gratis) + extras (pagados, con su precio). Igual que el reemplazo de componentes.
  const opts = opcionesComponente(menu);
  const rows = rowsConVolver(opts, 'eat', offset,
    (o, idx) => ({ id: `eat:${idx}`, title: String(o.nombre).slice(0, 24), description: bajadaOpcion(o) }), 'eat_volver', '↩ Volver');
  return { tipo: 'list', text: '¿Por cuál lo cambiás? (los pagados suman su precio)', button: 'Opciones', sections: [{ title: 'Del día + extras', rows }] };
}
// R2-6 (2026-06-30): registra una sustitución en el ítem para destacarla en el resumen Y en el board (la
// cocina debe ver qué se desvió del plato estándar). Colapsa cadenas: si un cambio previo terminó en `de`,
// se reescribe su destino → se muestra el NETO (original → último), no cada paso intermedio.
function registrarCambio(it, de, a) {
  if (!de || !a) return;
  it.cambios = it.cambios || [];
  const prev = it.cambios.find((c) => _norm(c.a) === _norm(de));
  if (prev) {
    prev.a = String(a);
    if (_norm(prev.de) === _norm(prev.a)) it.cambios = it.cambios.filter((c) => c !== prev); // volvió al original → sin cambio
    return;
  }
  if (_norm(de) === _norm(a)) return;
  it.cambios.push({ de: String(de), a: String(a) });
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
    case PASOS.ACOMP: {
      if (_algunaPalabra(t, ['listo', 'nada mas', 'nada más', 'ya esta', 'eso es todo', 'asi esta'])) return 'ac_listo';
      const i = _idxEnLista(texto, acompañamientos(menu));
      return i >= 0 ? `ac:${i}` : null;
    }
    case PASOS.ESP_AGREGAR: {
      // Paso combinado del especial: listo, o un acompañamiento (ac:i), o un extra (ex:i).
      if (_algunaPalabra(t, ['listo', 'no', 'seguir', 'nada', 'nada mas', 'nada más', 'eso es todo', 'asi esta'])) return 'esp_listo';
      const ia = _idxEnLista(texto, acompañamientos(menu));
      if (ia >= 0) return `ac:${ia}`;
      const ie = _idxEnLista(texto, extras(menu).map((e) => e.nombre));
      return ie >= 0 ? `ex:${ie}` : null;
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
      // R2-2 (2026-06-30): el ESPECIAL pregunta primero la BEBIDA (incluida), y los acompañamientos EXTRA
      // (pagados) van DESPUÉS, combinados con los extras en un solo paso (R2-4). Lo opcional con costo al final.
      // El menú del DÍA (cupo 2) va directo a elegir sus 2 acompañamientos incluidos.
      if (e.actual.esEspecial) { e.paso = PASOS.BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
      e.paso = PASOS.ACOMP;
      return { estado: e, salidas: [renderAcomp(menu, e.actual)] };
    }
    case PASOS.ACOMP: {
      // Solo plato del día. R2-5 (2026-06-30): 2 gratis y punto → al llegar a 2 avanza SOLO a la bebida (sin
      // ofrecer un 3er acompañamiento pagado). "Listo así" corta antes para quien quiere 0 o 1.
      const m = id.match(/^ac:(\d+)$/);
      if (m) {
        const ac = acompañamientos(menu);
        const idx = Number(m[1]);
        if (idx >= 0 && idx < ac.length && e.actual.agregados.length < 2) e.actual.agregados.push(ac[idx]);
        if (e.actual.agregados.length >= 2) { e.paso = PASOS.BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
        return { estado: e, salidas: [renderAcomp(menu, e.actual)] };
      }
      if (id === 'ac_listo') { e.paso = PASOS.BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
      return reRender();
    }
    case PASOS.BEBIDA: {
      // Tras la bebida: el especial va al paso combinado ESP_AGREGAR (acompañamientos + extras, todo $2.000,
      // R2-4); el normal va a los extras (paso aparte). entrarEspAgregar/entrarExtras saltean si no hay nada.
      const elegir = (b) => { e.actual.bebida = b; return e.actual.esEspecial ? entrarEspAgregar(e, menu) : entrarExtras(e, menu); };
      const m = id.match(/^beb:(\d+)$/);
      if (m) return elegir(bebidas(menu)[Number(m[1])] ?? null);
      if (id === 'beb_no') return elegir(null);
      return reRender();
    }
    case PASOS.ESP_AGREGAR: {
      // Paso combinado del especial (R2-4): acompañamiento (ac:i, repetible) o extra (ex:i, único), todo pagado.
      const ma = id.match(/^ac:(\d+)$/);
      if (ma) {
        const ac = acompañamientos(menu); const idx = Number(ma[1]);
        if (idx >= 0 && idx < ac.length && e.actual.agregados.length < MAX_ACOMP) e.actual.agregados.push(ac[idx]);
        return { estado: e, salidas: [renderEspAgregar(menu, e.actual)] };
      }
      const mx = id.match(/^ex:(\d+)$/);
      if (mx) {
        const ex = extras(menu)[Number(mx[1])];
        if (ex && e.actual.extras.length < MAX_ACOMP) e.actual.extras.push(ex.nombre); // R3-3: repetible (sin dedup)
        return { estado: e, salidas: [renderEspAgregar(menu, e.actual)] };
      }
      if (id === 'esp_listo') return avanzarTrasExtras(e, menu);
      return reRender();
    }
    case PASOS.EXTRAS: {
      const m = id.match(/^ex:(\d+)$/);
      if (m) {
        const ex = extras(menu)[Number(m[1])];
        if (ex && e.actual.extras.length < MAX_ACOMP) e.actual.extras.push(ex.nombre); // R3-3: repetible (sin dedup)
        const r = renderExtras(menu, e.actual);
        return r ? { estado: e, salidas: [r] } : avanzarTrasExtras(e, menu); // sin extras en el menú → avanzar
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
      if (id === 'ei_parte') {
        const it = e.items[e.editIdx];
        const tiene = it && ((it.componentes || []).some((c) => c.reemplazable) || (it.agregados || []).length);
        if (!tiene) return { estado: e, salidas: [renderEditItem(e, menu)] };
        e.paso = PASOS.EDIT_PARTE_FROM; return { estado: e, salidas: [renderEditParteFrom(e)] };
      }
      if (id === 'ei_bebida') { e.paso = PASOS.EDIT_BEBIDA; return { estado: e, salidas: [renderBebida(menu)] }; }
      if (id === 'ei_agregar') { e.paso = PASOS.EDIT_AGREGAR; return { estado: e, salidas: [renderEditAgregar(e, menu)] }; }
      if (id === 'ei_especial') { e.paso = PASOS.EDIT_ESPECIAL_TXT; return { estado: e, salidas: [{ tipo: 'text', text: 'Escribime qué te gustaría que no está en el menú 🙂. Se lo paso al local y lo confirman antes de cerrar.' }] }; }
      if (id === 'ei_quitar') {
        if (e.editIdx != null) e.items.splice(e.editIdx, 1);
        e.editIdx = null;
        if (!e.items.length) { const ne = estadoInicial(); return { estado: ne, salidas: [{ tipo: 'text', text: 'Quité el plato y quedó vacío el pedido. Armemos uno nuevo 🙂' }, renderProteina(menu)] }; }
        return vuelveEdicion(e, menu, 'Listo, quité el plato.');
      }
      return reRender();
    }
    case PASOS.EDIT_PARTE_FROM: {
      if (id === 'epf_volver') { e.paso = PASOS.EDIT_ITEM; return { estado: e, salidas: [renderEditItem(e, menu)] }; }
      const it = e.items[e.editIdx];
      const mc = id.match(/^epf:c:(\d+)$/);
      if (mc) { const i = Number(mc[1]); if (it && it.componentes?.[i]?.reemplazable) { e.editCompIdx = i; e.paso = PASOS.EDIT_COMP_TO; return { estado: e, salidas: [renderEditCompTo(e, menu)] }; } }
      const ma = id.match(/^epf:a:(\d+)$/);
      if (ma) { const i = Number(ma[1]); if (it && i >= 0 && i < (it.agregados || []).length) { e.editAcompIdx = i; e.paso = PASOS.EDIT_ACOMP_TO; return { estado: e, salidas: [renderEditAcompTo(e, menu)] }; } }
      return reRender();
    }
    case PASOS.EDIT_ACOMP_TO: {
      const mMore = id.match(/^eat:more:(\d+)$/);
      if (mMore) return { estado: e, salidas: [renderEditAcompTo(e, menu, Number(mMore[1]))] };
      if (id === 'eat_volver') { e.paso = PASOS.EDIT_PARTE_FROM; return { estado: e, salidas: [renderEditParteFrom(e)] }; }
      const m = id.match(/^eat:(\d+)$/);
      if (m) {
        const opts = opcionesComponente(menu); const idx = Number(m[1]); const it = e.items[e.editIdx]; const opt = opts[idx];
        if (it && opt && e.editAcompIdx != null && e.editAcompIdx < (it.agregados || []).length) {
          const de = it.agregados[e.editAcompIdx];
          if (opt.costo > 0) {
            // Reemplazo por un EXTRA pagado (H3): el acompañamiento sale de `agregados` y entra como `extra`
            // (calcularItem lo cobra a su precio real, no por cupo).
            it.agregados.splice(e.editAcompIdx, 1);
            (it.extras = it.extras || []).push(opt.nombre);
          } else {
            it.agregados[e.editAcompIdx] = opt.nombre; // swap por otro del día (gratis / por cupo)
          }
          registrarCambio(it, de, opt.nombre); // R2-6: destacar la sustitución
        }
        e.editAcompIdx = null;
        return vuelveEdicion(e, menu, 'Listo, cambié una parte del plato.');
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
    case PASOS.EDIT_AGREGAR: {
      // R3-4: sumar acompañamiento (ea_ac:i, cupo→gratis/$2.000 por posición en precios.js) o extra (ea_ex:i,
      // siempre pagado). Repetible (R3-3). "Listo" cierra y vuelve al resumen.
      if (id === 'ea_listo') return vuelveEdicion(e, menu, 'Listo, sumé lo que pediste.');
      const it = e.items[e.editIdx];
      const ma = id.match(/^ea_ac:(\d+)$/);
      if (ma && it) {
        const ac = acompañamientos(menu); const idx = Number(ma[1]);
        if (idx >= 0 && idx < ac.length && (it.agregados = it.agregados || []).length < MAX_ACOMP) it.agregados.push(ac[idx]);
        return { estado: e, salidas: [renderEditAgregar(e, menu)] };
      }
      const mx = id.match(/^ea_ex:(\d+)$/);
      if (mx && it) {
        const ex = extras(menu)[Number(mx[1])];
        if (ex && (it.extras = it.extras || []).length < MAX_ACOMP) it.extras.push(ex.nombre);
        return { estado: e, salidas: [renderEditAgregar(e, menu)] };
      }
      return reRender();
    }
    case PASOS.EDIT_COMP_TO: {
      const mMore = id.match(/^ect:more:(\d+)$/);
      if (mMore) return { estado: e, salidas: [renderEditCompTo(e, menu, Number(mMore[1]))] };
      if (id === 'ect_volver') { e.paso = PASOS.EDIT_PARTE_FROM; return { estado: e, salidas: [renderEditParteFrom(e)] }; }
      const m = id.match(/^ect:(\d+)$/);
      if (m) {
        const opts = opcionesComponente(menu); const idx = Number(m[1]); const it = e.items[e.editIdx];
        if (it && opts[idx] && e.editCompIdx != null && it.componentes[e.editCompIdx]) {
          const de = it.componentes[e.editCompIdx].nombre;
          it.componentes[e.editCompIdx] = { ...it.componentes[e.editCompIdx], nombre: opts[idx].nombre, costo: opts[idx].costo }; // incluido→incluido gratis; →pagado suma
          registrarCambio(it, de, opts[idx].nombre); // R2-6: destacar la sustitución
        }
        e.editCompIdx = null;
        return vuelveEdicion(e, menu, 'Listo, cambié una parte del plato.');
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
  // R2-9: para transferencia, este es solo el INTRO — el router envía a continuación los datos bancarios
  // reales (banco/cuenta/titular/RUT) desde SAZON_TRANSFER_INFO. La máquina pura no lee env/IO.
  if (e.metodo_pago === 'transferencia') return '¡Listo! 🙂 Te paso los datos para la transferencia 👇';
  if (e.tipo === 'local') return '¡Listo! Tu pedido entró a preparación 🙂. Pagas al retirarlo en el local. Te aviso apenas esté listo.';
  return '¡Listo! Tu pedido entró a preparación 🙂. Pagas en efectivo al recibir. Te aviso cuando vaya en camino.';
}

// Re-render del paso actual (para idempotencia / inputs inválidos).
function renderPaso(e, menu) {
  switch (e.paso) {
    case PASOS.PROTEINA: return renderProteina(menu);
    case PASOS.ACOMP: return renderAcomp(menu, e.actual);
    case PASOS.BEBIDA: return renderBebida(menu);
    case PASOS.ESP_AGREGAR: return renderEspAgregar(menu, e.actual);
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
    case PASOS.EDIT_PARTE_FROM: return renderEditParteFrom(e);
    case PASOS.EDIT_ACOMP_TO: return renderEditAcompTo(e, menu);
    case PASOS.EDIT_BEBIDA: return renderBebida(menu);
    case PASOS.EDIT_AGREGAR: return renderEditAgregar(e, menu);
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
  // R2-1 (2026-06-30): cada ítem en su LÍNEA con "·" (como las proteínas), no pegados con comas. La bebida es
  // "elegí una"; la composición del especial también va con puntos.
  const puntos = (arr) => (arr ?? []).map((s) => ` · ${s}`).join('\n');
  const incArr = acompañamientos(menu);
  const bebArr = bebidas(menu).map((b) => String(b).replace(/\s+natural$/i, '').trim());
  const exArr = extras(menu).map((e) => `${e.nombre} — ${clp(e.precio)}`);
  const esp = especiales(menu).map((e) => {
    const comp = Array.isArray(e.agregados_incluidos) ? e.agregados_incluidos : [];
    const compTxt = comp.length ? `\n${puntos(comp)}\n · _(acompañamiento extra ${clp(2000)} c/u)_` : `\n · _(acompañamientos ${clp(2000)} c/u)_`;
    return `• *${e.nombre}* — ${clp(e.precio)}${e.desc ? ` · ${e.desc}` : ''}${compTxt}`;
  }).join('\n');
  // Orden de secciones (ajuste UX QA 2026-06-29): el plato del día + sus componentes (acompañamientos,
  // bebida, extras) forman un bloque coherente; los ESPECIALES van AL FINAL como alternativa aparte.
  let t = `📋 *Menú de hoy*${menu.day_label ? ` — ${menu.day_label}` : ''}\n\n`;
  t += `🍽️ *Plato del día* — ${clp(base)}\n_(incluye 2 acompañamientos + 1 bebida)_\n${prot}`;
  // R3-1 (2026-06-30): línea en blanco (\n\n) ANTES de cada título de sección → las secciones respiran.
  t += `\n\n🥗 *Acompañamientos* (2 incluidos · extra ${clp(2000)} c/u):\n${puntos(incArr.length ? incArr : ['(consultar)'])}`;
  t += `\n\n🥤 *Bebida incluida* (elegí una):\n${puntos(bebArr.length ? bebArr : ['incluida'])}`;
  if (exArr.length) t += `\n\n➕ *Extras*:\n${puntos(exArr)}`;
  if (esp) t += `\n\n⭐ *Especiales* (platos aparte, precio propio)\n${esp}`;
  t += `\n\nArmemos tu pedido tocando los botones 👇`;
  return { tipo: 'text', text: t };
}
