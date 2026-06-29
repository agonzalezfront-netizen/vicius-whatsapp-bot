// Cálculo y armado del resumen del pedido POR CÓDIGO (determinista).
// Directriz de Alberto 2026-06-10: "que sea por código para no sacar cuentas
// equivocadas". Claude SOLO interpreta QUÉ pidió el cliente (items/extras/bebida);
// el código pone los precios (desde la config del menú), suma, y arma el texto del
// resumen (cada extra con precio, bebida incluida marcada, subtotales, total que cuadra).
//
// Reglas de precio (confirmadas):
// - Menú estándar = price_typical (def $7.000): incluye 2 acompañamientos + 1 bebida.
//   3er acompañamiento en adelante = $2.000 c/u.
// - Especial = su precio propio; NO incluye acompañamientos gratis → cada acompañamiento
//   con un especial = $2.000 c/u. Incluye 1 bebida gratis.
// - Extras (papas fritas, tostones, jugo/consomé EXTRA) = $2.000 c/u (o el precio de la
//   config si difiere). Van en item.extras[].
// - Delivery centro = $1.000 (foráneo lo confirma la pareja, no se computa acá).

const EXTRA_DEFAULT = 2000;
const DELIVERY_CENTRO = 1000;

// Normalización robusta a acentos/tildes (alineada con handlers.js `normaliza` y claude.js `_norm`):
// quita diacríticos vía NFD para que "Puré"/"Pure"/"puré" matcheen igual el nombre del especial/extra
// contra el menú. Antes solo trim+lowercase → una diferencia de tilde erraba el precio (bug de cobro).
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function basePlato(proteina, menuActivo, fallback) {
  const especiales = menuActivo?.platos_especiales ?? [];
  const esp = especiales.find((e) => norm(e.nombre) === norm(proteina));
  if (esp) return {
    esEspecial: true, base: Number(esp.precio) || 0,
    // Cupo de agregados INCLUIDOS del especial (gratis). Retrocompat: si no tiene, 0 (todo paga, como antes).
    incluidos: Array.isArray(esp.agregados_incluidos) ? esp.agregados_incluidos.length : 0,
  };
  const precioMenu = menuActivo?.price_typical ?? fallback?.plato_estandar?.precio ?? 7000;
  return { esEspecial: false, base: precioMenu, incluidos: null };
}

function precioExtra(nombre, menuActivo) {
  const ex = (menuActivo?.extras_pagados ?? []).find((e) => norm(e.nombre) === norm(nombre));
  return ex ? Number(ex.precio) || EXTRA_DEFAULT : EXTRA_DEFAULT;
}

// Calcula un item: base + acompañamientos pagos + extras.
// - Estándar: 2 agregados incluidos (gratis), 3º+ a $2.000 c/u.
// - Especial: su propio CUPO de incluidos (gratis) según su config; los que exceden, $2.000 c/u.
//   Así "cambiar/quitar un incluido" = gratis y "añadir de más" = paga, sale solo del slice.
export function calcularItem(item, menuActivo, fallback) {
  const { esEspecial, base, incluidos } = basePlato(item.proteina, menuActivo, fallback);
  const incluyeN = esEspecial
    ? (incluidos ?? 0)
    : (menuActivo ? 2 : fallback?.plato_estandar?.incluye_agregados ?? 2);
  const agregados = Array.isArray(item.agregados) ? item.agregados.map(String) : [];
  const agregadosIncluidos = agregados.slice(0, incluyeN);
  const agregadosPagos = agregados.slice(incluyeN);
  const extras = (Array.isArray(item.extras) ? item.extras : [])
    .map(String)
    .filter((e) => e.trim())
    .map((nombre) => ({ nombre, precio: precioExtra(nombre, menuActivo) }));
  const agregadosCost = agregadosPagos.length * EXTRA_DEFAULT;
  const extrasCost = extras.reduce((a, e) => a + e.precio, 0);
  // Componentes del especial componible (pieza 2): incluidos en el base; un componente sustituido por un
  // ítem pagado suma su costo (regla incluido→pagado). Retrocompat: sin componentes → [] y costo 0.
  const componentes = (Array.isArray(item.componentes) ? item.componentes : [])
    .filter((c) => c && c.nombre)
    .map((c) => ({ nombre: String(c.nombre), costo: Number(c.costo) || 0, reemplazable: !!c.reemplazable }));
  const componentesCost = componentes.reduce((a, c) => a + (c.costo || 0), 0);
  const subtotal = base + agregadosCost + extrasCost + componentesCost;
  return {
    proteina: item.proteina ?? 'ítem',
    esEspecial,
    base,
    agregadosIncluidos,
    agregadosPagos,
    componentes,
    extras,
    bebida: item.bebida ?? null,
    modificaciones: (item.modificaciones ?? '').trim(),
    subtotal,
  };
}

export function calcularPedido(items, tipo, menuActivo, fallback) {
  const lineas = (Array.isArray(items) ? items : []).map((it) => calcularItem(it, menuActivo, fallback));
  const subtotales = lineas.reduce((a, l) => a + l.subtotal, 0);
  const delivery = tipo === 'delivery' ? DELIVERY_CENTRO : 0;
  return { lineas, delivery, total: subtotales + delivery };
}

const clp = (n) => '$' + Number(n).toLocaleString('es-CL');

// Arma el TEXTO del resumen, determinista, desde el pedido ya calculado.
// La suma de las líneas con precio SIEMPRE da el total (es el mismo cómputo).
// extrasPedido (opcional): líneas a nivel pedido que suman al total (ej. ajuste "fuera de carta" aplicado por
// el local, pieza 2 FASE B). Retrocompat: sin extras → salida idéntica.
export function construirResumen(calc, extrasPedido = []) {
  let out = '📋 *Tu pedido:*';
  for (const l of calc.lineas) {
    const desc = l.agregadosIncluidos.length ? ` con ${l.agregadosIncluidos.join(', ')}` : '';
    out += `\n\n• *${l.proteina}*${desc} — ${clp(l.base)}`;
    // Componentes del especial componible: los incluidos (costo 0) en una línea; los sustituidos por pagado, con su costo.
    if (l.componentes && l.componentes.length) {
      const incl = l.componentes.filter((c) => !c.costo).map((c) => c.nombre);
      if (incl.length) out += `\n   viene con: ${incl.join(', ')}`;
      for (const c of l.componentes.filter((c) => c.costo)) out += `\n   · ${c.nombre} — ${clp(c.costo)}`;
    }
    if (l.bebida) out += `\n   · ${String(l.bebida).replace(/\s+natural$/i, '').trim()} (incluido)`;
    for (const a of l.agregadosPagos) out += `\n   · ${a} — ${clp(EXTRA_DEFAULT)}`;
    for (const e of l.extras) out += `\n   · ${e.nombre} — ${clp(e.precio)}`;
    if (l.modificaciones) out += `\n   _(${l.modificaciones})_`;
    out += `\n   Subtotal: ${clp(l.subtotal)}`;
  }
  if (calc.delivery) out += `\n\n+ Delivery: ${clp(calc.delivery)}`;
  let total = calc.total;
  for (const e of (Array.isArray(extrasPedido) ? extrasPedido : [])) {
    out += `\n\n+ ${e.nombre} — ${clp(e.costo)}`;
    total += Number(e.costo) || 0;
  }
  out += `\n\n*Total: ${clp(total)}*`;
  return out;
}
