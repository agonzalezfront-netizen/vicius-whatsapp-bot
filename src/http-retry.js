// Reintento HTTP ante 5xx — compartido por los clientes del wizard (pedidos + comunicaciones).
//
// El wizard (Flask en cPanel, detrás de Cloudflare) devuelve 5xx intermitentes bajo carga:
//   - 500: el worker LSAPI/Passenger del Flask se agotó/erroró (origen).
//   - 520/525: Cloudflare no obtuvo respuesta válida del origen (lento/caído/SSL).
// Son transitorios: un reintento corto casi siempre los absorbe. NO reintentamos 4xx (no se
// arreglan reintentando) ni 2xx. Causa raíz del bug 2026-06-29 (botones del menú inicial no
// llegaban): setEstadoFlujo recibía un 520 y tiraba, abortando el turno antes de enviar la lista.
//
// IMPORTANTE — la decisión fatal/no-fatal NO vive acá: esta función SOLO reintenta y devuelve la
// respuesta (o la última fallida). Cada caller decide qué hacer si tras los reintentos sigue
// fallando, según si el resultado es esencial para el cliente o no (ver encargo resiliencia integral).
export async function fetchConReintento(url, opts, { reintentos = 2, baseMs = 250 } = {}) {
  let ultimo;
  for (let i = 0; i <= reintentos; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok || res.status < 500) return res; // 2xx/4xx → devolver tal cual (no reintentar 4xx)
      ultimo = res;
    } catch (e) {
      // Error de red/transporte (DNS, conexión cortada, timeout): también transitorio → reintentar.
      ultimo = { ok: false, status: 0, _err: e, json: async () => ({}), text: async () => '' };
    }
    if (i < reintentos) await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
  }
  return ultimo;
}
