import { generarRespuesta } from '../src/claude.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const args = { menu: { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} }, history: [], userMessage: 'hola', sesion: 'nueva' };
const r1 = await generarRespuesta(args);
const r2 = await generarRespuesta(args); // idéntico → debe leer del caché
const u1 = r1.usage, u2 = r2.usage;
console.log('call 1: cache_creation=', u1.cache_creation_input_tokens, 'cache_read=', u1.cache_read_input_tokens, 'input=', u1.input_tokens);
console.log('call 2: cache_creation=', u2.cache_creation_input_tokens, 'cache_read=', u2.cache_read_input_tokens, 'input=', u2.input_tokens);
console.log('\nrespuesta normal?', r1.texto.slice(0,60).replace(/\n/g,' '));
console.log(u2.cache_read_input_tokens > 0 ? '✅ CACHING FUNCIONA (call 2 leyó del caché)' : '❌ no hubo cache read');
