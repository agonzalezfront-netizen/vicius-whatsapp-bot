import { createServer } from 'node:http';
import qrcode from 'qrcode';
import { getActiveMenu, setActiveMenu, validateMenuPayload, clearActiveMenu } from './active-menu.js';
import { clearAllHistories } from './handlers.js';
import { guardarMenuActual } from './pedidos-client.js';
import { handleVerify, handleIncoming } from './cloud-api/webhook.js';
import { tenantCount } from './cloud-api/tenants.js';
import { generarRespuesta } from './claude.js';

let currentQR = null;
let connectionStatus = 'starting';

export function setQR(qr) {
  currentQR = qr;
}

export function clearQR() {
  currentQR = null;
}

export function setStatus(status) {
  connectionStatus = status;
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    req.setEncoding('utf-8');
    let raw = '';
    let receivedBytes = 0;
    req.on('data', (chunk) => {
      receivedBytes += Buffer.byteLength(chunk, 'utf-8');
      if (receivedBytes > maxBytes) {
        reject(new Error(`body excede max ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Body crudo (string) — necesario para validar la firma HMAC del webhook de Meta.
function readRawBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    req.setEncoding('utf-8');
    let raw = '';
    let n = 0;
    req.on('data', (chunk) => {
      n += Buffer.byteLength(chunk, 'utf-8');
      if (n > maxBytes) { reject(new Error('body demasiado grande')); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function jsonResponse(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

export function startQRServer(logger, opts = {}) {
  const port = opts.port ?? parseInt(process.env.PORT ?? '8080', 10);
  const fallbackMenu = opts.menu ?? null;
  const handleMessage = opts.handleMessage ?? null;
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.url === '/healthz') {
      const m = getActiveMenu();
      jsonResponse(res, 200, {
        status: connectionStatus,
        hasQR: !!currentQR,
        commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? 'dev').slice(0, 7),
        build: 'pedido-carrito-v1',
        active_menu: m ? { id: m.id, day_label: m.day_label, published_at: m.published_at } : null,
        // Diagnóstico Cloud API (booleans, NO expone valores de secretos).
        cloud_api: {
          transport: (process.env.TRANSPORT ?? 'baileys').toLowerCase(),
          tenants: tenantCount(),
          has_token: !!process.env.WA_TOKEN,
          has_app_secret: !!process.env.WA_APP_SECRET,
          has_verify_token: !!process.env.WA_VERIFY_TOKEN,
          phone_number_id_set: !!process.env.WA_PHONE_NUMBER_ID,
        },
      });
      return;
    }

    // Diagnóstico de conectividad al LLM (incidente "Premature close" 2026-06-18).
    // Hace una llamada mínima a Anthropic y reporta ok/error → permite probar el fix
    // de transporte por curl directo, sin pasar por WhatsApp.
    if (req.url === '/healthz/claude') {
      const t0 = Date.now();
      try {
        const r = await generarRespuesta({
          menu: fallbackMenu ?? { plato_estandar: { precio: 7000, incluye_agregados: 2 }, datos_transferencia: { configurado: false } },
          history: [],
          userMessage: 'ping (diagnóstico, responde solo "ok")',
          sesion: 'continua',
        });
        jsonResponse(res, 200, { ok: true, ms: Date.now() - t0, sample: (r.texto ?? '').slice(0, 60) });
      } catch (err) {
        jsonResponse(res, 200, { ok: false, ms: Date.now() - t0, error: err?.message ?? String(err) });
      }
      return;
    }

    // Diagnóstico de validez del token de Meta (WA_TOKEN). Hace un GET liviano a la
    // Graph API con el token del env → permite saber si el token está vivo o expiró
    // (#190 OAuthException), sin que el agente maneje el secreto. Útil para vigilar el
    // vencimiento del token temporal y confirmar el System User permanente nuevo.
    if (req.url === '/healthz/meta') {
      const t0 = Date.now();
      const token = process.env.WA_TOKEN;
      const pnid = process.env.WA_PHONE_NUMBER_ID;
      const ver = process.env.GRAPH_API_VERSION ?? 'v25.0';
      if (!token || !pnid) {
        jsonResponse(res, 200, { ok: false, error: 'falta WA_TOKEN o WA_PHONE_NUMBER_ID en el entorno' });
        return;
      }
      try {
        const r = await fetch(`https://graph.facebook.com/${ver}/${pnid}?fields=verified_name,display_phone_number,quality_rating`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          jsonResponse(res, 200, { ok: true, ms: Date.now() - t0, phone: j.display_phone_number ?? null, verified_name: j.verified_name ?? null });
        } else {
          const e = j?.error ?? {};
          jsonResponse(res, 200, { ok: false, ms: Date.now() - t0, status: r.status, code: e.code, type: e.type, error: e.message });
        }
      } catch (err) {
        jsonResponse(res, 200, { ok: false, ms: Date.now() - t0, error: err?.message ?? String(err) });
      }
      return;
    }

    if (req.url === '/api/menu/today' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        logger.warn({ err: err.message }, 'POST /api/menu/today body inválido');
        jsonResponse(res, 400, { ok: false, error: `JSON inválido: ${err.message}` });
        return;
      }
      const validation = validateMenuPayload(body);
      if (!validation.valid) {
        logger.warn({ errors: validation.errors }, 'POST /api/menu/today payload inválido');
        jsonResponse(res, 400, { ok: false, errors: validation.errors });
        return;
      }
      try {
        const menu = setActiveMenu(body);
        const cleared = clearAllHistories();
        // Persistir el menú publicado en el wizard (fire-and-forget) para sobrevivir redeploys.
        guardarMenuActual(body).catch((err) =>
          logger.warn({ err: err.message }, 'no se pudo persistir el menú en el wizard (no crítico)'),
        );
        logger.info(
          { id: menu.id, day: menu.day_label, proteinas: menu.proteinas_dia.length, agregados: menu.agregados_incluidos.length, histories_cleared: cleared },
          '✅ menú activo publicado + history limpiada',
        );
        jsonResponse(res, 200, {
          ok: true,
          active_menu_id: menu.id,
          published_at: menu.published_at,
          received_at: menu.received_at,
          histories_cleared: cleared,
        });
      } catch (err) {
        logger.error({ err: err.message }, 'POST /api/menu/today error guardando');
        jsonResponse(res, 500, { ok: false, error: 'error guardando menú' });
      }
      return;
    }

    if (req.url === '/api/menu/today' && req.method === 'GET') {
      const m = getActiveMenu();
      if (!m) {
        jsonResponse(res, 200, { ok: true, active: null });
      } else {
        jsonResponse(res, 200, { ok: true, active: m });
      }
      return;
    }

    if (req.url === '/api/menu/today' && req.method === 'DELETE') {
      clearActiveMenu();
      logger.info('menú activo borrado, fallback a config/menu.json');
      jsonResponse(res, 200, { ok: true, cleared: true });
      return;
    }

    if (req.url === '/qr' || req.url === '/') {
      if (connectionStatus === 'open') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp bot conectado</title>
<style>body{font-family:system-ui;text-align:center;padding:60px;background:#075E54;color:white}h1{font-size:2em}</style>
</head><body><h1>✅ Bot conectado</h1><p>El bot ya está escuchando mensajes. No necesitás escanear ningún QR.</p></body></html>`);
        return;
      }

      if (!currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>QR pendiente</title>
<meta http-equiv="refresh" content="3">
<style>body{font-family:system-ui;text-align:center;padding:60px}</style>
</head><body><h1>Esperando QR…</h1><p>Status: ${connectionStatus}</p><p>Esta página se recarga sola.</p></body></html>`);
        return;
      }

      try {
        const dataUrl = await qrcode.toDataURL(currentQR, { width: 512, margin: 2 });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Vincular WhatsApp · El Sazón de Carla y César</title>
<meta http-equiv="refresh" content="20">
<style>body{font-family:system-ui;text-align:center;padding:30px;background:#f0f2f5}h1{color:#075E54}img{border:8px solid white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);max-width:90vw}.steps{max-width:480px;margin:24px auto;text-align:left;background:white;padding:20px;border-radius:8px}</style>
</head><body>
<h1>📱 Vincular WhatsApp del bot</h1>
<img src="${dataUrl}" alt="QR de WhatsApp"/>
<div class="steps">
<p><b>Pasos en el teléfono del bot (+56910215579):</b></p>
<ol>
<li>Abrí WhatsApp</li>
<li>Tocá los 3 puntos arriba a la derecha → <b>Dispositivos vinculados</b></li>
<li>Tocá <b>Vincular un dispositivo</b></li>
<li>Escaneá este QR</li>
</ol>
<p style="color:#666;font-size:.9em">Esta página se recarga sola cada 20s. Si el QR expira, aparece uno nuevo automáticamente.</p>
</div>
</body></html>`);
      } catch (err) {
        logger.error({ err: err.message }, 'qr render http falla');
        res.writeHead(500);
        res.end('QR render error');
      }
      return;
    }

    // ── WhatsApp Cloud API webhook ──
    if (req.url.split('?')[0] === '/webhook') {
      // GET: handshake de verificación de Meta.
      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://localhost');
        const query = Object.fromEntries(u.searchParams.entries());
        const r = handleVerify(query);
        res.writeHead(r.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(r.body);
        if (r.ok) logger.info('webhook: handshake de verificación OK');
        else logger.warn('webhook: handshake rechazado (verify_token no coincide)');
        return;
      }
      // POST: mensajes entrantes.
      if (req.method === 'POST') {
        let raw;
        try {
          raw = await readRawBody(req);
        } catch (err) {
          logger.warn({ err: err.message }, 'webhook POST body inválido');
          res.writeHead(400); res.end('bad request'); return;
        }
        if (!handleMessage) {
          logger.error('webhook: handleMessage no inyectado en startQRServer');
          res.writeHead(500); res.end('not configured'); return;
        }
        const sig = req.headers['x-hub-signature-256'];
        let result;
        try {
          result = await handleIncoming(raw, sig, { logger, menu: fallbackMenu, handleMessage });
        } catch (err) {
          logger.error({ err: err.message, stack: err.stack }, 'webhook handleIncoming falló');
          result = { status: 200 }; // 200 igual: evita que Meta reintente en loop por un bug nuestro
        }
        res.writeHead(result.status); res.end();
        return;
      }
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'HTTP server escuchando (QR + API menú)');
  });

  return server;
}
