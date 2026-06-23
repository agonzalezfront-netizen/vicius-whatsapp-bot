import 'dotenv/config';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

import { loadMenu } from './menu.js';
import { handleMessage } from './handlers.js';
import { startQRServer, setQR, clearQR, setStatus } from './qr-server.js';
import { cargarMenuActual } from './pedidos-client.js';
import { validateMenuPayload, setActiveMenu } from './active-menu.js';
import { startNotifPoller } from './notif-poller.js';
import { startComunicacionesPoller } from './comunicaciones-poller.js';

// Handoff v1 Fase 2: poller del saliente humano. Flag-gated (dormido por default).
const COMUNICACIONES = (process.env.COMUNICACIONES_ENABLED ?? 'false') === 'true';
import { loadTenantsFromEnv, tenantCount, getTenant } from './cloud-api/tenants.js';
import { makeCloudClient, subscribeAppToWaba } from './cloud-api/client.js';
import { makeCloudSock } from './cloud-api/adapter.js';

// Transporte activo: 'baileys' (default, coexiste con el webhook Cloud API) o
// 'cloud' (cutover total: Baileys NO arranca, todo el tráfico va por Cloud API).
const TRANSPORT = (process.env.TRANSPORT ?? 'baileys').toLowerCase();

// Socket Baileys vigente (cambia en reconexiones). El notif-poller lo usa para
// mandar los mensajes salientes (MSG-2/MSG-3) al cliente.
let currentSock = null;

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino/file', options: { destination: 1 } },
});

const AUTH_DIR = process.env.AUTH_DIR ?? './auth_info_baileys';

let menu;
let backoffMs = 2000;
const BACKOFF_MAX_MS = 30000;

async function connectSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ baileys_version: version.join('.') }, 'baileys version');

  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ mod: 'baileys' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // Descarga de media transport-agnostic (handlers.js usa sock.downloadImage).
  sock.downloadImage = (msg) => downloadMediaMessage(msg, 'buffer', {});

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      setQR(qr);
      setStatus('qr-pending');
      logger.info('QR generado, disponible en HTTP /qr');
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      setStatus('closed');
      logger.warn({ code, shouldReconnect, backoffMs }, 'conexión cerrada');
      if (shouldReconnect) {
        setTimeout(() => {
          connectSocket().catch((e) => logger.error({ err: e.message }, 'reconnect falla'));
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      } else {
        logger.error('loggedOut — borrar AUTH_DIR para re-emparejar');
      }
    } else if (connection === 'open') {
      clearQR();
      setStatus('open');
      backoffMs = 2000;
      currentSock = sock; // el notif-poller usa el sock vigente
      logger.info({ jid: sock.user?.id }, '✅ WhatsApp conectado');
    } else if (connection === 'connecting') {
      setStatus('connecting');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage({ sock, logger, menu, msg });
      } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, 'handleMessage falla');
      }
    }
  });
}

async function bootstrap() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.error('ANTHROPIC_API_KEY no seteada en env. Abortando.');
    process.exit(1);
  }

  // RE-PAIR COMPLETO one-shot (anti-Bad MAC). Si RESET_AUTH trae un token distinto al
  // ya aplicado, borra TODO el auth-state (creds.json + TODAS las sesiones de libsignal)
  // → fuerza un emparejamiento NUEVO con QR (device unlink + re-pair). Borrar solo las
  // session files NO limpia el Bad MAC (confirmado en issues Baileys); por eso se borra
  // el dir entero. Idempotente por token: cambiar el valor de RESET_AUTH fuerza otro
  // re-pair; el mismo valor no repite (no loopea el QR). El marker vive en el volumen.
  if (process.env.RESET_AUTH) {
    const token = String(process.env.RESET_AUTH).trim();
    const marker = path.join(AUTH_DIR, '.reset_token');
    let lastToken = null;
    try { lastToken = fs.readFileSync(marker, 'utf-8').trim(); } catch { /* sin marker */ }
    if (lastToken !== token) {
      try {
        // AUTH_DIR es el MOUNTPOINT del volumen de Railway → no se puede borrar el dir
        // en sí (rmSync del mountpoint falla con EBUSY/EPERM). Borramos su CONTENIDO
        // (creds.json + todas las sesiones), dejando el mountpoint intacto.
        if (fs.existsSync(AUTH_DIR)) {
          for (const f of fs.readdirSync(AUTH_DIR)) {
            fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
          }
        } else {
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        fs.writeFileSync(marker, token);
        logger.warn({ token }, '🔄 RESET_AUTH: contenido del auth-state borrado (creds + sesiones) — se generará QR nuevo para re-pair');
      } catch (e) {
        logger.error({ err: e.message }, 'RESET_AUTH: falló al borrar el auth-state');
      }
    } else {
      logger.info({ token }, 'RESET_AUTH ya aplicado para este token, se ignora (idempotente, sin loop de QR)');
    }
  }

  menu = loadMenu();
  logger.info({ proteinas: (menu.proteinas_dia ?? []).length }, 'menu cargado');

  // Recuperar el último menú publicado desde el wizard (sobrevive redeploys).
  // Best-effort: si el wizard no responde, el bot arranca igual (sin menú del día).
  try {
    const payload = await cargarMenuActual();
    if (payload) {
      const { valid } = validateMenuPayload(payload);
      if (valid) {
        const m = setActiveMenu(payload);
        logger.info({ id: m.id, day: m.day_label }, '🔁 menú activo recuperado del wizard (persistencia)');
      } else {
        logger.warn('menú persistido en el wizard no validó, se ignora');
      }
    } else {
      logger.info('no había menú persistido en el wizard');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'no se pudo recuperar el menú del wizard (no crítico, el bot arranca igual)');
  }

  // Cargar tenants Cloud API (si hay env). El webhook /webhook coexiste con Baileys:
  // el bot vivo sigue en Baileys (número real) y el webhook atiende el número de
  // prueba de Meta (Fase A). El cutover total a Cloud API es Fase B.
  const nTenants = loadTenantsFromEnv();
  logger.info({ tenants: nTenants }, nTenants ? '🌐 Cloud API webhook activo (tenants cargados)' : 'Cloud API sin tenants (solo Baileys)');

  startQRServer(logger, { menu, handleMessage });

  if (TRANSPORT === 'cloud') {
    // CUTOVER: transporte 100% Cloud API. Baileys NO se inicia (el número ya no está
    // en WhatsApp app/Baileys, sino registrado en la Cloud API). El webhook /webhook
    // (montado en startQRServer) atiende los entrantes; el notif-poller envía las
    // notificaciones validado/rechazado por Cloud API en vez de por el sock Baileys.
    logger.warn({ transport: 'cloud' }, '🌐 TRANSPORT=cloud — Baileys NO arranca; transporte 100% Cloud API');
    // Auto-suscribir la app a la WABA (entrantes). Idempotente; clave cuando Meta crea
    // una WABA nueva al registrar el número (sus webhooks no llegan hasta suscribir la app).
    if (process.env.WA_WABA_ID && process.env.WA_TOKEN) {
      // WA_WEBHOOK_OVERRIDE_URL existe SOLO en staging → el bot staging se auto-registra un webhook
      // override para SU WABA (la de test) en cada boot, sin tocar el webhook de app (prod). En prod
      // esta env var NO está → comportamiento de siempre (suscripción simple al webhook de app).
      subscribeAppToWaba(process.env.WA_WABA_ID, process.env.WA_TOKEN, logger, {
        overrideCallbackUri: process.env.WA_WEBHOOK_OVERRIDE_URL,
        verifyToken: process.env.WA_VERIFY_TOKEN,
      }).catch(() => {});
    } else {
      logger.warn('TRANSPORT=cloud sin WA_WABA_ID — no auto-suscribo la WABA (verificá webhooks manual)');
    }
    // sock Cloud API del tenant productivo único (para los mensajes salientes del poller).
    const getCloudSock = () => {
      const tenant = getTenant(process.env.WA_PHONE_NUMBER_ID);
      if (!tenant) {
        logger.error('TRANSPORT=cloud pero no hay tenant para WA_PHONE_NUMBER_ID — el poller no podrá enviar');
        return null;
      }
      return makeCloudSock(makeCloudClient(tenant, logger), logger);
    };
    startNotifPoller({ getSock: getCloudSock, logger });
    if (COMUNICACIONES) startComunicacionesPoller({ getSock: getCloudSock, logger, menu });
  } else {
    await connectSocket();
    // Gestor de pedidos: polling de notificaciones validado/rechazado → MSG-2/MSG-3.
    startNotifPoller({ getSock: () => currentSock, logger });
    if (COMUNICACIONES) startComunicacionesPoller({ getSock: () => currentSock, logger, menu });
  }

  // Cierre GRACEFUL (anti-corrupción de sesiones Signal). Causa raíz del "Bad MAC"
  // 2026-06-08: matar el proceso mid-write durante un redeploy corrompe los archivos
  // de session-state de libsignal (creds.json sobrevive, las sesiones por-contacto no)
  // → mensajes posteriores de ese contacto fallan a descifrar (un check / no llegan).
  // Issues Baileys: unclean shutdown corrompe el state. Mitigación: en SIGTERM cerramos
  // el socket limpio y damos tiempo a que terminen las escrituras async del auth-state
  // antes de salir, en vez de un process.exit(0) inmediato.
  let cerrando = false;
  async function shutdownGraceful(sig) {
    if (cerrando) return;
    cerrando = true;
    logger.info({ sig }, 'cierre graceful — flush del auth-state para no corromper sesiones Signal');
    try { currentSock?.end?.(undefined); } catch (e) { logger.warn({ err: e?.message }, 'sock.end falló'); }
    // Margen para que las escrituras pendientes de useMultiFileAuthState terminen.
    await new Promise((r) => setTimeout(r, 3000));
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdownGraceful('SIGTERM'));
  process.on('SIGINT', () => shutdownGraceful('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'bootstrap fatal');
  process.exit(1);
});
