// The chat beside the character: what was said both ways, the tools at work (each with a way to
// call it off), every tool there is, what's scheduled, and what it has learned. Shown and hidden
// by a click on the character. Talks to the main process through window.chat (preload-chat.cjs),
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
let tools = null;
let schedules = [];
let memory = null;
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
  $('toolCount').textContent = status.tools.reachable ? String(status.tools.scripts + status.tools.flows + 5) : '5';
  $('laterCount').textContent = status.schedules ? String(status.schedules) : '';
  $('listenWhileSpeaking').checked = status.listenWhileSpeaking;
  $('busyTone').checked = status.busyTone !== false;
  $('retryVoice').hidden = status.face?.tts?.state !== 'failed';
  $('think').checked = status.think;
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
    return `Running ${toolLabel({ name: a.tool.name, args: {} })}…`;
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

const STATES = { working: 'Working', sending: 'Sending', waiting: 'Click Run on your Mac', running: 'Running', done: 'Done', failed: "Didn't work", cancelled: 'Cancelled' };

function toolLabel(e) {
  const a = e.args || {};
  switch (e.name) {
    case 'run_script':
      return a.script || e.label || 'a script';
    case 'run_flow':
      return a.flow || e.label || 'a flow';
    case 'run_flow_code':
      return a.name || 'Flow code';
    case 'schedule':
      return 'Scheduling';
    case 'cancel_schedule':
      return 'Cancelling a schedule';
    case 'list_schedules':
      return "What's scheduled";
    case 'learn':
      return 'Taking a note';
    case 'unlearn':
      return 'Crossing out a note';
    case 'remember':
      return a.about ? `Remembering ${a.about}` : 'Remembering';
    case 'recall':
      return a.name ? `Recalling ${a.name}` : 'Recalling';
    case 'memory':
      return a.op === 'upcoming' ? "What's coming up" : `Memory: ${a.op || '…'}`;
    case 'mind':
      return `The mind: ${a.op || '…'}`;
    case 'show':
      return a.title ? `Showing “${a.title}”` : 'Showing it on the Mac';
    case 'copy':
      return 'Copying to the clipboard';
    case 'browser':
      return a.op === 'highlight' ? `Pointing out “${a.text}” in Chrome` : `Chrome's page: ${a.op || '…'}`;
    default:
      return e.name.replace(/_/g, ' ');
  }
}

function toolArgs(e) {
  const a = { ...(e.args || {}) };
  delete a.script;
  delete a.flow;
  const parts = [];
  if (Array.isArray(a.args) && a.args.length) parts.push(a.args.join(' · '));
  else if (typeof a.args === 'string') parts.push(a.args);
  delete a.args;
  for (const [k, v] of Object.entries(a)) if (v !== undefined && v !== null && v !== '') parts.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join('  ·  ');
}

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
  if (e.kind === 'tool') renderTool(li, e);
  else {
    li.className = `${['user', 'assistant', 'schedule'].includes(e.kind) ? 'msg ' : ''}${e.kind}${e.streaming ? ' streaming' : ''}${e.queued ? ' queued' : ''}${e.dropped ? ' dropped' : ''}`;
    li.textContent = '';
    if (e.kind === 'user' && e.how === 'said') li.title = 'Heard';
    if (e.kind === 'schedule') {
      const how = document.createElement('span');
      how.className = 'how';
      how.textContent = 'Scheduled, due now';
      li.append(how);
    }
    li.append(e.kind === 'schedule' ? e.text.replace(/^Scheduled task s\d+, set .*? at \d\d:\d\d: /, '') : e.text);
  }
  if (fresh || e.streaming) scrollDown();
}

function renderTool(li, e) {
  li.className = 'tool';
  li.dataset.state = e.state;
  const open = li.querySelector('details')?.open;
  li.replaceChildren();
  const head = document.createElement('div');
  head.className = 'head';
  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = toolLabel(e);
  const state = document.createElement('span');
  state.className = 'state';
  state.textContent = STATES[e.state] || e.state;
  if (e.state === 'running' && e.startedAt) state.dataset.since = e.startedAt;
  head.append(what, state);
  if (!['done', 'failed', 'cancelled'].includes(e.state)) {
    const cancel = document.createElement('button');
    cancel.className = 'cancel';
    cancel.textContent = 'Cancel';
    cancel.title = e.state === 'waiting' ? 'Take the card off the Mac: nothing runs' : 'Stop it';
    cancel.onclick = () => act('cancelTool', { id: e.id });
    head.append(cancel);
  }
  li.append(head);
  const args = toolArgs(e);
  if (args) {
    const p = document.createElement('div');
    p.className = 'args';
    p.textContent = args;
    li.append(p);
  }
  const body = e.result || e.output;
  if (body) {
    const d = document.createElement('details');
    d.open = open ?? (e.state === 'running' && !!e.output);
    const s = document.createElement('summary');
    s.textContent = e.result ? 'What came back' : 'What it has printed';
    const pre = document.createElement('pre');
    pre.textContent = body;
    d.append(s, pre);
    li.append(d);
  }
}

function scrollDown() {
  const m = document.querySelector('main');
  if ($('chat').hidden) return;
  requestAnimationFrame(() => (m.scrollTop = m.scrollHeight));
}

// Running for… seconds, as it runs.
setInterval(() => {
  for (const el of document.querySelectorAll('.tool .state[data-since]')) {
    el.textContent = `Running ${Math.round((Date.now() - Number(el.dataset.since)) / 1000)}s`;
  }
}, 1000);

// ---------------------------------------------------------------- tools, later, mind

function renderTools() {
  if (!tools) return;
  const q = $('toolSearch').value.trim().toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
  const list = $('toolList');
  list.replaceChildren();
  $('toolStatus').textContent = tools.reachable
    ? `From Tool Mac Tool Run${tools.folder ? ` (${tools.folder})` : ''}: ${tools.scripts.length} scripts, ${tools.flows.length} flows. Each run asks you on the Mac first.`
    : `Tool Mac Tool Run: ${tools.error || 'not reached'}. Open it (with its API on) to give me your scripts.`;
  const section = (title, items) => {
    if (!items.length) return;
    const h = document.createElement('h4');
    h.textContent = title;
    list.append(h, ...items);
  };
  const item = (name, about, extra = '', danger = '', ask = `Use ${name} to `) => {
    const b = document.createElement('button');
    b.className = 'toolItem';
    const n = document.createElement('b');
    n.textContent = name;
    b.append(n);
    for (const [text, cls] of [[about], [extra], [danger, 'danger']]) {
      if (!text) continue;
      const s = document.createElement('span');
      s.textContent = text;
      if (cls) s.className = cls;
      b.append(s);
    }
    b.title = 'Ask for it in the chat';
    b.onclick = () => {
      tab('chat');
      $('input').value = ask;
      $('input').focus();
    };
    return b;
  };
  section(
    'Built in',
    tools.builtin.filter((t) => match(t.name, t.description)).map((t) => item(t.name, t.description.split('. ')[0].replace(/\.$/, '') + '.', '', '', t.name === 'schedule' ? 'Remind me in 10 minutes to ' : `Use ${t.name} to `)),
  );
  section(
    'Through Tool Mac Tool Run',
    (tools.mac || []).filter((t) => match(t.name, t.description)).map((t) => item(t.name, t.description.split('. ')[0].replace(/\.$/, '') + '.', '', '', t.name === 'library' ? 'In my notes, ' : `Use ${t.name} to `)),
  );
  const groups = {};
  for (const s of tools.scripts) (groups[s.group] ||= []).push(s);
  for (const [g, scripts] of Object.entries(groups)) {
    section(
      g === 'scripts' ? 'Scripts' : g[0].toUpperCase() + g.slice(1),
      scripts
        .filter((s) => match(s.name, s.summary))
        .map((s) => item(s.name, s.summary, s.inputs.length ? `Takes: ${s.inputs.map((i) => i.prompt + (i.optional ? ' (optional)' : '')).join('; ')}` : '', s.dangers.length ? `Can't be undone: ${s.dangers.join(', ')}` : '', `Run ${s.name} `)),
    );
  }
  section('Flows', tools.flows.filter((f) => match(f.name, f.summary)).map((f) => item(f.name, f.summary, '', '', `Run the flow ${f.name} `)));
  // The routes it reaches with call_api (what Tool Mac Tool Run adds later shows up here by itself).
  const covered = tools.covered || ['about', 'scripts', 'runs'];
  for (const g of (tools.groups || []).filter((x) => !covered.includes(x.id))) {
    section(
      `${g.title}${g.on ? '' : ' (turned off)'}`,
      g.routes.filter((r) => match(r.path, r.summary, g.title)).map((r) => item(`${r.method} ${r.path}`, r.summary, '', r.asks ? 'Asks on the Mac first' : '', `Using Tool Mac Tool Run's ${g.title}, `)),
    );
  }
}

function renderLater() {
  const ol = $('laterList');
  ol.replaceChildren(
    ...schedules.map((t) => {
      const li = document.createElement('li');
      const div = document.createElement('div');
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `${t.when[0].toUpperCase()}${t.when.slice(1)}`;
      const soon = document.createElement('span');
      soon.className = 'soon';
      soon.textContent = ` ${t.fromNow} · ${t.id}`;
      div.append(when, soon, document.createElement('br'), t.task);
      const x = document.createElement('button');
      x.textContent = 'Cancel';
      x.onclick = () => act('cancelSchedule', { id: t.id });
      li.append(div, x);
      return li;
    }),
  );
  if (!schedules.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'Nothing scheduled.';
    ol.append(li);
  }
  $('cancelAll').hidden = schedules.length < 2;
  $('laterCount').textContent = schedules.length ? String(schedules.length) : '';
}

function renderMemory() {
  if (!memory) return;
  $('memoryCount').textContent = memory.playbook?.length ? `${memory.playbook.length} lines` : '';
  const box = $('memory');
  box.replaceChildren();
  const ul = document.createElement('ul');
  ul.className = 'notes';
  const hint = (text) => {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = text;
    return li;
  };
  if (!memory.library) ul.append(hint(`Tool Mac Tool Run's library isn't on${memory.error ? ` (${memory.error})` : ''}: there's nowhere to keep it.`));
  else if (!memory.playbook?.length) ul.append(hint('Nothing yet.'));
  for (const line of memory.playbook || []) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = line.replace(/^-\s*/, '');
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Take this line out of the playbook';
    x.onclick = () => act('forget', { note: line });
    li.append(span, x);
    ul.append(li);
  }
  box.append(ul);
  const about = $('aboutUser');
  about.replaceChildren();
  if (!memory.memory) about.append(hint("Tool Mac Tool Run's MEMORY isn't on."));
  else if (!memory.aboutUser?.length) about.append(hint('Nothing yet.'));
  for (const line of memory.aboutUser || []) {
    const li = document.createElement('li');
    li.textContent = line;
    about.append(li);
  }
  $('instructions').disabled = !memory.library;
  $('saveInstructions').disabled = !memory.library;
  if (document.activeElement !== $('instructions')) $('instructions').value = memory.instructions || '';
}

async function loadModels() {
  const r = await act('models');
  if (!r) return;
  const sel = $('model');
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = r.models.length ? `Best available${r.current && !status?.model ? ` (${r.current})` : ''}` : 'No models found';
  sel.replaceChildren(auto, ...r.models.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: m })));
  sel.value = status?.model || '';
  $('modelHint').textContent = r.error ? `${r.error} Get Ollama at ollama.com, then: ollama pull qwen3:8b` : r.models.length ? 'One model does all of it: talking, tools, and the face.' : 'In Terminal: ollama pull qwen3:8b';
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

// ---------------------------------------------------------------- the model's log, and the calls

const traceCards = { model: new Map(), calls: new Map() }; // item id → its card
const LIST = { model: 'modelList', calls: 'callList' };
const COUNT = { model: 'modelCount', calls: 'callCount' };
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
  li.replaceChildren(...(log === 'model' ? modelCard(item) : callCard(item)));
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

function callCard(c) {
  const out = [];
  if (c.kind === 'http') {
    out.push(head('A request', [stateBit(c.state), new Date(c.at).toLocaleTimeString()], () => pretty(c)));
    out.push(httpBlock(c, 'h'));
    return out;
  }
  const where = c.kind === 'catalog' ? 'Tool Mac Tool Run' : c.where === 'mac' ? 'Tool Mac Tool Run' : c.where === 'local' ? 'in this app' : '';
  out.push(head(c.name, [where, stateBit(c.state), took(c.ms), new Date(c.at).toLocaleTimeString()], () => pretty(c)));
  if (c.args && Object.keys(c.args).length) out.push(fold('args', 'Arguments', pretty(c.args), true));
  (c.http || []).forEach((h, i) => out.push(httpBlock(h, `h${i}`)));
  if (c.kind === 'tool' && !(c.http || []).length && c.state !== 'working') out.push(el('p', 'url', c.where === 'local' ? 'Done in this app: no request.' : 'No request was made.'));
  if (c.result !== undefined) out.push(fold('result', c.kind === 'catalog' ? 'What came of it' : 'What went back to the model', c.result, c.kind !== 'catalog'));
  return out;
}

function httpBlock(h, key) {
  const box = el('div', 'http');
  const line = el('div', 'line');
  line.append(el('b', '', h.method), el('span', 'addr', ` ${h.url}`));
  const bits = [h.status !== undefined ? `→ ${h.status}` : '', h.request ? `request ${h.request}` : '', took(h.ms), h.state && h.state !== 'done' ? h.state : ''].filter(Boolean);
  if (bits.length) line.append(el('span', 'meta', `  ${bits.join(' · ')}`));
  box.append(line);
  if (h.body !== undefined) box.append(fold(`${key}s`, 'Sent', pretty(h.body)));
  if (h.events?.length) {
    const outputs = h.events.filter((e) => e.type === 'output').length;
    box.append(fold(`${key}e`, `Came back, as it happened: ${h.events.length} events${outputs ? ` (${outputs} of printing)` : ''}`, h.events.map((e) => JSON.stringify(e)).join('\n'), true));
  }
  if (h.response !== undefined) box.append(fold(`${key}r`, 'Came back', pretty(h.response), !h.events?.length));
  if (h.error) box.append(el('p', 'bad', h.error));
  return box;
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
  if (name === 'mind') loadModels();
  if (name === 'prompts') renderPrompts();
  if (name === 'model' || name === 'calls') loadTrace(name);
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
$('clearCalls').onclick = () => act('clearTrace', { log: 'calls' });
$('toolSearch').addEventListener('input', renderTools);
$('refreshTools').onclick = async () => {
  $('toolStatus').textContent = 'Asking Tool Mac Tool Run…';
  tools = await act('refreshTools');
  renderTools();
};
$('cancelAll').onclick = () => act('cancelSchedule', { id: 'all' });
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
$('model').onchange = () => act('set', { model: $('model').value });
$('think').onchange = () => act('set', { think: $('think').checked });
$('listenWhileSpeaking').onchange = () => act('set', { listenWhileSpeaking: $('listenWhileSpeaking').checked });
$('busyTone').onchange = () => act('set', { busyTone: $('busyTone').checked });
$('saveInstructions').onclick = () => act('instructions', { text: $('instructions').value });
$('newChat').onclick = () => {
  act('newChat');
  tab('chat');
};
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
    case 'tools':
      tools = ev.tools;
      renderTools();
      if (status) {
        status.tools = { reachable: tools.reachable, scripts: tools.scripts.length, flows: tools.flows.length, error: tools.error };
        renderStatus();
      }
      break;
    case 'schedules':
      schedules = ev.schedules;
      renderLater();
      if (status) status.schedules = schedules.length;
      break;
    case 'memory':
      memory = ev.memory;
      renderMemory();
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
tools = await act('tools');
renderTools();
schedules = (await act('schedules')) || [];
renderLater();
memory = await act('memory');
renderMemory();
errorList = (await act('errors'))?.errors || [];
renderErrors();
await loadTrace('model');
await loadTrace('calls');
$('input').focus();
// The times ("in 12 minutes") move on.
setInterval(async () => {
  if (!$('later').hidden) {
    schedules = (await act('schedules')) || schedules;
    renderLater();
  }
}, 30_000);
