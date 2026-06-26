// Web Push (mini-proyecto 2026-06-24) — envío de notificaciones del SO al equipo (Carla/César)
// para que la alerta de `requiere_humano` suene con el teléfono BLOQUEADO / app en 2º plano.
//
// ARQUITECTURA: el ENVÍO vive acá (bot/Railway) porque la Fase 5 (re-push de constancia) necesita
// un proceso vivo, y el bot ya corre pollers 24/7 (reuso, sin loop nuevo). El FRONTEND (suscripción)
// vive en el wizard; las suscripciones se guardan en cartera.db y las leemos por API. Self-contained:
// NO importa de comunicaciones-client (evita ciclos) — duplica las 3 líneas de base/auth del wizard.
//
// Best-effort SIEMPRE: ninguna función de acá debe romper el flujo del bot (se loguea y sigue).

import webpush from 'web-push';

const WIZARD_BASE = process.env.WIZARD_BASE ?? 'https://viciusstudio.cl/wizard';
const WIZARD_AUTH =
  'Basic ' + Buffer.from(`${process.env.WIZARD_USER ?? ''}:${process.env.WIZARD_PASS ?? ''}`).toString('base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ViciusBot/1.0';

const PUB = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:agonzalez.front@gmail.com';

let _configured = false;
if (PUB && PRIV) {
  try {
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);
    _configured = true;
  } catch {
    _configured = false; // claves inválidas → push deshabilitado, el bot sigue normal
  }
}

export function pushConfigured() {
  return _configured;
}

async function _getSubscriptions() {
  const res = await fetch(`${WIZARD_BASE}/api/push/list`, {
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`push/list HTTP ${res.status}`);
  const d = await res.json();
  return d.subscriptions ?? [];
}

// Robustez push (2026-06-26): en vez de BORRAR la suscripción caída (410/404), la MARCAMOS como
// caída en el wizard → el board lo detecta y re-suscribe + avisa (banner). Re-suscribir la sana.
async function _markDown(endpoints) {
  if (!endpoints.length) return;
  await fetch(`${WIZARD_BASE}/api/push/mark-down`, {
    method: 'POST',
    headers: { Authorization: WIZARD_AUTH, 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoints }),
  }).catch(() => {});
}

// Envía una notificación push a TODAS las suscripciones del equipo. Best-effort, nunca throw.
// opts: { title, body, url='comunicaciones', tag='requiere-humano' }.
export async function enviarPushEquipo({ title, body, url = 'comunicaciones', tag = 'requiere-humano' }, logger = console) {
  if (!_configured) return { sent: 0, skipped: 'sin VAPID' };
  let subs;
  try {
    subs = await _getSubscriptions();
  } catch (err) {
    logger.warn?.({ err: err.message }, 'push: no pude leer suscripciones del wizard');
    return { sent: 0, error: err.message };
  }
  if (!subs.length) return { sent: 0 };

  const payload = JSON.stringify({ title, body, tag, data: { url } });
  const caducadas = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, payload);
        sent++;
      } catch (err) {
        const code = err?.statusCode;
        // 404/410 = suscripción muerta (device desinstaló / permiso revocado / expiró) → marcarla
        // caída (no borrar) para que el board la detecte y re-suscriba + avise.
        if (code === 404 || code === 410) caducadas.push(s.endpoint);
        else logger.warn?.({ code, err: err?.message }, 'push: envío a una suscripción falló');
      }
    }),
  );
  if (caducadas.length) {
    await _markDown(caducadas);
    logger.info?.({ caidas: caducadas.length }, 'push: suscripciones caídas marcadas (el board re-suscribe)');
  }
  if (sent) logger.info?.({ sent }, '🔔 push enviado al equipo');
  return { sent, pruned: caducadas.length };
}
