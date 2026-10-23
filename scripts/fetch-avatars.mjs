// Downloads the sample avatars into renderer/avatars (once). Pinned to exact
// revisions so the files don't change under you.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'avatars');

const AVATARS = {
  // motion-engine's demo avatar: its gestures and expression levels are tuned to it.
  // Ready Player Me, CC BY-NC-SA 4.0 (non-commercial).
  'female_1.glb': 'https://raw.githubusercontent.com/lhupyn/motion-engine/v2.1.0/demo/public/female_1.glb',
  // The avatars from HeadAudio's openai.html demo.
  'julia.glb':
    'https://raw.githubusercontent.com/met4citizen/HeadAudio/c6d8af35034068b1c98dcc0fa3ec9602d711e784/avatars/julia.glb',
  'david.glb':
    'https://raw.githubusercontent.com/met4citizen/HeadAudio/c6d8af35034068b1c98dcc0fa3ec9602d711e784/avatars/david.glb',
};

await mkdir(dir, { recursive: true });

for (const [name, url] of Object.entries(AVATARS)) {
  const file = join(dir, name);
  try {
    if ((await stat(file)).size > 0) continue;
  } catch {
    /* not downloaded yet */
  }
  process.stdout.write(`Downloading ${name}… `);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    console.log('done');
  } catch (err) {
    console.log(`failed (${err.message}). Run "node scripts/fetch-avatars.mjs" again later.`);
  }
}
