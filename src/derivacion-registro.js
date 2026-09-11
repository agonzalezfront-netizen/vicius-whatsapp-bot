// CONTRATO WhatsApp p1/p6 (Alberto 15:23–16:11) — registro per-tenant del modo DERIVACIÓN + guarda de CLASE.
//
// En modo 'derivacion' el bot NO conversa: al escribir un cliente, le manda UN mensaje único que deriva a la
// carta y calla durante la ventana (config.wa_ventana_horas). Pasada la ventana, si el cliente vuelve a
// escribir, se le REENVÍA (cuenta como otro primer contacto; ADDENDUM 2). Este módulo es la GUARDA DE CLASE:
// garantiza EXACTAMENTE 1 saliente de derivación por (tenant, cliente) por ventana — determinista, sin LLM.
//
// Persistencia: JSON en el volumen durable de Railway (el mismo de AUTH_DIR → sobrevive redeploys). Se escribe
// FUERA del borrado de RESET_AUTH (index.js preserva este archivo). No usamos SQLite para no meter una dep
// nativa en la imagen alpine: el dato es diminuto (un ts por cliente + contadores por mes) y la escritura es
// rara (1 por cliente por ventana). Atomicidad: el chequeo-y-registro es SÍNCRONO y sin `await` en el medio
// → inmune al intercalado del event loop (Node es single-thread); el archivo se escribe con temp+rename.
import fs from 'node:fs';
import path from 'node:path';

const AUTH_DIR = process.env.AUTH_DIR ?? './auth_info_baileys';
// En el mismo volumen que el auth-state (durable). index.js NO lo borra en RESET_AUTH (lo preserva por nombre).
const REGISTRO_PATH = process.env.DERIVACION_REGISTRO_PATH ?? path.join(AUTH_DIR, 'derivacion-registro.json');
const TZ = process.env.TZ ?? 'America/Santiago';

// Forma: { contactos: { "<tenant>|<jid>": ultimo_envio_ts_ms }, contadores: { "<tenant>|<yyyy-mm>": {entrada,reenvio,aviso} } }
let _cache = null;

function _cargar() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(REGISTRO_PATH, 'utf-8'));
  } catch {
    _cache = {};   // sin archivo aún (primer arranque) o corrupto → empezamos limpio
  }
  if (!_cache || typeof _cache !== 'object') _cache = {};
  if (!_cache.contactos) _cache.contactos = {};
  if (!_cache.contadores) _cache.contadores = {};
  return _cache;
}

function _persistir(reg) {
  const dir = path.dirname(REGISTRO_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ya existe */ }
  const tmp = `${REGISTRO_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg));
  fs.renameSync(tmp, REGISTRO_PATH);   // rename es atómico en el mismo FS → nunca deja el registro a medias
}

// Mes calendario en la TZ del local (no UTC): la facturación es por mes calendario (Cortex 15:44).
function _mes(nowMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' });
  const p = fmt.formatToParts(new Date(nowMs));
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

/**
 * GUARDA DE CLASE (p6): registra —si corresponde— un saliente de derivación para (tenant, jid) y dice si enviar.
 *   - sin contacto previo            → { enviar: true,  tipo: 'entrada' }  (primer contacto)
 *   - contacto previo, fuera ventana → { enviar: true,  tipo: 'reenvio' }  (cuenta otro primer contacto)
 *   - dentro de la ventana           → { enviar: false, tipo: null }       (silencio total, sin excepciones)
 * Síncrona y atómica. `ventanaMs` = wa_ventana_horas * 3600_000. Incrementa el contador del mes al enviar.
 */
export function registrarContactoDerivacion(tenant, jid, ventanaMs, nowMs = Date.now()) {
  const reg = _cargar();
  const key = `${tenant}|${jid}`;
  const ultimo = reg.contactos[key];
  if (ultimo != null && (nowMs - ultimo) < ventanaMs) {
    return { enviar: false, tipo: null };   // dentro de la ventana → no se reenvía (guarda de clase)
  }
  const tipo = ultimo == null ? 'entrada' : 'reenvio';
  reg.contactos[key] = nowMs;
  const mesKey = `${tenant}|${_mes(nowMs)}`;
  const c = reg.contadores[mesKey] ?? { entrada: 0, reenvio: 0, aviso: 0 };
  c[tipo] += 1;
  reg.contadores[mesKey] = c;
  _persistir(reg);
  return { enviar: true, tipo };
}

/**
 * Registra un AVISO saliente al cliente (listo/ya-casi/validado/…, los que manda el notif-poller cuando el
 * local tiene el interruptor ON). Alimenta el 2º contador del panel (ADDENDUM 3). `ventanaAbierta` = si el
 * cliente escribió dentro de la ventana (entonces Meta no lo cobra aparte; cuenta como entrada para el aviso).
 */
export function registrarAvisoSaliente(tenant, nowMs = Date.now()) {
  const reg = _cargar();
  const mesKey = `${tenant}|${_mes(nowMs)}`;
  const c = reg.contadores[mesKey] ?? { entrada: 0, reenvio: 0, aviso: 0 };
  c.aviso += 1;
  reg.contadores[mesKey] = c;
  _persistir(reg);
  return c.aviso;
}

// Contadores del mes para el export/panel (ADDENDUM 3): {entrada, reenvio, aviso}. entrada+reenvio = mensajes
// de entrada consumidos (contra los 1.000 gratis de Meta); aviso = plantillas salientes iniciadas por el local.
export function contadoresDelMes(tenant, nowMs = Date.now()) {
  const reg = _cargar();
  return { ...{ entrada: 0, reenvio: 0, aviso: 0 }, ...(reg.contadores[`${tenant}|${_mes(nowMs)}`] ?? {}) };
}

// Solo para tests: fuerza recargar del archivo (los tests reescriben/borran el archivo entre casos).
export function _resetCacheParaTest() { _cache = null; }
