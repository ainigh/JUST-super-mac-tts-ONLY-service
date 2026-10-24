// Loaded inside HeadTTS's worker, as the module it takes transformers.js from. HeadTTS starts the
// voice model without waiting on it, so a failure there never reaches the page: HeadTTS only sees
// the worker go quiet and gives up after 10 seconds, saying it "failed to start". This tells the
// page what really went wrong (and makes HeadTTS give up at once, on a real error), and, while the
// model is still being set up (which sends no progress of its own), keeps HeadTTS from giving up
// too soon.

export * from './ort-local.mjs';

const channel = new BroadcastChannel('superface-errors');
const text = (x) => (x instanceof Error ? `${x.name}: ${x.message}${x.stack ? `\n${x.stack}` : ''}` : typeof x === 'string' ? x : (() => {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
})());
const report = (message, detail = '') => channel.postMessage({ source: 'voice', message, detail, at: Date.now() });

// What the worker writes as an error, the page hears too.
const consoleError = console.error.bind(console);
console.error = (...args) => {
  consoleError(...args);
  const errors = args.filter((a) => a instanceof Error);
  report(args.filter((a) => typeof a === 'string').join(' ').trim() || 'the voice worker reported an error', [...errors, ...args.filter((a) => typeof a !== 'string' && !(a instanceof Error))].map(text).join('\n'));
};

// A heartbeat: "still working" to HeadTTS every few seconds while the model is set up, for three
// minutes at most, until it says it's ready.
let beats = 0;
const heartbeat = setInterval(() => {
  if (++beats > 60) return clearInterval(heartbeat);
  post({ type: 'progress', data: { loaded: 0, total: 0, lengthComputable: false } });
}, 3000);
const post = self.postMessage.bind(self);
self.postMessage = (message, transfer) => {
  if (message?.type === 'ready') clearInterval(heartbeat);
  return post(message, transfer);
};

// The model failed to load: the page is told why, and HeadTTS hears of it now, not in 10 seconds.
self.addEventListener('unhandledrejection', (e) => {
  clearInterval(heartbeat);
  report('the voice model failed to load', text(e.reason));
  setTimeout(() => {
    throw e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  });
});
