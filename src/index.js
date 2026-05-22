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

async function start() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.error('ANTHROPIC_API_KEY no seteada en env. Abortando.');
    process.exit(1);
  }

  const menu = loadMenu();
  logger.info({ platos: menu.platos_fuertes_rotativos.length }, 'menu cargado');

  startQRServer(logger);

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

  sock.ev.on('connection.update', async (update) => {
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
      logger.warn({ code, shouldReconnect }, 'conexión cerrada');
      if (shouldReconnect) start().catch((e) => logger.error({ err: e.message }, 'restart falla'));
    } else if (connection === 'open') {
      clearQR();
      setStatus('open');
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

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM, cerrando socket');
    await sock.end(undefined);
    process.exit(0);
  });
}

start().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'start fatal');
  process.exit(1);
});
