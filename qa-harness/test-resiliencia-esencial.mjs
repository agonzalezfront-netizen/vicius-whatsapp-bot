// Resiliencia ESENCIAL (encargo 2026-06-29): si crearPedido falla definitivamente, el bot NO debe
// fingir éxito → manda un aviso honesto + escala. Wizard simulado: persiste el flujo-estado (para que
// el pedido AVANCE hasta CONFIRMAR) pero devuelve 520 en POST /api/pedidos (crearPedido falla).
import { setActiveMenu } from '../src/active-menu.js';
import { manejarTurnoBotones } from '../src/flujo-botones-router.js';

setActiveMenu({
  day_label: 'Test Lunes', day_code: 'L', published_at: new Date().toISOString(),
  proteinas_dia: [{ nombre: 'Pollo', disponible: true }],
  agregados_incluidos: ['Arroz', 'Puré'], bebida_incluida: ['Consomé'], extras_pagados: [],
  platos_especiales: [],
});

const estados = new Map();
let pedidoIntentos = 0, escaló = false;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const m = opts.method || 'GET';
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('/api/flujo-estado/borrar')) { try { estados.delete(JSON.parse(opts.body).cliente_jid); } catch {} return ok({ ok: true }); }
  if (u.includes('/api/flujo-estado') && m === 'POST') { const b = JSON.parse(opts.body); estados.set(b.cliente_jid, b.estado); return ok({ ok: true }); }
  if (u.includes('/api/flujo-estado')) { const jid = decodeURIComponent((u.split('jid=')[1] || '')); return ok({ estado: estados.get(jid) ?? null }); }
  if (u.includes('/api/pedidos')) { pedidoIntentos++; return { ok: false, status: 520, json: async () => ({}), text: async () => '' }; } // crearPedido FALLA
  if (u.includes('/estado') && (opts.body || '').includes('requiere_humano')) { escaló = true; return ok({ ok: true }); }
  return ok({ ok: true }); // push, etc.
};

const sent = [];
const sock = { sendMessage: async (_jid, payload) => { sent.push(payload); return { key: { id: 'x' } }; } };
const logger = { info() {}, warn() {}, error() {} };
const JID = '56922222222@s.whatsapp.net';

let fails = 0;
const check = (c, m) => { console.log((c ? '  OK  ' : 'FAIL  ') + m); if (!c) fails++; };

try {
  // 1er turno: "hola" → dispara el saludo + menú + render inicial (NO consume input). Recién después
  // se procesan los toques de botón.
  await manejarTurnoBotones({ sock, jid: JID, senderName: 'Test', btnId: null, texto: 'hola', logger });
  const seq = ['prot:0', 'ac:0', 'ac_listo', 'beb:0', 'ex_no', 'mm_seguir', 'mod_local', 'pay_local', 'conf_si'];
  for (const btnId of seq) {
    await manejarTurnoBotones({ sock, jid: JID, senderName: 'Test', btnId, texto: null, logger });
  }
} catch (e) {
  check(false, `no debe tirar (tiró: ${e.message})`);
} finally {
  globalThis.fetch = origFetch;
}

const honesto = sent.some((p) => /problema al registrar/i.test(p.text || ''));
console.log(`\nmensajes: ${sent.length} | intentos crearPedido (con reintento): ${pedidoIntentos} | escaló: ${escaló}`);
check(pedidoIntentos >= 3, 'crearPedido reintentó ante 5xx (≥3 intentos = 1 + 2 reintentos)');
check(honesto, '🎯 mandó aviso HONESTO ("problema al registrar") — NO fingió éxito');
check(escaló, 'escaló a humano al fallar el pedido');

console.log(fails ? `\n❌ ${fails} fallo(s)` : '\n✅ esencial: el fallo de crearPedido es VISIBLE (honesto + escala), no se finge éxito');
process.exit(fails ? 1 : 0);
