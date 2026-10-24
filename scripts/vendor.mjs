// Copies three.js's add-ons (the GLTF loader and the rest TalkingHead imports) into
// renderer/vendor/three-addons. They live in three's examples/ folder, and electron-builder leaves
// every node_modules/*/examples folder out of the app whatever the build's file list says: from
// there, the packaged avatar found no loader and never appeared.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'three', 'examples', 'jsm');
const to = join(root, 'renderer', 'vendor', 'three-addons');

if (!existsSync(from)) throw new Error(`three.js's add-ons aren't installed (${from}): run npm install`);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log('three.js add-ons → renderer/vendor/three-addons');
