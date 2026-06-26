// Núcleo del harness de QA del bot Sazón.
//
// Provee:
//   - CostMeter: acumula el `usage` real de cada llamada y CORTA DURO al llegar
//     a un tope en USD (default $5). El tope es una garantía de código, no una
//     estimación: cualquier turno que haría superar el cap lanza antes de gastar.
//   - runBotTurn: manda un mensaje al bot real (generarRespuesta) y aplica la
//     MISMA post-lógica que handlers.js (procesarCalc + extraerPedido), de modo
//     que devolvemos exactamente lo que vería el cliente + el total calculado
//     por código + el pedido extraído. Sin WhatsApp.
//
// Model-agnostic: el bot lee process.env.ANTHROPIC_MODEL (ver src/claude.js),
// así que para comparar modelos (Haiku vs Sonnet vs ...) se setea esa env var
// ANTES de importar claude.js. PRICING tiene una entrada por modelo.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

// ── Precios (USD por millón de tokens) ──────────────────────────────────────
// FUENTE DE VERDAD: console pricing de Anthropic. Estos valores son
// CONSERVADORES a propósito (si sobreestiman, el cap corta antes = más seguro).
// Verificar contra https://platform.claude.com antes de confiar en montos finos.
export const PRICING = {
  'claude-haiku-4-5':  { in: 1.0,  out: 5.0  },
  'claude-sonnet-4-6': { in: 3.0,  out: 15.0 },
  'claude-opus-4-8':   { in: 15.0, out: 75.0 },
};

function priceFor(model) {
  return PRICING[model] ?? PRICING['claude-sonnet-4-6']; // fallback caro = conservador
}

// Costo en USD de un `usage` ({input_tokens, output_tokens}) para un modelo dado.
export function usageCostUSD(usage, model) {
  if (!usage) return 0;
  const p = priceFor(model);
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  // Prompt caching (si el modelo lo usara): cache_read es ~0.1x, cache_write ~1.25x.
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (inTok * p.in +
      outTok * p.out +
      cacheRead * p.in * 0.1 +
      cacheWrite * p.in * 1.25) /
    1_000_000
  );
}

export class CapExceededError extends Error {
  constructor(spent, cap) {
    super(`Tope de gasto alcanzado: $${spent.toFixed(4)} de $${cap.toFixed(2)} — corte duro.`);
    this.name = 'CapExceededError';
    this.spent = spent;
    this.cap = cap;
  }
}

export class CostMeter {
  constructor({ capUSD = 5.0 } = {}) {
    this.capUSD = capUSD;
    this.spentUSD = 0;
    this.calls = 0;
    this.byModel = {}; // model -> { calls, in, out, usd }
  }

  // Registra el costo de una llamada YA hecha.
  record(usage, model) {
    const cost = usageCostUSD(usage, model);
    this.spentUSD += cost;
    this.calls += 1;
    const b = (this.byModel[model] ??= { calls: 0, in: 0, out: 0, usd: 0 });
    b.calls += 1;
    b.in += usage?.input_tokens ?? 0;
    b.out += usage?.output_tokens ?? 0;
    b.usd += cost;
    return cost;
  }

  // Lanza si YA superamos el cap. Llamar después de cada record() para frenar
  // el loop apenas se cruza el umbral.
  assertUnderCap() {
    if (this.spentUSD >= this.capUSD) {
      throw new CapExceededError(this.spentUSD, this.capUSD);
    }
  }

  remaining() {
    return Math.max(0, this.capUSD - this.spentUSD);
  }

  summary() {
    return {
      spentUSD: Number(this.spentUSD.toFixed(4)),
      capUSD: this.capUSD,
      remainingUSD: Number(this.remaining().toFixed(4)),
      calls: this.calls,
      byModel: this.byModel,
    };
  }
}

// ── Post-lógica del bot, replicada de src/handlers.js (NO se exporta allá) ───
// Mantener en sync con handlers.js líneas ~109-154. Si cambia el contrato de
// <<CALC>> / <<PEDIDO>> en el bot, actualizar acá.

function formatCLP(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

export function procesarCalc(texto) {
  const m = texto.match(/<<CALC>>([\s\S]*?)<<FIN>>/);
  let total = null;
  let limpio = texto;
  if (m) {
    try {
      const arr = JSON.parse(m[1].trim());
      if (Array.isArray(arr)) {
        total = arr.reduce((a, x) => a + (Number(x) || 0), 0);
      }
    } catch {
      total = null;
    }
    limpio = limpio.replace(/<<CALC>>[\s\S]*?<<FIN>>/g, '').trim();
  }
  if (total !== null) {
    limpio = limpio.replace(/\{\{TOTAL\}\}/g, formatCLP(total));
  } else {
    limpio = limpio.replace(/\{\{TOTAL\}\}/g, '').trim();
  }
  limpio = limpio.replace(/\n{3,}/g, '\n\n');
  return { limpio, total };
}

export function extraerPedido(texto) {
  const m = texto.match(/<<PEDIDO>>([\s\S]*?)<<FIN>>/);
  if (!m) return { limpio: texto, pedido: null };
  const limpio = texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/, '').trim();
  try {
    return { limpio, pedido: JSON.parse(m[1].trim()) };
  } catch {
    return { limpio, pedido: null };
  }
}

// ── runBotTurn ───────────────────────────────────────────────────────────────
// Un turno del bot, sin WhatsApp. Devuelve lo que vería el cliente + datos
// estructurados. `meter` (CostMeter) registra el gasto y permite cortar.
//
// history: array de { role: 'user'|'assistant', content: string } (lo que el
// cliente VE — texto limpio, igual que el bot guarda en su history).
let _generarRespuesta = null;
async function getGenerar() {
  if (!_generarRespuesta) {
    ({ generarRespuesta: _generarRespuesta } = await import('../src/claude.js'));
  }
  return _generarRespuesta;
}

// Cálculo/resumen por código (precios.js) + menú activo — para replicar la post-lógica real
// de handlers.js (reemplazo de {{RESUMEN}} y total). Import dinámico: evita side-effects al cargar.
const { calcularPedido, construirResumen } = await import('../src/precios.js');
const { getActiveMenu: getActiveMenuLib } = await import('../src/active-menu.js');

export async function runBotTurn({ menu, history, userMessage, sesion = 'nueva', estadoPedido = null, meter }) {
  const generarRespuesta = await getGenerar();
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

  const { texto, usage } = await generarRespuesta({ menu, history, userMessage, sesion, estadoPedido });

  if (meter) {
    meter.record(usage, model);
    meter.assertUnderCap(); // corta el loop si cruzamos el tope
  }

  // Misma cadena que handlers.js: primero CALC (suma + {{TOTAL}} OBSOLETOS), luego PEDIDO, luego ESCALAR.
  const calc = procesarCalc(texto);
  const { limpio: sinPedido, pedido } = extraerPedido(calc.limpio);
  // Handoff v1: recortar el marcador <<ESCALAR>> y exponer si el bot derivó a humano.
  const marcador = /<<ESCALAR>>/.test(sinPedido);
  let textoVisible = sinPedido.replace(/<<ESCALAR>>/g, '');

  // 🔁 SINCRONIZADO con handlers.js (2026-06-26): el resumen y el total se arman POR CÓDIGO
  // (precios.js) desde el <<PEDIDO>>, y se inyectan donde el bot puso {{RESUMEN}}. El harness
  // ANTES no replicaba esto (quedó en la era <<CALC>>/{{TOTAL}}) → falso positivo "resumen vacío".
  let total = null;
  if (pedido) {
    const calcPedido = calcularPedido(pedido.items, pedido.tipo, getActiveMenuLib(), menu);
    if (textoVisible.includes('{{RESUMEN}}')) {
      textoVisible = textoVisible.replace(/\{\{RESUMEN\}\}/g, construirResumen(calcPedido));
    }
    total = calcPedido.total;
  }
  // Limpieza final (handlers.js): borrar cualquier placeholder/bloque remanente que el cliente no debe ver.
  textoVisible = textoVisible
    .replace(/<<CALC>>[\s\S]*?<<FIN>>/g, '')
    .replace(/\{\{RESUMEN\}\}/g, '')
    .replace(/\{\{TOTAL\}\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Red de seguridad determinista (bug 2026-06-22): derivación verbal sin marcador → escala
  // igual, salvo que haya emisión de pedido (mismo guard que handlers.js).
  const { derivacionVerbal } = await import('../src/claude.js');
  const derivoVerbal = !pedido && derivacionVerbal(textoVisible);
  const escalar = marcador || derivoVerbal;
  const escalarVia = marcador ? 'marcador' : (derivoVerbal ? 'deteccion-verbal' : null);

  return { textoVisible, total, pedido, escalar, escalarVia, usage, model, textoCrudo: texto };
}

// Menú de prueba representativo (fixtures puros, sin side-effects).
export { MENU_PRUEBA, MENU_FALLBACK } from './fixtures.mjs';
