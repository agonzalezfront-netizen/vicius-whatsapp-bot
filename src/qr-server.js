import { createServer } from 'node:http';
import qrcode from 'qrcode';
import { getActiveMenu, setActiveMenu, validateMenuPayload, clearActiveMenu } from './active-menu.js';

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

export function startQRServer(logger, port = parseInt(process.env.PORT ?? '8080', 10)) {
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
        active_menu: m ? { id: m.id, day_label: m.day_label, published_at: m.published_at } : null,
      });
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
        logger.info(
          { id: menu.id, day: menu.day_label, protein: menu.protein, aggregates: menu.aggregates.length },
          '✅ menú activo publicado',
        );
        jsonResponse(res, 200, {
          ok: true,
          active_menu_id: menu.id,
          published_at: menu.published_at,
          received_at: menu.received_at,
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

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'HTTP server escuchando (QR + API menú)');
  });

  return server;
}
