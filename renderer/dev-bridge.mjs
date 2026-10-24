// Outside the app (npm run dev, a plain browser): the same bridge to scripts/dev-server.mjs, which
// stands in for the main process.

export function bridge() {
  const post = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  return {
    getSettings: () => fetch('/dev/settings').then((r) => r.json()),
    saveSettings: (patch) => post('/dev/settings', patch),
    onCommand: (fn) => {
      const es = new EventSource('/dev/cmd');
      es.onmessage = (e) => fn(JSON.parse(e.data));
    },
    reply: (id, ok, result, error) => {
      // An ArrayBuffer doesn't survive JSON: sent as base64.
      if (result?.pcm instanceof ArrayBuffer) {
        const bytes = new Uint8Array(result.pcm);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        result = { ...result, pcm: btoa(s), pcmBase64: true };
      }
      post('/dev/reply', { id, ok, result, error });
    },
    event: (ev) => post('/dev/event', ev),
    direct: (texts, who) =>
      fetch('/dev/direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts, who }) }).then((r) => {
        if (!r.ok) throw new Error(`direct ${r.status}`);
        return r.json().then((j) => j.content);
      }),
    toggleChat: () => window.open('/renderer/chat.html', 'superface-chat', 'width=380,height=640'),
    dragStart() {},
    dragMove() {},
    dragEnd() {},
    showMenu() {},
  };
}
