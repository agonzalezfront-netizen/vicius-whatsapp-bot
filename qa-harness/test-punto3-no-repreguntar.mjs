import { generarRespuesta } from '../src/claude.js';
import { MENU_PRUEBA } from './fixtures.mjs';
const { setActiveMenu } = await import('../src/active-menu.js');
setActiveMenu(MENU_PRUEBA);
const MENU_FALLBACK = { datos_transferencia:{configurado:false}, plato_estandar:{precio:7000,incluye_agregados:2} };
const history=[]; const textos=[];
async function turno(u,i){ const {texto}=await generarRespuesta({menu:MENU_FALLBACK,history,userMessage:u,sesion:i===0?'nueva':'continua'}); const visible=texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/g,'').replace(/\{\{RESUMEN\}\}/g,'[RESUMEN]').trim(); history.push({role:'user',content:u}); history.push({role:'assistant',content:visible}); textos.push(visible); return visible; }
const t1 = await turno('hola',0);
const t2 = await turno('quiero un Pabellón criollo',1);          // → debe preguntar bebida + ofrecer acompañamiento en UN mensaje
const t3 = await turno('jugo',2);                                 // responde SOLO bebida → debe avanzar SIN re-preguntar acompañamiento
console.log('--- T2 (tras pedir el especial) ---\n'+t2+'\n');
console.log('--- T3 (tras responder solo "jugo") ---\n'+t3+'\n');
const t2_fusionado = /jugo|consom/i.test(t2) && /acompañamiento/i.test(t2); // 1 turno: bebida + oferta juntas
const t3_repregunta = /acompañamiento/i.test(t3) && /\?/.test(t3) && /quer[éeí]s.*acompañamiento|acompañamiento.*\?/i.test(t3);
const t3_avanza = /algo más|delivery|retir|pago|cerrar|1️⃣|otro menú/i.test(t3);
console.log('T2 pregunta bebida + ofrece acompañamiento JUNTOS (1 turno):', t2_fusionado?'✅':'❌');
console.log('T3 re-pregunta acompañamiento:', t3_repregunta?'❌ SÍ (falla punto 3)':'✅ NO');
console.log('T3 avanza el flujo:', t3_avanza?'✅':'⚠️ revisar');
