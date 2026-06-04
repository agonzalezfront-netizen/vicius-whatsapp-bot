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

function renderPlatoDelDia(menu) {
  const dia = getDiaActual();
  const proteinas = (menu.proteinas_dia ?? [])
    .filter((p) => p.disponible !== false)
    .map((p) => `- ${p.nombre}`)
    .join('\n');
  if (!proteinas) {
    return `HOY (${dia}): NO HAY MENÚ DEFINIDO. Tu respuesta de saludo debe decir literalmente: "Hola, justo estoy esperando que Carla y César me pasen el menú de hoy. Te respondo apenas lo tenga". NO inventes.`;
  }
  const incluidos = (menu.agregados_incluidos ?? []).join(', ');
  const extras = (menu.extras_pagados ?? [])
    .map((e) => `${e.nombre} ($${e.precio})`)
    .join(', ') || '(ninguno)';
  const incluyeN = menu.plato_estandar?.incluye_agregados ?? 2;
  return `HOY (${dia}) — menú estándar (fallback, sin menú del día publicado):
- Un menú $${menu.plato_estandar.precio} = proteína del día + ${incluyeN} agregados + jugo natural.
- Proteínas:
${proteinas}
- Agregados incluidos (elegí ${incluyeN}): ${incluidos}
- Extras opcionales (se cobran aparte): ${extras}
- 3er agregado o doble: +$${menu.extra_3er_agregado ?? 2000} c/u.`;
}

function buildSaludoEjemplo(activeMenu, fallbackMenu) {
  if (activeMenu) {
    const proteinas = activeMenu.proteinas_dia
      .filter((p) => p.disponible !== false)
      .map((p) => `• ${p.nombre}`)
      .join('\n');
    const incluidos = activeMenu.agregados_incluidos.join(', ');
    const extras = activeMenu.extras_pagados ?? [];
    const extrasStr = extras.length
      ? '\n\n➕ Extras opcionales ($2.000 c/u): ' + extras.map((e) => e.nombre).join(', ')
      : '';
    return `¡Hola! ¿Cómo estás? Hoy en El Sazón de Carla y César tenemos:

🍽️ Proteínas del día:
${proteinas}

Cada menú ($${activeMenu.price_typical}) incluye 2 agregados a elección + jugo natural.
Agregados: ${incluidos}.${extrasStr}

¿Qué te gustaría pedir?`;
  }
  return `¡Hola! ¿Cómo estás? Hoy en El Sazón de Carla y César tenemos comida casera. Decime qué buscás y armamos tu menú.`;
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

PAGO — REGLAS DE TONO
- Si el cliente paga en EFECTIVO, preguntá "¿necesitas vuelto?" (NUNCA "¿con cuánto pagas?" — suena a desconfianza/cobro agresivo). Si dice que sí, preguntá de cuánto es el billete para tener el vuelto listo.
- Si el cliente paga por TRANSFERENCIA, decile que cuando hagas el pedido le pasás los datos para transferir, y que el pedido se confirma cuando reciba el comprobante. Tono natural, no policial.

INFO DEL LOCAL (preguntas frecuentes — respondé con estos datos exactos)
- Dirección del local: Vicuña Mackenna Oriente 6571, La Florida.
- ¿Estacionamiento? "No tenemos estacionamiento (somos Garita)."
- ¿Tienen delivery? "Sí, dentro de 1.5 a 2 km del centro de La Florida."
- ¿Se puede comer en el local? "Sí, te esperamos en Vicuña Mackenna Oriente 6571."

DELIVERY — zonas y costos (NO calcules automático, el dueño confirma)
- Centro La Florida (hasta ~1.5 km): $1.000 de delivery.
- Más lejos / foráneo: entre $3.000 y $4.000, sujeto a evaluación.
- SIEMPRE pedí la dirección de entrega. NO confirmes el costo de delivery foráneo tú mismo — decí "el costo exacto te lo confirma la pareja según la distancia, ronda los $3.000 a $4.000". El dueño valida manual.

ESCALADO A HUMANO — cuándo derivar a Carla y César
Respondé literalmente "Déjame consultarle a la pareja y vuelvo en un ratito" (y NO sigas respondiendo de ese tema) cuando:
- Te preguntan algo que NO está en el menú ni en INFO DEL LOCAL (ej: "¿hay que reservar?", "¿aceptan perros/mascotas?", "¿hacen eventos?", "¿tienen vegano?").
- Hay una queja, reclamo, o problema con un pedido previo.
- Piden algo fuera de lo común (pedido gigante, factura empresa, condiciones especiales).
- Detectás enojo o frustración del cliente.
NUNCA inventes una respuesta para estos casos. Mejor derivar que improvisar mal. Cuando derivás, el dueño ve la conversación en su teléfono y responde él.

REGLAS DURAS
- Si el cliente pregunta algo que NO está en el menú ni en INFO DEL LOCAL: "Déjame consultarle a la pareja y vuelvo en un ratito" — NO inventes información.
- Si el cliente pide un plato específico que NO está en el menú de hoy: "Hoy no tenemos eso, pero te recomiendo el plato del día que sí tenemos: [nombre]".
- NUNCA prometas un horario, precio o producto que no esté en el menú activo o en INFO DEL LOCAL.
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
