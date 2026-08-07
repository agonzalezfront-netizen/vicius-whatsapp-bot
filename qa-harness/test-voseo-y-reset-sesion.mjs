// Bugs 2026-08-07 (test vivo de Cortex): (1) voseo customer-facing en el output IA ("Mirá"),
// (2) el bot arrastraba contexto de un pedido de hace semanas (estado sintético sin TTL).
// Defensa: neutralizador determinista + age-check del pedido + scan de lexicón de los strings del bot.
import assert from 'node:assert';
import fs from 'node:fs';
import url from 'node:url';
import path from 'node:path';
import { neutralizarVoseo } from '../src/claude.js';
import { pedidoReciente } from '../src/handlers.js';

const __dir = path.dirname(url.fileURLToPath(import.meta.url));
let fail = 0;
const t = (nombre, fn) => { try { fn(); console.log('  ✓', nombre); } catch (e) { fail++; console.log('  ✗', nombre, '\n    ', e.message); } };

console.log('neutralizarVoseo (Bug 1):');
t('convierte "Mirá" del caso real → "Mira" (preserva mayúscula)', () => {
  assert.strictEqual(neutralizarVoseo('Mirá, de tu pedido hoy no tenemos: Arroz. ¿Qué prefieres?'),
    'Mira, de tu pedido hoy no tenemos: Arroz. ¿Qué prefieres?');
});
t('convierte varias formas vos → neutro', () => {
  assert.strictEqual(neutralizarVoseo('¿Querés que lo armemos? Elegí y avisame.'),
    '¿Quieres que lo armemos? Elige y avísame.');
});
t('NO toca palabras neutras ni parciales', () => {
  assert.strictEqual(neutralizarVoseo('Puedes elegir; mira el menú y come tranquilo.'),
    'Puedes elegir; mira el menú y come tranquilo.');
  assert.strictEqual(neutralizarVoseo('miramos la carta'), 'miramos la carta'); // no parte "mirá" dentro de "miramos"
});
t('tolera vacío/null', () => { assert.strictEqual(neutralizarVoseo(''), ''); assert.strictEqual(neutralizarVoseo(null), null); });

console.log('pedidoReciente (Bug 2):');
const AHORA = new Date('2026-08-07T17:00:00').getTime();
t('pedido de hace 3 semanas → NO reciente (no inyecta estado)', () => {
  assert.strictEqual(pedidoReciente({ created_at: '2026-07-17T13:00:00', status: 'en_cocina' }, AHORA), false);
});
t('pedido de hace 2h → reciente', () => {
  assert.strictEqual(pedidoReciente({ created_at: '2026-08-07T15:00:00', status: 'en_cocina' }, AHORA), true);
});
t('sin created_at (pre-BUG7, ej. pedido del 17/7) → NO reciente (default conservador)', () => {
  assert.strictEqual(pedidoReciente({ status: 'en_cocina' }, AHORA), false);
  assert.strictEqual(pedidoReciente({ created_at: null, status: 'en_cocina' }, AHORA), false);
});
t('created_at inválido → NO reciente', () => {
  assert.strictEqual(pedidoReciente({ created_at: 'no-es-fecha', status: 'en_cocina' }, AHORA), false);
});

console.log('scan de lexicón en strings de salida del bot:');
const VOSEO = ['querés','podés','tenés','sabés','hacés','decís','venís','preferís','necesitás','subís',
  'mirá','elegí','sumá','revisá','volvé','abrí','avisá','contá','mandá','escribí','probá','tocá','dejá','vení',
  'decime','contame','escribime','avisame','decinos','contanos','escribinos','avisanos'];
const RE = new RegExp("(?<![\\p{L}])(" + VOSEO.join('|') + ")(?![\\p{L}])", 'giu');
for (const f of ['flujo-botones.js', 'comunicaciones-client.js', 'qr-server.js']) {
  t('sin voseo en ' + f, () => {
    const src = fs.readFileSync(path.join(__dir, '..', 'src', f), 'utf8');
    // excluir el array de palabras que el bot ACEPTA como input del cliente (no es salida) y los
    // comentarios de línea (un voseo en un comentario no llega al cliente).
    const salida = src.split('\n')
      .filter((l) => !/_algunaPalabra|\['si'/.test(l))
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    const m = salida.match(RE);
    assert.ok(!m, 'voseo encontrado: ' + (m ? [...new Set(m)].join(', ') : ''));
  });
}

console.log(fail ? `\n❌ ${fail} fallo(s)` : '\n✅ todo verde');
process.exit(fail ? 1 : 0);
