// Every file the avatar's page loads is in the app: follows the page's imports (through its import
// map) from renderer/index.html, file by file, and fails naming whatever is missing. A packaged app
// once shipped without three.js's loaders and showed nothing; this catches that before a release.
//
//   node scripts/check-package.mjs            the built app (dist/*/Super Face.app, or --asar path)
//   node scripts/check-package.mjs --source   this checkout, as `npm run dev` and `npm start` serve it

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function findAsar() {
  const i = args.indexOf('--asar');
  if (i !== -1) return args[i + 1];
  const dist = join(root, 'dist');
  for (const d of existsSync(dist) ? readdirSync(dist) : []) {
    for (const p of [join(dist, d, 'Super Face.app', 'Contents', 'Resources', 'app.asar'), join(dist, d, 'resources', 'app.asar')]) {
      if (existsSync(p)) return p;
    }
  }
  throw new Error('no built app in dist/ (or pass --asar path, or --source)');
}

/** The app's files: read(path) → its text (null when it isn't there). Paths start with "/". */
function files() {
  if (args.includes('--source')) {
    return { where: root, read: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null) };
  }
  const asar = createRequire(import.meta.url)('@electron/asar');
  const archive = findAsar();
  const listed = new Set(asar.listPackage(archive).map((p) => p.replaceAll('\\', '/')));
  return {
    where: archive,
    read: (p) => (listed.has(p) ? asar.extractFile(archive, p.slice(1)).toString('utf8') : null),
  };
}

const { where, read } = files();
const page = read('/renderer/index.html');
if (page === null) throw new Error(`${where} has no renderer/index.html`);
const imports = JSON.parse(page.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;

/** A module specifier, from the module at `from`, to a path in the app (null: not ours to check). */
function resolve(spec, from) {
  if (/^(https?:|data:|blob:|node:)/.test(spec)) return null; // node: only in HeadTTS's Node.js server
  if (imports[spec]) return imports[spec];
  for (const [prefix, target] of Object.entries(imports)) {
    if (prefix.endsWith('/') && spec.startsWith(prefix)) return target + spec.slice(prefix.length);
  }
  if (spec.startsWith('/')) return spec;
  if (spec.startsWith('.')) return posix.normalize(posix.join(posix.dirname(from), spec));
  throw new Error(`${from} imports "${spec}", which the import map doesn't name`);
}

// Static imports and exports, and dynamic imports of a plain string.
const IMPORT = /(?:^|[;\s}])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[;\s])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

const missing = [];
const seen = new Set();
const queue = [...page.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => resolve(m[1], '/renderer/index.html'));
// The files that are loaded by URL rather than imported.
queue.push(
  '/node_modules/@met4citizen/headtts/modules/worker-tts.mjs',
  '/node_modules/@met4citizen/headtts/modules/language-en-us.mjs', // imported by a name it builds
  '/node_modules/@huggingface/transformers/dist/transformers.min.js',
  '/node_modules/@met4citizen/headtts/dictionaries/en-us.txt',
  '/renderer/avatars/brunette.glb',
  '/renderer/avatars/david.glb',
  '/renderer/avatars/avaturn.glb',
  '/renderer/avatars/avatarsdk.glb',
  '/renderer/style.css',
  '/renderer/ears-worker.mjs', // the ears' worker, started by URL
  '/renderer/chat.html', // the chat window, and what it loads
  '/renderer/chat.mjs',
  '/renderer/chat.css',
);
while (queue.length) {
  const p = queue.shift();
  if (!p || seen.has(p)) continue;
  seen.add(p);
  const text = p.endsWith('.glb') ? (read(p) === null ? null : '') : read(p);
  if (text === null) {
    missing.push(p);
    continue;
  }
  if (!/\.m?js$/.test(p)) continue;
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] || m[2] || m[3];
    const target = resolve(spec, p);
    if (target && !seen.has(target)) queue.push(target);
  }
}

if (missing.length) {
  console.error(`✗ ${where} is missing what the avatar's page loads:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ every file the avatar's page loads is there (${seen.size} files, ${where})`);
