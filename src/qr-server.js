import { createServer } from 'node:http';
import qrcode from 'qrcode';

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

export function startQRServer(logger, port = parseInt(process.env.PORT ?? '8080', 10)) {
  const server = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: connectionStatus, hasQR: !!currentQR }));
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
    logger.info({ port }, 'QR server escuchando');
  });

  return server;
}
