import { generarRespuesta } from '../src/claude.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
async function caso(nombre, mensajePost) {
  const history = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '¡Hola! Este es el menú de hoy...' },
    { role: 'user', content: 'un menú de pollo asado con puré y ensalada, jugo' },
    { role: 'assistant', content: 'Perfecto 🙂 Anotado: Pollo asado, puré y ensalada, jugo.\n\n¿Cómo seguimos?\n1️⃣ Agregar otro menú\n2️⃣ Sumar un extra a tu pedido (papas fritas, tostones — $2.000 c/u)\n3️⃣ Cerrar el pedido' },
  ];
  const { texto } = await generarRespuesta({ menu: MENU_FALLBACK, history, userMessage: mensajePost, sesion: 'continua' });
  const visible = texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/g, '').trim();
  return visible;
}
// CASO 1: ambiguo — "consome" con jugo ya elegido → debe PREGUNTAR con opciones
const c1 = await caso('ambiguo', 'consome');
const pregunta = /cambiar.*consom|consom.*extra/is.test(c1) && /1️⃣|1\)/.test(c1) && /\?/.test(c1);
const asumioCambio = /cambio anotado|en lugar de|cambié/i.test(c1) && !pregunta;
console.log('--- C1 "consome" (ambiguo) ---\n'+c1.slice(0,350)+'\n→ ¿pregunta con opciones?', pregunta?'✅':'❌', '| ¿asumió cambio?', asumioCambio?'❌ SÍ':'✅ no');
// CASO 2: inequívoco extra — "unas papas fritas" → directo, sin desambiguar
const c2 = await caso('extra claro', 'agregale unas papas fritas');
const directo2 = /papas/i.test(c2) && !/cambiar.*papas/i.test(c2);
console.log('\n--- C2 "papas fritas" (extra claro) ---\n'+c2.slice(0,250)+'\n→ ¿lo suma directo?', directo2?'✅':'❌');
// CASO 3: inequívoco cambio — "mejor consomé en vez de jugo" → cambio directo
const c3 = await caso('cambio claro', 'mejor consomé en vez de jugo');
// Solo mirar la 1ª línea (la acción), no el menú de opciones posterior.
const accion3 = c3.split('\n')[0];
const directo3 = /cambi/i.test(accion3) && /consom/i.test(accion3) && !/¿cómo lo anoto/i.test(c3);
console.log('\n--- C3 "en vez de jugo" (cambio claro) ---\n'+c3.slice(0,250)+'\n→ ¿cambia directo sin desambiguar?', directo3?'✅':'❌');
