// Juez LLM-as-a-Judge. Evalúa una conversación bot↔cliente contra una rúbrica
// y devuelve un veredicto estructurado. Usa tool_use forzado para garantizar
// salida parseable (no parsing frágil de texto).
//
// El juez corre con un modelo >= al evaluado (default Sonnet vs bot Haiku) para
// que detecte fallas sutiles. Configurable por JUDGE_MODEL. Evalúa 1 vez por
// conversación (al final), así que su costo es marginal frente a los turnos.

import Anthropic from '@anthropic-ai/sdk';
import { usageCostUSD } from './lib.mjs';

const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-sonnet-4-6';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VEREDICTO_TOOL = {
  name: 'reportar_veredicto',
  description: 'Reporta el veredicto de la evaluación de la conversación contra la rúbrica.',
  input_schema: {
    type: 'object',
    properties: {
      pass: {
        type: 'boolean',
        description: 'true si el bot cumplió el comportamiento esperado de la rúbrica, false si falló.',
      },
      score: {
        type: 'integer',
        description: 'Calidad de 0 a 10 (0 = falla grave, 10 = perfecto).',
      },
      issues: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista de problemas concretos detectados. Vacío si pass=true sin reparos.',
      },
      razon: {
        type: 'string',
        description: 'Justificación breve (1-2 frases) del veredicto, citando la evidencia de la conversación.',
      },
    },
    required: ['pass', 'score', 'issues', 'razon'],
  },
};

function renderConversacion(conversacion) {
  return conversacion
    .map((t) => `${t.role === 'user' ? 'CLIENTE' : 'BOT'}: ${t.content}`)
    .join('\n');
}

// conversacion: [{role:'user'|'assistant', content}], criterios: string (rúbrica)
// Devuelve { pass, score, issues, razon, usage, model }.
export async function judge({ conversacion, criterios, meter }) {
  const system = `Eres un evaluador de QA riguroso de un bot de pedidos de un restaurante chileno (El Sazón).
Tu trabajo es decidir si el bot cumplió un comportamiento esperado específico en una conversación.
Sé estricto: si el bot aceptó algo que no debía, calculó mal un total, o fue reactivo cuando debía ser proactivo, es FALLA.
No premies respuestas amables que igual incumplen la regla. Cita evidencia concreta de la conversación.`;

  const userMsg = `RÚBRICA (comportamiento esperado):
${criterios}

CONVERSACIÓN A EVALUAR:
${renderConversacion(conversacion)}

Evalúa y reporta el veredicto con la herramienta reportar_veredicto.`;

  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: userMsg }],
    tools: [VEREDICTO_TOOL],
    tool_choice: { type: 'tool', name: 'reportar_veredicto' },
  });

  if (meter) {
    meter.record(res.usage, JUDGE_MODEL);
    meter.assertUnderCap();
  }

  const toolUse = res.content.find((c) => c.type === 'tool_use');
  const v = toolUse?.input ?? { pass: false, score: 0, issues: ['juez no devolvió veredicto'], razon: 'sin tool_use' };
  return { ...v, usage: res.usage, model: JUDGE_MODEL };
}

export { JUDGE_MODEL, usageCostUSD };
