import 'dotenv/config';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

import { loadMenu } from './menu.js';
import { handleMessage } from './handlers.js';
import { startQRServer, setQR, clearQR, setStatus } from './qr-server.js';

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

  menu = loadMenu();
  logger.info({ platos: menu.platos_fuertes_rotativos.length }, 'menu cargado');

  startQRServer(logger);

  await connectSocket();

  process.on('SIGTERM', () => {
    logger.info('SIGTERM, exit');
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'bootstrap fatal');
  process.exit(1);
});
