// Adapter multi-provider para el A/B de modelos (encargo Cortex 2026-06-27).
// Detrás de la MISMA interfaz que `client.messages.create(payload)`, despacha a Gemini
// (generateContent) o DeepInfra (OpenAI-compatible) y NORMALIZA la respuesta al formato
// Anthropic-like ({ content:[{type:'text',text}], usage:{...} }) para que claude.js
// (_textoDe + manejo de usage) funcione SIN cambios.
//
// 🔒 Default = 'anthropic' → si LLM_PROVIDER no está seteado, NADA cambia (prod intacto).
// Solo el harness del A/B setea LLM_PROVIDER=gemini|deepinfra.
//
// Keys (datos de prueba sintéticos): env var o archivo en ~/.pulsed/ (gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();

function keyFrom(envName, file) {
  // El ARCHIVO en ~/.pulsed/ tiene prioridad sobre la env var: Cortex deja ahí la key válida a
  // propósito, y la env del sistema puede estar STALE/inválida (caso real 2026-06-27: GEMINI_API_KEY
  // del entorno era inválida; la válida vino en el archivo).
  try {
    const f = fs.readFileSync(path.join(os.homedir(), '.pulsed', file), 'utf8').trim();
    if (f) return f;
  } catch { /* sin archivo → cae al env */ }
  return String(process.env[envName] ?? '').trim();
}

// Modelo según provider (el harness setea el modelo por env de cada provider).
export function resolveModel() {
  if (LLM_PROVIDER === 'gemini') return process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite';
  if (LLM_PROVIDER === 'deepinfra') return process.env.DEEPINFRA_MODEL ?? 'mistralai/Mistral-Small-3.2-24B-Instruct-2506';
  if (LLM_PROVIDER === 'openrouter') return process.env.OPENROUTER_MODEL ?? 'mistralai/mistral-small-3.2-24b-instruct';
  return process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// El system de Anthropic es [{type:'text', text, cache_control?}] → lo aplanamos a un string.
function flattenSystem(system) {
  return (Array.isArray(system) ? system : []).map((s) => s?.text ?? '').join('\n\n');
}
function asString(content) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// Throttle proactivo + retry de 429 — para respetar el rate limit del FREE TIER (Gemini ~15 RPM).
// Gap mínimo entre llamadas configurable (default 5s para gemini → ~12 RPM, dentro del free tier).
const MIN_GAP_MS = Number(process.env.LLM_MIN_GAP_MS ?? (LLM_PROVIDER === 'gemini' ? 5000 : 0));
let _lastCallTs = 0;
async function rateGate() {
  if (MIN_GAP_MS <= 0) return;
  const wait = _lastCallTs + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCallTs = Date.now();
}

// POST JSON con throttle + reintento ante 429 (respeta el retryDelay que manda el provider, o backoff).
async function postJSON(url, headers, body, label) {
  for (let intento = 1; intento <= 5; intento++) {
    await rateGate();
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (r.status === 429) {
      const txt = await r.text();
      if (intento >= 5) throw new Error(`${label} HTTP 429 (rate limit, agotados reintentos): ${txt.slice(0, 160)}`);
      const m = txt.match(/"retryDelay"\s*:\s*"(\d+)s"/);
      const waitMs = (m ? parseInt(m[1], 10) + 2 : 20 * intento) * 1000;
      await new Promise((res) => setTimeout(res, waitMs));
      continue;
    }
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
}

async function callGemini({ model, max_tokens, system, messages }) {
  const key = keyFrom('GEMINI_API_KEY', 'gemini_key.txt');
  if (!key) throw new Error('GEMINI_API_KEY ausente (env o ~/.pulsed/gemini_key.txt)');
  const body = {
    systemInstruction: { parts: [{ text: flattenSystem(system) }] },
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: asString(m.content) }],
    })),
    generationConfig: { maxOutputTokens: max_tokens, temperature: 1 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const j = await postJSON(url, { 'Content-Type': 'application/json', 'User-Agent': UA }, body, 'Gemini');
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? '').join('');
  const um = j.usageMetadata ?? {};
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: um.promptTokenCount ?? 0,
      output_tokens: um.candidatesTokenCount ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

async function callDeepInfra({ model, max_tokens, system, messages }) {
  const key = keyFrom('DEEPINFRA_API_KEY', 'deepinfra_key.txt');
  if (!key) throw new Error('DEEPINFRA_API_KEY ausente (env o ~/.pulsed/deepinfra_key.txt)');
  const msgs = [
    { role: 'system', content: flattenSystem(system) },
    ...messages.map((m) => ({ role: m.role, content: asString(m.content) })),
  ];
  const j = await postJSON(
    'https://api.deepinfra.com/v1/openai/chat/completions',
    { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'User-Agent': UA },
    { model, messages: msgs, max_tokens, temperature: 1 }, 'DeepInfra',
  );
  const text = j.choices?.[0]?.message?.content ?? '';
  const u = j.usage ?? {};
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// OpenRouter (OpenAI-compatible, 1 key para Mistral/Llama/Qwen/etc). Alternativa rápida a DeepInfra.
async function callOpenRouter({ model, max_tokens, system, messages }) {
  const key = keyFrom('OPENROUTER_API_KEY', 'openrouter_key.txt');
  if (!key) throw new Error('OPENROUTER_API_KEY ausente (env o ~/.pulsed/openrouter_key.txt)');
  const msgs = [
    { role: 'system', content: flattenSystem(system) },
    ...messages.map((m) => ({ role: m.role, content: asString(m.content) })),
  ];
  const j = await postJSON(
    'https://openrouter.ai/api/v1/chat/completions',
    { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'User-Agent': UA, 'X-Title': 'Vicius Sazon A/B' },
    { model, messages: msgs, max_tokens, temperature: 1 }, 'OpenRouter',
  );
  const text = j.choices?.[0]?.message?.content ?? '';
  const u = j.usage ?? {};
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    },
  };
}

// Despacha al provider no-Anthropic. Devuelve un objeto res-like Anthropic.
export async function callOther(payload) {
  if (LLM_PROVIDER === 'gemini') return callGemini(payload);
  if (LLM_PROVIDER === 'deepinfra') return callDeepInfra(payload);
  if (LLM_PROVIDER === 'openrouter') return callOpenRouter(payload);
  throw new Error('callOther: provider no soportado: ' + LLM_PROVIDER);
}
