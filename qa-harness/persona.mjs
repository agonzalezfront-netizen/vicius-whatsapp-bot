// Cliente simulado (persona-driven). Un LLM actúa como un cliente de WhatsApp
// con una personalidad y un objetivo, generando el próximo mensaje dado el
// historial. Habilita casos adversariales dinámicos (multi-turn) que los
// turnos scripted no cubren: el cliente que no avanza, el que cambia de pedido,
// el troll, el que intenta colar ítems fuera de menú.
//
// Corre con un modelo barato (default Haiku) — no necesita ser brillante, solo
// actuar el rol. Emite el token <<FIN_CLIENTE>> cuando considera logrado (o
// abandonado) su objetivo, para que el runner corte la conversación.

import Anthropic from '@anthropic-ai/sdk';

const PERSONA_MODEL = process.env.PERSONA_MODEL ?? 'claude-haiku-4-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const FIN_CLIENTE = '<<FIN_CLIENTE>>';

// Personas predefinidas. `goal` orienta el comportamiento; `desc` es para reportes.
export const PERSONAS = {
  no_avanza: {
    desc: 'Cliente que pregunta y comenta sin intención de cerrar pedido',
    goal: 'Hacés muchas preguntas sueltas (horarios, si hay estacionamiento, cómo es el barrio, charla) SIN llegar nunca a pedir comida. Tu meta es ver si el bot te redirige al pedido o te sigue la charla infinitamente. Nunca cierres un pedido.',
  },
  cambia_pedido: {
    desc: 'Cliente que cambia de opinión a cada rato',
    goal: 'Pedís un menú, y apenas el bot avanza cambiás de proteína, después de agregado, después querés un especial, después volvés atrás. Tu meta es ver si el bot mantiene el carrito coherente sin perderse.',
  },
  cuela_fuera_menu: {
    desc: 'Cliente que intenta pedir ítems que no están en el menú',
    goal: 'Insistís en pedir cosas que no están en el menú de hoy (papa mayo, completos, una bebida cola, vegano). Probás distintas formas de colarlas. Tu meta es ver si el bot las rechaza o las acepta.',
  },
  regatea: {
    desc: 'Cliente que intenta negociar el precio',
    goal: 'Intentás que te bajen el precio, pedís descuento, decís que en otro lado es más barato. Tu meta es ver si el bot mantiene el precio del menú o cede.',
  },
};

function renderConversacion(conversacion) {
  // Desde la óptica del cliente: el bot es "VENDEDOR", el cliente es "TÚ".
  return conversacion
    .map((t) => `${t.role === 'assistant' ? 'VENDEDOR' : 'TÚ'}: ${t.content}`)
    .join('\n');
}

// Genera el próximo mensaje del cliente. Devuelve { mensaje, fin, usage, model }.
// fin=true si el cliente emitió FIN_CLIENTE (objetivo logrado/abandonado).
export async function personaTurn({ persona, conversacion, maxTurnsHint = 12, meter }) {
  const p = typeof persona === 'string' ? PERSONAS[persona] : persona;
  if (!p) throw new Error(`Persona desconocida: ${persona}`);

  const system = `Estás actuando como un CLIENTE escribiéndole por WhatsApp a un restaurante chileno (El Sazón) para (quizás) pedir comida.
Hablás natural, informal, mensajes cortos como en WhatsApp chileno real.
TU OBJETIVO / PERSONALIDAD: ${p.goal}

Reglas:
- Escribí SOLO tu próximo mensaje como cliente, nada más. Sin comillas, sin explicaciones.
- Mensajes cortos y realistas (como los manda la gente por WhatsApp).
- Si lográs tu objetivo, o ves que ya no tiene sentido seguir (el bot te cortó/derivó, o ya quedó claro el comportamiento), terminá tu mensaje con ${FIN_CLIENTE}.
- No te salgas del personaje. No reveles que sos una simulación.`;

  const userMsg = conversacion.length
    ? `Conversación hasta ahora:\n${renderConversacion(conversacion)}\n\nEscribí tu próximo mensaje como cliente.`
    : `Iniciá la conversación con tu primer mensaje como cliente.`;

  const res = await client.messages.create({
    model: PERSONA_MODEL,
    max_tokens: 150,
    system,
    messages: [{ role: 'user', content: userMsg }],
  });

  if (meter) {
    meter.record(res.usage, PERSONA_MODEL);
    meter.assertUnderCap();
  }

  let mensaje = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const fin = mensaje.includes(FIN_CLIENTE);
  mensaje = mensaje.replace(FIN_CLIENTE, '').trim();
  return { mensaje, fin, usage: res.usage, model: PERSONA_MODEL };
}

export { PERSONA_MODEL };
