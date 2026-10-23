// Ollama: the conversation (streamed) and motion-engine's classifier.
//
// motion-engine 2 asks a "decision model" three multiple-choice questions per
// sentence (expression? head movement? hand gesture?). Instead of Jev on
// OpenRouter, this classifier asks a local Ollama model, with a JSON schema
// whose enums are exactly the catalog's names, so the answer can't be anything
// off the menu. The catalog sits in the system message and stays identical
// between calls, so Ollama reuses its cache and only the new line is processed.

async function post(url, body, signal) {
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  // Models without a thinking mode reject the `think` field: drop it and retry.
  if (res.status === 400 && 'think' in body) {
    const text = await res.text();
    if (/think/i.test(text)) {
      const { think: _unused, ...rest } = body;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rest),
        signal,
      });
    } else {
      throw new Error(`Ollama 400: ${text}`);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {
      /* plain text */
    }
    throw new Error(`Ollama ${res.status}: ${message || res.statusText}`);
  }
  return res;
}

/** Model names Ollama has pulled. */
export async function listModels(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const { models = [] } = await res.json();
  return models.map((m) => m.name);
}

/**
 * Stream a chat reply, yielding text as it's generated.
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.model
 * @param {{role: string, content: string}[]} o.messages
 * @param {boolean} [o.thinking]
 * @param {AbortSignal} [o.signal]
 */
export async function* chatStream({ baseUrl, model, messages, thinking = false, signal }) {
  const body = { model, messages, stream: true, keep_alive: '30m', options: { temperature: 0.7 } };
  if (!thinking) body.think = false;
  const res = await post(`${baseUrl}/api/chat`, body, signal);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(`Ollama: ${msg.error}`);
      const text = msg.message?.content;
      if (text) yield text;
      if (msg.done) return;
    }
  }
}

// ---------- motion-engine classifier ----------

const WHO = {
  avatar: 'the avatar (it is saying this)',
  user: 'the person talking to the avatar',
};

const RULES = [
  'You direct the body language of a 3D avatar during a live spoken conversation.',
  'For the line you are given, answer every question below.',
  'For a choice question, pick exactly one option name from its list and rate from 0 to 1 how well it fits.',
  "Pick 'none' unless an option clearly fits the line. Most lines need no hand gesture.",
  'For a yes/no question, give "noul": the probability from 0 to 1 that the answer is yes.',
  'Answer with JSON only.',
].join('\n');

function describe(questions) {
  const parts = [RULES];
  const properties = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const names = Object.keys(q.criteria);
      parts.push(
        `\n## ${key}\n${q.instructions}\nOptions:\n` +
          names.map((n) => `- ${n}: ${q.criteria[n]}`).join('\n'),
      );
      properties[key] = {
        type: 'object',
        properties: { choice: { type: 'string', enum: names }, confidence: { type: 'number' } },
        required: ['choice', 'confidence'],
      };
    } else if (q.type === 'noul') {
      parts.push(
        `\n## ${key} (yes/no)\n${q.instructions}\nYes means: ${q.criteria.true}\nNo means: ${q.criteria.false}`,
      );
      properties[key] = {
        type: 'object',
        properties: { noul: { type: 'number' } },
        required: ['noul'],
      };
    }
  }
  return {
    system: parts.join('\n'),
    schema: { type: 'object', properties, required: Object.keys(properties) },
  };
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * A motion-engine `classify` function backed by Ollama.
 * @param {{baseUrl: string, model: string, thinking?: boolean}} o
 */
export function ollamaClassifier({ baseUrl, model, thinking = false }) {
  const prompts = new WeakMap(); // the director reuses one questions object per speaker

  return async function classify(state, questions, { signal } = {}) {
    const started = performance.now();
    if (!prompts.has(questions)) prompts.set(questions, describe(questions));
    const { system, schema } = prompts.get(questions);

    const lines = [];
    if (state.previous) lines.push(`Previous line, said by ${WHO[state.previous.speaker]}: "${state.previous.text}"`);
    lines.push(`Line to judge, said by ${WHO[state.speaker]}: "${state.text}"`);

    const body = {
      model,
      stream: false,
      format: schema,
      keep_alive: '30m',
      options: { temperature: 0, num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: lines.join('\n') },
      ],
    };
    if (!thinking) body.think = false;

    const res = await post(`${baseUrl}/api/chat`, body, signal);
    const data = await res.json();

    let raw = {};
    try {
      raw = JSON.parse(data.message?.content || '{}');
    } catch {
      /* treated as no answer */
    }

    const answers = {};
    for (const [key, q] of Object.entries(questions)) {
      const a = raw[key];
      if (!a) continue;
      if (q.type === 'choice') {
        const choice = a.choice in q.criteria ? a.choice : 'none';
        answers[key] = { choice, confidence: clamp01(a.confidence) };
      } else if (q.type === 'noul') {
        answers[key] = { noul: clamp01(a.noul) };
      }
    }

    return {
      answers,
      model,
      usage: { input_tokens: data.prompt_eval_count ?? null, output_tokens: data.eval_count ?? null },
      ms: Math.round(performance.now() - started),
    };
  };
}
