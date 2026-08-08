// Defensa estructural contra voseo en los strings CUSTOMER-FACING del bot (directriz #7: español
// neutral). El voseo ya se coló una vez (test vivo 07-08: "Mirá", "Escribime"). Este test barre los
// archivos de salida deterministas contra un lexicón → rojo si vuelve a entrar voseo.
//
// Uso: node qa-harness/test-no-voseo.mjs   (exit 1 si hay hallazgos)
//
// NO escanea src/claude.js: su system prompt LISTA palabras voseo a propósito (la instrucción que le dice
// al LLM que NO vosee) → sería falso positivo. La salida del LLM se neutraliza en runtime por esa instrucción.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Archivos con strings de salida deterministas hacia el cliente / dueño.
const FILES = [
  'src/flujo-botones.js',        // flujo de botones (mensajes al cliente)
  'src/qr-server.js',            // página de setup (dueño)
  'src/comunicaciones-client.js',// push al equipo
  'src/handlers.js',             // frenos y avisos al cliente
];

// Lexicón: formas ACENTUADAS del voseo (el neutro va sin ese acento) + enclíticos inequívocos.
// Se excluyen "dale"/"vos": aparecen como palabras de INPUT a matchear (no salida) y darían falso positivo.
const VOSEO = [
  'querés', 'tenés', 'podés', 'necesitás', 'preferís', 'venís', 'sabés', 'decís', 'subís',
  'revisá', 'sumá', 'elegí', 'volvé', 'mirá', 'tocá', 'abrí', 'subí', 'escribí', 'escribime',
  'decime', 'contá', 'mandá', 'fijate', 'avisá', 'hacé', 'andá', 'dejá', 'cargá', 'pegá', 'apretá',
  'avisanos', 'decinos', 'escribinos', 'contanos', 'mandanos',
];
const RE = new RegExp('(?<![\\wáéíóúñ])(' + VOSEO.join('|') + ')(?![\\wáéíóúñ])', 'i');

const hallazgos = [];
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const lineas = fs.readFileSync(abs, 'utf8').split('\n');
  lineas.forEach((linea, i) => {
    const t = linea.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // saltar comentarios
    const m = RE.exec(linea);
    if (m) hallazgos.push(`${rel}:${i + 1}  «${m[1]}»  → ${t.slice(0, 90)}`);
  });
}

if (hallazgos.length) {
  console.error('❌ VOSEO customer-facing detectado (usar español neutral):\n' + hallazgos.join('\n'));
  process.exit(1);
}
console.log('✓ sin voseo customer-facing en', FILES.length, 'archivos');
