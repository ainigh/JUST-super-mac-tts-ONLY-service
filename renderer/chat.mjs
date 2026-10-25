// The chat beside the character: a chat of three. What you said (to the model, "@<its name>"),
// what it said to you ("@user") and to Peter ("@peter"), and what Peter said back ("@<its name>"),
// each with a way to call off a run Peter took on. Shown and hidden by a click on the character. Talks to the main process through window.chat (preload-chat.cjs),
// or, in a plain browser (npm run dev), to the dev server over HTTP.

const $ = (id) => document.getElementById(id);
// (Not window.chat: that's the element with id="chat".)
const bridge = window.chatBridge || devBridge();

function devBridge() {
  return {
    call: async (name, args = {}) => {
      const r = await fetch(`/dev/ui/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      return j;
    },
    onEvent: (fn) => {
      const es = new EventSource('/dev/ui-events');
      es.onmessage = (e) => fn(JSON.parse(e.data));
    },
    close: () => window.close(),
  };
}

const COLORS = { brunette: ['#5e5ce6', '#bf5af2'], david: ['#ff9f0a', '#ff6b3d'], avaturn: ['#bf5af2', '#ff375f'], avatarsdk: ['#30b0c7', '#0a84ff'] };
let status = null;
let errorList = [];
const shown = new Map(); // entry id → its element

// ---------------------------------------------------------------- the top: who, and what they're doing

function renderStatus() {
  if (!status) return;
  const c = status.character;
  $('name').textContent = c.name;
  $('face').textContent = c.name[0];
  const [a, b] = COLORS[c.id] || COLORS.brunette;
  $('face').style.background = `linear-gradient(135deg, ${a}, ${b})`;
  $('characters').replaceChildren(
    ...status.characters.map((x) => {
      const btn = document.createElement('button');
      btn.textContent = x.name;
      btn.title = `${x.name}: ${x.looks}, and ${x.body === 'F' ? 'her' : 'his'} own voice`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(x.id === c.id));
      btn.onclick = () => act('setCharacter', { id: x.id });
      return btn;
    }),
  );
  renderSizes();
  $('mic').setAttribute('aria-pressed', String(status.listening));
  $('mic').title = status.listening ? 'Listening: click to stop listening' : 'Not listening: click to listen';
  document.body.dataset.ears = status.listening ? status.ears?.state || 'off' : 'off';
  $('doing').textContent = doing();
  const busy = status.assistant.busy;
  $('stop').hidden = !busy && !status.speaking;
  $('stop').title = busy ? "Stop: cancels what I'm doing (a run waiting for your click, or running, too)" : 'Stop talking';
  $('retryVoice').hidden = status.face?.tts?.state !== 'failed';
  $('think').checked = status.think;
  const p = status.peter || {};
  $('peterState').textContent = p.reachable ? (p.error ? `Peter: ${p.error}` : 'Peter is there') : "Peter (Tool Mac Agent) isn't answering";
  $('peterState').title = p.error || (p.reachable ? 'Peter does everything on the Mac and the web for it' : 'Open Peter (Tool Mac Agent): he does everything on the Mac and the web for it');
}

/** S, M, L, H: the character's size, one click each. */
function renderSizes() {
  const box = $('size');
  const sizes = status.sizes || ['Small', 'Medium', 'Large', 'Huge'];
  if (box.childElementCount !== sizes.length) {
    box.replaceChildren(
      ...sizes.map((name) => {
        const b = document.createElement('button');
        b.textContent = name[0];
        b.title = name;
        b.dataset.size = name;
        b.setAttribute('role', 'radio');
        b.onclick = () => act('setSize', { size: name });
        return b;
      }),
    );
  }
  for (const b of box.children) b.setAttribute('aria-checked', String(b.dataset.size === status.size));
}

function doing() {
  const a = status.assistant;
  if (a.phase === 'tool' && a.tool) {
    if (a.tool.state === 'waiting') return `Waiting for you to click Run on the Mac`;
    return 'Peter is on it…';
  }
  if (a.phase === 'thinking') return 'Thinking…';
  if (a.error) return a.error;
  if (status.face?.avatar === 'failed') return "I didn't load: see Errors";
  if (status.face?.tts?.state === 'failed') return "My voice didn't load: see Errors";
  if (status.face?.tts?.state === 'downloading') return `Getting my voice ready… ${Math.round((status.face.tts.progress || 0) * 100)}%`;
  if (status.speaking) return 'Talking…';
  if (a.phase === 'learning') return 'Taking notes…';
  if (!status.listening) return 'Not listening (the mic is off): type below';
  const e = status.ears || {};
  switch (e.state) {
    case 'hearing':
      return 'Hearing you…';
    case 'writing':
      return 'Writing down what you said…';
    case 'listening':
      return 'Listening: just talk';
    case 'paused':
      return 'Not listening while I talk';
    case 'loading':
      return e.progress ? `Getting my ears ready… ${Math.round(e.progress * 100)}%` : 'Getting my ears ready…';
    case 'failed':
      return `I can't hear: ${e.message || 'the microphone failed'}`;
    default:
      return 'Ready';
  }
}

// ---------------------------------------------------------------- the chat

const RUN = { waiting: 'Click Run on your Mac', running: 'Running', done: 'Done', failed: "Didn't work", cancelled: 'Cancelled' };
const MESSAGES = ['user', 'assistant', 'to-peter', 'peter'];

function render(e) {
  if (e.hidden) {
    shown.get(e.id)?.remove();
    shown.delete(e.id);
    return;
  }
  let li = shown.get(e.id);
  const fresh = !li;
  if (fresh) {
    li = document.createElement('li');
    shown.set(e.id, li);
    $('entries').append(li);
  }
  const msg = MESSAGES.includes(e.kind);
  li.className = `${msg ? 'msg ' : ''}${e.kind}${e.failed ? ' failed' : ''}${e.streaming ? ' streaming' : ''}${e.queued ? ' queued' : ''}${e.dropped ? ' dropped' : ''}`;
  li.replaceChildren();
  if (!msg) {
    li.textContent = e.text;
  } else {
    // Who it's from, and who it's to: "@qwen3 …" (to the model), "@user …", "@peter …".
    const how = document.createElement('span');
    how.className = 'how';
    how.textContent = [e.from || '', e.kind === 'user' && e.how === 'said' ? 'said' : '', e.news ? 'by himself' : '', e.kind === 'to-peter' || e.kind === 'peter' ? 'not read aloud' : ''].filter(Boolean).join(' · ');
    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = `@${e.to || ''} `;
    li.append(how, at, e.text);
    // A run Peter took on: how it stands, and a way to call it off.
    if (e.kind === 'to-peter' && e.number && RUN[e.state]) {
      const run = document.createElement('span');
      run.className = `run ${e.state}`;
      run.textContent = RUN[e.state];
      li.append(run);
      if (['waiting', 'running'].includes(e.state)) {
        const cancel = document.createElement('button');
        cancel.className = 'cancel';
        cancel.textContent = 'Cancel';
        cancel.title = e.state === 'waiting' ? 'Take the card off the Mac: nothing runs' : 'Stop it';
        cancel.onclick = () => act('cancelTool', { id: e.id });
        li.append(cancel);
      }
    }
  }
  if (fresh || e.streaming) scrollDown();
}

function scrollDown() {
  const m = document.querySelector('main');
  if ($('chat').hidden) return;
  requestAnimationFrame(() => (m.scrollTop = m.scrollHeight));
}

async function loadModels() {
  const r = await act('models');
  if (!r) return;
  const sel = $('modelPick');
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = r.models.length ? `Best available${r.current && !status?.model ? ` (${r.current})` : ''}` : 'No models found';
  sel.replaceChildren(auto, ...r.models.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: m })));
  sel.value = status?.model || '';
  sel.title = r.error ? `${r.error} Get Ollama at ollama.com, then: ollama pull qwen3:8b` : r.models.length ? 'The model it thinks with (Ollama’s)' : 'In Terminal: ollama pull qwen3:8b';
}

async function renderPrompts() {
  const list = (await act('prompts')) || [];
  $('promptList').replaceChildren(
    ...list.map((p) => {
      const card = document.createElement('div');
      card.className = 'card';
      const head = document.createElement('div');
      head.className = 'head';
      const h = document.createElement('h4');
      h.textContent = p.title;
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.onclick = async () => {
        await copyText(p.text);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      };
      head.append(h, copy);
      const when = document.createElement('p');
      when.textContent = p.when;
      const pre = document.createElement('pre');
      pre.textContent = p.text;
      card.append(head, when, pre);
      return card;
    }),
  );
}

function renderErrors() {
  $('errorCount').textContent = errorList.length ? String(errorList.length) : '';
  const ol = $('errorList');
  ol.replaceChildren(
    ...[...errorList].reverse().map((e) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const src = document.createElement('span');
      src.className = 'source';
      src.textContent = e.source;
      const when = document.createElement('span');
      when.textContent = new Date(e.at).toLocaleString() + (e.count > 1 ? ` · ×${e.count}` : '');
      meta.append(src, when);
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = e.message;
      li.append(meta, msg);
      if (e.detail) {
        const d = document.createElement('details');
        const s = document.createElement('summary');
        s.textContent = 'Details';
        const pre = document.createElement('pre');
        pre.textContent = e.detail;
        d.append(s, pre);
        li.append(d);
      }
      return li;
    }),
  );
  if (!errorList.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'No errors.';
    ol.append(li);
  }
}

// ---------------------------------------------------------------- the model's log

const traceCards = { model: new Map() }; // item id → its card
const LIST = { model: 'modelList' };
const COUNT = { model: 'modelCount' };
const PURPOSES = { answer: 'Answer', learning: 'Learning (after a request)' };

async function loadTrace(log) {
  const r = await act('trace', { log });
  if (!r) return;
  clearTrace(log);
  for (const item of r.items) renderTrace(log, item);
}

function clearTrace(log) {
  traceCards[log].clear();
  $(LIST[log]).replaceChildren();
  $(COUNT[log]).textContent = '';
}

function renderTrace(log, item) {
  let li = traceCards[log].get(item.id);
  // What was open stays open as the card is drawn again.
  const open = new Set(li ? [...li.querySelectorAll('details[open]')].map((d) => d.dataset.key) : []);
  if (!li) {
    li = document.createElement('li');
    li.className = 'card trace';
    traceCards[log].set(item.id, li);
    $(LIST[log]).prepend(li);
    $(COUNT[log]).textContent = String(traceCards[log].size);
  }
  li.dataset.state = item.state || '';
  li.replaceChildren(...modelCard(item));
  for (const d of li.querySelectorAll('details')) if (open.has(d.dataset.key)) d.open = true;
}

const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text !== undefined ? { textContent: text } : {});
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const took = (ms) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function head(title, bits, copyOf) {
  const h = el('div', 'head');
  h.append(el('h4', '', title));
  for (const b of bits.filter(Boolean)) h.append(el('span', `meta${b.cls ? ` ${b.cls}` : ''}`, b.text ?? b));
  if (copyOf) {
    const c = el('button', '', 'Copy');
    c.onclick = async () => {
      await copyText(copyOf());
      c.textContent = 'Copied';
      setTimeout(() => (c.textContent = 'Copy'), 1500);
    };
    h.append(c);
  }
  return h;
}

function fold(key, summary, body, open = false) {
  const d = el('details');
  d.dataset.key = key;
  d.open = open;
  d.append(el('summary', '', summary), body instanceof Node ? body : el('pre', '', body));
  return d;
}

function stateBit(state) {
  return { text: state, cls: `state-${state}` };
}

function modelCard(m) {
  const msgs = m.messages || [];
  const chars = msgs.reduce((n, x) => n + String(x.content).length, 0);
  const out = [
    head(PURPOSES[m.purpose] || m.purpose, [m.model, stateBit(m.state), took(m.ms), new Date(m.at).toLocaleTimeString()], () => pretty({ url: m.url, request: { ...m.request, messages: msgs }, response: m.text, error: m.error })),
  ];
  out.push(el('p', 'url', `POST ${m.url}${m.request ? `  ${JSON.stringify(m.request)}` : ''}`));
  const sent = el('div', 'messages');
  msgs.forEach((x, i) => sent.append(fold(`m${i}`, `${x.role} · ${String(x.content).length} characters`, String(x.content), i === msgs.length - 1)));
  out.push(fold('sent', `Sent: ${msgs.length} messages, ${chars.toLocaleString()} characters`, sent));
  out.push(fold('back', 'Came back', m.text || (m.state === 'asking' ? '…' : '(nothing)'), true));
  if (m.error) out.push(el('p', 'bad', m.error));
  return out;
}

/** Onto the clipboard: the app's when it can, else the page's. */
async function copyText(text) {
  const r = await act('copy', { text });
  if (!r?.copied) await navigator.clipboard.writeText(text);
}

// ---------------------------------------------------------------- wiring

async function act(name, args) {
  try {
    const r = await bridge.call(name, args);
    if (r && r.character && r.assistant) {
      status = r;
      renderStatus();
    }
    return r;
  } catch (err) {
    console.error(name, err);
    return null;
  }
}

function tab(name) {
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== name;
  $('compose').hidden = name !== 'chat';
  if (name === 'prompts') renderPrompts();
  if (name === 'model') loadTrace(name);
  if (name === 'chat') scrollDown();
}

function send() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  grow();
  act('send', { text });
}

function grow() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(120, t.scrollHeight)}px`;
  t.style.overflowY = t.scrollHeight > 120 ? 'auto' : 'hidden';
}

for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => tab(b.dataset.tab);
$('send').onclick = send;
$('stop').onclick = () => act(status?.assistant.busy ? 'cancel' : 'hush');
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('input').addEventListener('input', grow);
$('mic').onclick = () => act('set', { listening: !status?.listening });
$('close').onclick = () => bridge.close();
$('clearModel').onclick = () => act('clearTrace', { log: 'model' });
$('copyReport').onclick = async () => {
  const r = await act('copyReport');
  if (r && !r.copied) await navigator.clipboard.writeText(r.text);
  $('copied').textContent = 'Copied: paste it wherever you report the problem.';
};
$('clearErrors').onclick = () => act('clearErrors');
$('retryVoice').onclick = async () => {
  const b = $('retryVoice');
  b.disabled = true;
  b.textContent = 'Starting the voice…';
  const r = await act('retryVoice');
  b.disabled = false;
  b.textContent = 'Try the voice again';
  status = (await act('status')) || status;
  renderStatus();
  $('copied').textContent = r?.ok ? 'The voice is working now.' : `It still didn't start${r?.message ? `: ${r.message}` : ''}. Copy the report and send it.`;
};
// What goes wrong in the chat itself goes in the list too.
addEventListener('error', (e) => act('reportError', { source: 'chat', message: e.message, detail: e.error?.stack || '' }));
addEventListener('unhandledrejection', (e) => act('reportError', { source: 'chat', message: String(e.reason?.message || e.reason), detail: e.reason?.stack || '' }));
$('modelPick').onchange = () => act('set', { model: $('modelPick').value });
$('think').onchange = () => act('set', { think: $('think').checked });
$('clearChat').onclick = () => {
  if (!confirm('Clear the chat? What was said goes for good; what I have learned stays.')) return;
  act('clearChat');
  tab('chat');
};
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.close();
});

bridge.onEvent((ev) => {
  switch (ev.type) {
    case 'entry':
      render(ev.entry);
      break;
    case 'cleared':
      for (const li of shown.values()) li.remove();
      shown.clear();
      break;
    case 'trace':
      if (ev.cleared) clearTrace(ev.log);
      else renderTrace(ev.log, ev.item);
      break;
    case 'assistant':
      if (status) {
        status.assistant = ev.state;
        renderStatus();
      }
      break;
    case 'ears':
      if (status) {
        status.ears = ev.ears;
        renderStatus();
      }
      break;
    case 'status':
      status = ev.status;
      renderStatus();
      break;
    case 'speech':
      if (status) {
        status.speaking = ev.speaking;
        renderStatus();
      }
      break;
    case 'errors':
      errorList = ev.errors;
      renderErrors();
      break;
    case 'focus':
      $('input').focus();
      break;
  }
});

// What there is, as the chat opens.
status = await act('status');
renderStatus();
for (const e of (await act('log')) || []) render(e);
errorList = (await act('errors'))?.errors || [];
renderErrors();
await loadModels();
await loadTrace('model');
$('input').focus();
