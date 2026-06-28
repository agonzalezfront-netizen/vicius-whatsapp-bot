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
  PROTEINA: 'PROTEINA', ACOMP: 'ACOMP', BEBIDA: 'BEBIDA', EXTRAS: 'EXTRAS',
  MAS_MENUS: 'MAS_MENUS', MODALIDAD: 'MODALIDAD', DIRECCION: 'DIRECCION',
  PAGO: 'PAGO', CONFIRMAR: 'CONFIRMAR', FIN: 'FIN',
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
  return { paso: PASOS.PROTEINA, items: [], actual: nuevoItem(), tipo: null, direccion: null, metodo_pago: null };
}
function nuevoItem() { return { proteina: null, esEspecial: false, agregados: [], bebida: null, extras: [] }; }

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
  const rows = pagedRows(ac, 'ac', 0, (nombre, idx) => ({ id: `ac:${idx}`, title: String(nombre).slice(0, 24) }));
  const aviso = n >= 2 ? ` (el próximo suma ${clp(2000)})` : '';
  return { tipo: 'list', text: `Elige un acompañamiento${aviso}. Llevas ${n}.`, button: 'Acompañamientos',
    sections: [{ title: '2 incluidos · extra $2.000', rows }] };
}
function botonesAcompMas(n) {
  return { tipo: 'buttons', text: `Llevas ${n} acompañamiento(s). ¿Agregar otro?`,
    buttons: [{ id: 'ac_mas', title: '➕ Otro' }, { id: 'ac_listo', title: '✅ Listo' }] };
}
function renderBebida(menu) {
  const bs = bebidas(menu);
  const btns = bs.slice(0, 2).map((b, i) => ({ id: `beb:${i}`, title: String(b).slice(0, 20) }));
  btns.push({ id: 'beb_no', title: 'Sin bebida' });
  return { tipo: 'buttons', text: '¿Qué bebida? (incluida) 🥤', buttons: btns.slice(0, 3) };
}
function botonesExtrasAsk() {
  return { tipo: 'buttons', text: '¿Quieres agregar algún extra pagado?',
    buttons: [{ id: 'ex_add', title: '➕ Agregar extra' }, { id: 'ex_no', title: 'No, seguir' }] };
}
function renderExtrasList(menu, offset = 0) {
  const ex = extras(menu);
  const rows = pagedRows(ex, 'ex', offset, (e, idx) => ({ id: `ex:${idx}`, title: String(e.nombre).slice(0, 24), description: clp(e.precio) }));
  return { tipo: 'list', text: 'Elige un extra:', button: 'Extras', sections: [{ title: 'Extras pagados', rows }] };
}
function botonesExtraMas() {
  return { tipo: 'buttons', text: '¿Otro extra?', buttons: [{ id: 'ex_mas', title: '➕ Otro' }, { id: 'ex_listo', title: '✅ Listo' }] };
}
function botonesMasMenus() {
  return { tipo: 'buttons', text: '¿Agregar otro menú o seguir?',
    buttons: [{ id: 'mm_otro', title: '➕ Otro menú' }, { id: 'mm_seguir', title: '✅ Seguir' }] };
}
function botonesModalidad() {
  return { tipo: 'buttons', text: '¿Cómo lo quieres?',
    buttons: [{ id: 'mod_delivery', title: '🛵 Delivery' }, { id: 'mod_local', title: '🏠 Retiro local' }] };
}
function botonesPago(tipo) {
  const presencial = tipo === 'local'
    ? { id: 'pay_local', title: 'En el local' }
    : { id: 'pay_efectivo', title: 'Efectivo' };
  return { tipo: 'buttons', text: '¿Cómo pagas?', buttons: [presencial, { id: 'pay_transfer', title: 'Transferencia' }] };
}
function renderResumen(estado, menu) {
  const calc = calcularPedido(estado.items, estado.tipo, menu, null);
  const txt = construirResumen(calc) + (estado.tipo === 'delivery' && estado.direccion ? `\n\n🛵 ${estado.direccion}` : '');
  return { calc, salida: { tipo: 'buttons', text: txt + '\n\n¿Confirmamos?',
    buttons: [{ id: 'conf_si', title: '✅ Confirmar' }, { id: 'conf_reset', title: '✏️ Reiniciar' }] } };
}

// ── pedido final (formato crearPedido) ───────────────────────────────────────
function armarPedido(estado, menu) {
  const calc = calcularPedido(estado.items, estado.tipo, menu, null);
  return {
    items: estado.items,
    total: calc.total,
    desglose: calc,
    metodo_pago: estado.metodo_pago,
    tipo: estado.tipo,
    direccion: estado.direccion,
    status: estado.metodo_pago === 'transferencia' ? 'esperando_comprobante' : 'en_cocina',
  };
}

// ── núcleo: una transición ───────────────────────────────────────────────────
// Idempotente (innegociable #3): un input cuyo id no corresponde al paso actual se IGNORA
// (devuelve re-render del paso actual, sin avanzar).
export function procesar(estado, input, menu) {
  const e = estado ?? estadoInicial();
  const id = input?.id ?? '';
  const texto = (input?.texto ?? '').trim();
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
      e.paso = PASOS.ACOMP;
      return { estado: e, salidas: [renderAcomp(menu, e.actual)] };
    }
    case PASOS.ACOMP: {
      const m = id.match(/^ac:(\d+)$/);
      if (m) {
        const ac = acompañamientos(menu);
        const idx = Number(m[1]);
        if (idx >= 0 && idx < ac.length && e.actual.agregados.length < MAX_ACOMP) e.actual.agregados.push(ac[idx]);
        return { estado: e, salidas: [botonesAcompMas(e.actual.agregados.length)] };
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
      if (m) { e.actual.bebida = bebidas(menu)[Number(m[1])] ?? null; e.paso = PASOS.EXTRAS; return { estado: e, salidas: [botonesExtrasAsk()] }; }
      if (id === 'beb_no') { e.actual.bebida = null; e.paso = PASOS.EXTRAS; return { estado: e, salidas: [botonesExtrasAsk()] }; }
      return reRender();
    }
    case PASOS.EXTRAS: {
      if (id === 'ex_add' || id === 'ex_mas') return { estado: e, salidas: [renderExtrasList(menu)] };
      const mMore = id.match(/^ex:more:(\d+)$/);
      if (mMore) return { estado: e, salidas: [renderExtrasList(menu, Number(mMore[1]))] };
      const m = id.match(/^ex:(\d+)$/);
      if (m) { const ex = extras(menu)[Number(m[1])]; if (ex) e.actual.extras.push(ex.nombre); return { estado: e, salidas: [botonesExtraMas()] }; }
      if (id === 'ex_no' || id === 'ex_listo') {
        e.items.push(e.actual); e.actual = nuevoItem();
        if (e.items.length >= MAX_ITEMS) { e.paso = PASOS.MODALIDAD; return { estado: e, salidas: [botonesModalidad()] }; }
        e.paso = PASOS.MAS_MENUS; return { estado: e, salidas: [botonesMasMenus()] };
      }
      return reRender();
    }
    case PASOS.MAS_MENUS: {
      if (id === 'mm_otro') { e.paso = PASOS.PROTEINA; return { estado: e, salidas: [renderProteina(menu)] }; }
      if (id === 'mm_seguir') { e.paso = PASOS.MODALIDAD; return { estado: e, salidas: [botonesModalidad()] }; }
      return reRender();
    }
    case PASOS.MODALIDAD: {
      if (id === 'mod_delivery') { e.tipo = 'delivery'; e.paso = PASOS.DIRECCION; return { estado: e, salidas: [{ tipo: 'text', text: '¿A qué dirección te lo enviamos? (calle, número, depto)' }] }; }
      if (id === 'mod_local') { e.tipo = 'local'; e.paso = PASOS.PAGO; return { estado: e, salidas: [botonesPago('local')] }; }
      return reRender();
    }
    case PASOS.DIRECCION: {
      if (input?.tipo === 'text' && texto) { e.direccion = texto.slice(0, 200); e.paso = PASOS.PAGO; return { estado: e, salidas: [botonesPago('delivery')] }; }
      return { estado: e, salidas: [{ tipo: 'text', text: 'Escríbeme la dirección por favor (calle, número, depto).' }] };
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
      if (id === 'conf_reset') { const ne = estadoInicial(); return { estado: ne, salidas: [renderProteina(menu)] }; }
      return reRender();
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
    case PASOS.ACOMP: return e.actual.agregados.length ? botonesAcompMas(e.actual.agregados.length) : renderAcomp(menu, e.actual);
    case PASOS.BEBIDA: return renderBebida(menu);
    case PASOS.EXTRAS: return botonesExtrasAsk();
    case PASOS.MAS_MENUS: return botonesMasMenus();
    case PASOS.MODALIDAD: return botonesModalidad();
    case PASOS.DIRECCION: return { tipo: 'text', text: 'Escríbeme la dirección (calle, número, depto).' };
    case PASOS.PAGO: return botonesPago(e.tipo);
    case PASOS.CONFIRMAR: return renderResumen(e, menu).salida;
    default: return { tipo: 'text', text: '🙂' };
  }
}

// Saludo inicial (la capa de transporte lo manda + el primer render de proteína).
export function saludoInicial() {
  return { tipo: 'text', text: '¡Hola! 👋 Bienvenido a El Sazón. Armemos tu pedido tocando los botones 👇' };
}
