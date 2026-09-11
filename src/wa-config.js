// CONTRATO WhatsApp p1 — cliente de la config del modo WhatsApp por local (leída del wizard).
// El wizard expone en /api/menu-actual un objeto `wa` = { modo, ventana_horas, copy } (copy ya resuelta
// server-side → el bot la manda VERBATIM). Caché corto por slug + fallback (Cortex 15:57): si el wizard no
// responde, usamos el último valor conocido; si nunca lo tuvimos, 'conversacional' (no regresión: el bot
// sigue como hoy en vez de callar por error). NO rompe el flujo si el wizard está caído.
import { fetchConReintento } from './http-retry.js';

const WIZARD_BASE = process.env.WIZARD_BASE ?? 'https://viciusstudio.cl/wizard';
const WIZARD_AUTH =
  'Basic ' + Buffer.from(`${process.env.WIZARD_USER ?? ''}:${process.env.WIZARD_PASS ?? ''}`).toString('base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ViciusBot/1.0';   // UA de navegador (WAF Imunify360)
const TTL_MS = parseInt(process.env.WA_CFG_TTL_MS ?? '60000', 10);      // caché corto: 60s

const DEFAULT = { modo: 'conversacional', ventana_horas: 24, copy: '' };
const _cache = new Map();   // slug -> { ts, wa }

export async function getWaConfig(slug = 'sazon', now = Date.now()) {
  const hit = _cache.get(slug);
  if (hit && now - hit.ts < TTL_MS) return hit.wa;
  try {
    // NO crítico + cacheado + con fallback → falla RÁPIDO (sin reintentos, timeout corto): no queremos que
    // un wizard lento agregue latencia al hot-path de CADA mensaje (incluye el modo conversacional del piloto).
    const res = await fetchConReintento(
      `${WIZARD_BASE}/api/menu-actual?local=${encodeURIComponent(slug)}`,
      { method: 'GET', headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA }, signal: AbortSignal.timeout(2500) },
      { reintentos: 0 },
    );
    const data = await res.json();
    const wa = { ...DEFAULT, ...(data?.wa ?? {}) };
    _cache.set(slug, { ts: now, wa });
    return wa;
  } catch {
    if (hit) return hit.wa;   // cache viejo mejor que nada
    return DEFAULT;           // sin info → conversacional (no regresión)
  }
}

// Para tests: limpia el caché.
export function _resetWaConfigCache() { _cache.clear(); }
