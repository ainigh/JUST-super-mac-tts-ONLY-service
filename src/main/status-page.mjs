// GET /: what's running, and a box to try it.

export function statusPage(port) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Super Face</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f8;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#d9d9de;--accent:#5b5bd6}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f2f2f4;--muted:#9a9aa1;--card:#1f1f22;--line:#333338;--accent:#8b8bf0}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:24px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
textarea,select,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px;box-sizing:border-box}
textarea{width:100%;min-height:80px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}
button{font:inherit;border:0;border-radius:8px;padding:8px 14px;background:var(--accent);color:#fff;cursor:pointer}
button.quiet{background:transparent;color:var(--fg);border:1px solid var(--line)}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,Menlo,monospace;color:var(--muted);margin:0}
a{color:var(--accent)}
</style></head><body><main>
<h1>Super Face</h1>
<p>The avatar's API, at <code>http://127.0.0.1:${port}</code>. The whole contract is in <a href="/api.md">/api.md</a>.</p>
<div class="card">
<textarea id="text">Hello! I'm the face of Super Voice. [thumbup] Nice to meet you 😊</textarea>
<div class="row">
<select id="voice"></select>
<select id="mood"><option value="">mood: auto</option></select>
<select id="gesture"><option value="">gesture: auto</option></select>
<button id="speak">Speak</button>
<button class="quiet" id="stop">Stop</button>
<button class="quiet" id="toggle">Show / hide</button>
</div></div>
<div class="card"><pre id="out">…</pre></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const show = (x) => ($('out').textContent = typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const call = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
(async () => {
  const v = await call('/api/voices');
  for (const x of v.voices) $('voice').add(new Option(x.name + ' (' + x.gender + ', ' + x.accent + ')', x.id, false, x.id === v.default));
  const c = await call('/api/catalog');
  for (const m of Object.keys(c.moods)) $('mood').add(new Option(m, m));
  for (const g of Object.keys(c.gestures)) $('gesture').add(new Option(g, g));
  show(await call('/api/health'));
})();
$('speak').onclick = async () => show(await call('/api/speak', { text: $('text').value, voice: $('voice').value, mood: $('mood').value || undefined, gesture: $('gesture').value || undefined }));
$('stop').onclick = async () => show(await call('/api/stop', {}));
$('toggle').onclick = async () => show(await call('/api/toggle', {}));
</script></body></html>`;
}
