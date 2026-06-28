// Adaptador Cloud API ⇄ lógica del bot. Hace dos cosas:
//   1. normalizeIncoming: convierte el payload del webhook de Meta en mensajes con
//      la MISMA forma que `handlers.js` ya consume (estilo Baileys: msg.key.*,
//      msg.message.conversation / imageMessage, msg.pushName). Así el flujo del
//      pedido NO cambia.
//   2. makeCloudSock: expone un objeto "sock"-like con la misma interfaz que usa
//      handlers.js (sendMessage, readMessages, sendPresenceUpdate, downloadImage),
//      pero implementado sobre la Graph API.
//
// Compatibilidad con el wizard: el wizard guarda `cliente_jid`. Para no romper el
// link de comprobantes (que busca por jid), sintetizamos el MISMO formato de jid de
// Baileys a partir del número: `<numero>@s.whatsapp.net`.

const JID_SUFFIX = '@s.whatsapp.net';

export function phoneToJid(phone) {
  return `${String(phone).replace(/[^\d]/g, '')}${JID_SUFFIX}`;
}

export function jidToPhone(jid) {
  return String(jid).split('@')[0].replace(/[^\d]/g, '');
}

// value = entry[].changes[].value del webhook. Devuelve [{msg, ...}] normalizados.
// Solo mensajes entrantes de cliente (ignora 'statuses' = acks de entrega/lectura).
export function normalizeIncoming(value) {
  const out = [];
  const messages = value?.messages;
  if (!Array.isArray(messages)) return out; // p.ej. notificación de 'statuses' → nada que procesar
  const contactsByWaId = new Map(
    (value.contacts ?? []).map((c) => [c.wa_id, c?.profile?.name])
  );

  for (const m of messages) {
    const from = m.from; // número del cliente, sin '+'
    const jid = phoneToJid(from);
    const pushName = contactsByWaId.get(from) ?? 'cliente';
    const base = { key: { remoteJid: jid, fromMe: false, id: m.id }, pushName, _cloud: true };

    if (m.type === 'text') {
      out.push({ ...base, message: { conversation: m.text?.body ?? '' } });
    } else if (m.type === 'image') {
      out.push({
        ...base,
        message: {
          imageMessage: {
            mimetype: m.image?.mime_type ?? 'image/jpeg',
            caption: m.image?.caption ?? '',
            _cloudMediaId: m.image?.id, // para bajar el binario con la Graph API
          },
        },
      });
    } else if (m.type === 'interactive') {
      // Respuesta a botones/listas. Para el flujo LLM la tratamos como texto (título). Para el tier
      // básico (MODE=buttons) exponemos el ID CRUDO en `_btnId` → ruteo determinista sin LLM.
      const br = m.interactive?.button_reply;
      const lr = m.interactive?.list_reply;
      const texto = br?.title ?? br?.id ?? lr?.title ?? lr?.id ?? '';
      const btnId = br?.id ?? lr?.id ?? null;
      out.push({ ...base, message: { conversation: texto }, _btnId: btnId });
    } else {
      // audio/video/document/sticker/ubicación: por ahora los tratamos como texto vacío
      // con una nota, para no romper el flujo. (Fase B puede ampliar.)
      out.push({ ...base, message: { conversation: '' }, _unsupportedType: m.type });
    }
  }
  return out;
}

// sock-like sobre la Graph API. `client` = makeCloudClient(tenant).
export function makeCloudSock(client, logger = console) {
  return {
    // user.id informativo (paralelo a sock.user?.id de Baileys).
    user: { id: client.phoneNumberId },

    // payload estilo Baileys: { text } o { text, buttons:[{id,title}] }.
    async sendMessage(jid, payload) {
      const to = jidToPhone(jid);
      let resp;
      if (payload?.sections?.length) {
        // Mensaje de lista (tier básico).
        resp = await client.sendList(to, payload.text ?? '', payload.sections, {
          button: payload.button, header: payload.header, footer: payload.footer,
        });
      } else if (payload?.buttons?.length) {
        resp = await client.sendButtons(to, payload.text ?? '', payload.buttons, {
          footer: payload.footer,
          header: payload.header,
        });
      } else {
        resp = await client.sendText(to, payload?.text ?? '');
      }
      // Devolver una key con el id del mensaje (handlers usa key.id para botSentIds).
      const id = resp?.messages?.[0]?.id ?? null;
      return { key: { id, remoteJid: jid, fromMe: true } };
    },

    // handlers.js llama sock.readMessages([msg.key]) → marcamos leído por id.
    async readMessages(keys) {
      for (const k of keys ?? []) {
        if (k?.id) {
          try { await client.markRead(k.id); } catch (e) { logger.warn?.({ err: e.message }, 'markRead falló'); }
        }
      }
    },

    // Cloud API no tiene "composing/paused" presence como Baileys → no-op seguro.
    async sendPresenceUpdate() { /* no aplica en Cloud API */ },

    // Descarga la imagen (comprobante) usando el media id que guardamos al normalizar.
    async downloadImage(msg) {
      const mediaId = msg?.message?.imageMessage?._cloudMediaId;
      if (!mediaId) throw new Error('downloadImage: el mensaje no trae _cloudMediaId');
      const { buffer } = await client.downloadMedia(mediaId);
      return buffer;
    },
  };
}
