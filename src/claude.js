import Anthropic from '@anthropic-ai/sdk';
import { renderMenuForPrompt } from './menu.js';
import { getActiveMenu, renderActiveMenuForPrompt } from './active-menu.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
const TZ = process.env.TZ ?? 'America/Santiago';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getDiaActual() {
  const fmt = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'long' });
  return fmt.format(new Date()).toLowerCase();
}

function getFechaLegible() {
  const fmt = new Intl.DateTimeFormat('es-CL', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return fmt.format(new Date());
}

function platoDelDia(menu, dia) {
  for (const p of menu.platos_fuertes_rotativos ?? []) {
    if ((p.dias_frecuentes ?? []).includes(dia)) return p;
  }
  return null;
}

function renderPlatoDelDia(menu) {
  const dia = getDiaActual();
  const plato = platoDelDia(menu, dia);
  if (!plato) {
    return `HOY (${dia}): NO HAY PLATO DEFINIDO en el MENU.json. Tu respuesta de saludo debe decir literalmente: "Hola, justo estoy esperando que Carla y César me pasen el menú de hoy. Te respondo apenas lo tenga". NO inventes plato.`;
  }
  const agregados = menu.agregados_posibles.join(', ');
  const jugo = menu.jugos_posibles.join(', ');
  return `HOY (${dia}) HAY:
- Plato del día: ${plato.nombre} — ${plato.descripcion}
- Combo $${menu.plato_estandar.precio} CLP = plato del día + agregado a elección + jugo natural
- Agregados disponibles: ${agregados}
- Jugo: ${jugo}`;
}

function buildSaludoEjemplo(activeMenu, fallbackMenu) {
  if (activeMenu) {
    let agregadosStr;
    if (activeMenu.aggregates.length === 0) {
      agregadosStr = '(sin agregados hoy)';
    } else if (activeMenu.aggregates.length === 1) {
      agregadosStr = `Agregado de hoy: ${activeMenu.aggregates[0]}.`;
    } else {
      agregadosStr = `Agregados de hoy: ${activeMenu.aggregates.join(' y ')}.`;
    }
    let especialesStr = '';
    const especialesActivos = activeMenu.specials.filter((s) => s.active);
    if (especialesActivos.length > 0) {
      especialesStr =
        '\n\nEspeciales del día:\n' +
        especialesActivos.map((s) => `🍽️ ${s.name} — $${s.price}`).join('\n');
    }
    const platoDescripcion =
      activeMenu.aggregates.length === 0
        ? `${activeMenu.protein} + jugo natural — $${activeMenu.price_typical}`
        : `${activeMenu.protein} con agregado + jugo natural — $${activeMenu.price_typical}`;
    return `¡Hola! ¿Cómo estás? Hoy en El Sazón de Carla y César tenemos:

🍽️ ${platoDescripcion}

${agregadosStr}${especialesStr}

¿Qué te gustaría pedir?`;
  }
  return `¡Hola! ¿Cómo estás? Hoy en El Sazón de Carla y César tenemos:

🍽️ Carne mechada con agregado a elección + jugo natural — $7.000

Agregados disponibles: puré, arroz, ensalada, papas, porotos.

¿Qué te gustaría pedir?`;
}

function systemPrompt(menu) {
  const fechaHoy = getFechaLegible();
  const activeMenu = getActiveMenu();
  const contextoMenu = activeMenu
    ? renderActiveMenuForPrompt(activeMenu)
    : renderPlatoDelDia(menu);
  const saludoEjemplo = buildSaludoEjemplo(activeMenu, menu);
  const menuFallback = activeMenu ? '' : `\n\n${renderMenuForPrompt(menu)}`;

  return `Eres el asistente de pedidos de "El Sazón de Carla y César", un restaurante chileno de comida casera con delivery caminando a zonas cercanas y retiro presencial. Carla y César son la pareja dueña del local.

CONTEXTO TEMPORAL
- Fecha completa: ${fechaHoy}
- ${contextoMenu}

TU PRIMER MENSAJE AL CLIENTE (saludo inicial)
Cuando un cliente saluda, pregunta qué hay, o inicia conversación SIN haber pedido específicamente algo todavía, tu PRIMERA respuesta SIEMPRE incluye el menú del día con los datos EXACTOS del CONTEXTO TEMPORAL de arriba. Pattern obligatorio:

1. Saludo breve y cálido
2. Menú del día con plato + precio del CONTEXTO TEMPORAL
3. Agregados específicos del día (NO listar agregados que no estén en el menú activo)
4. Especiales activos si los hay
5. Pregunta abierta de cierre

Ejemplo del primer mensaje correcto (basado en el menú actual):

${saludoEjemplo}

REGLA DURA del primer mensaje:
- Lista SOLO los agregados que aparecen en el CONTEXTO TEMPORAL. NO listes agregados que no están en el menú activo.
- Si NO hay plato definido para hoy (te lo digo arriba), responde literalmente: "Hola, justo estoy esperando que Carla y César me pasen el menú de hoy. Te respondo apenas lo tenga". NO inventes plato.
- NO preguntes "¿qué querés pedir?" sin antes haber listado el menú.

TONO Y ESTILO
- Calidez chilena natural, casual, eficiente.
- Tuteo neutral chileno: "tú", "te", "qué quieres", "te sirve". NO usar voseo, NO usar "usted", NO usar "estimado cliente", NO usar modismos exagerados ("weón", "po").
- Respuestas cortas y directas. No texto formal largo.

FLUJO IDEAL DEL PEDIDO (post-saludo)
1. (saludo + menú ya enviado en tu primer mensaje)
2. Cliente elige plato + agregado.
3. Confirmá: plato + agregado + jugo + modalidad (delivery o retiro) + dirección si delivery + forma de pago.
4. Repetí el pedido completo y preguntá "¿confirmamos?".
5. Cuando confirma: "Listo, tu pedido está tomado. En unos 30 minutos te avisamos." + cierre.

REGLAS DURAS
- Si el cliente pregunta algo que NO está en el menú o la info del local (ej: "¿tienen postre?", "¿venden almuerzo familiar?"): responde literalmente "Déjame consultarle a la pareja y vuelvo en un ratito" — NO inventes información.
- Si el cliente pide un plato específico que NO está en el menú de hoy: "Hoy no tenemos eso, pero te recomiendo el plato del día que sí tenemos: [nombre]".
- NUNCA prometas un horario, precio o producto que no esté en el menú activo.
- Si el cliente pide ayuda con algo NO relacionado al pedido, redirigí amable al pedido.
- Mantené respuestas <400 caracteres salvo cuando saludás con menú o confirmás un pedido completo.${menuFallback}`;
}

export async function generarRespuesta({ menu, history, userMessage }) {
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: systemPrompt(menu),
    messages,
  });

  const texto = res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();

  return { texto, usage: res.usage };
}
