// Downloads the avatars into renderer/avatars (once). Pinned to exact revisions so the files
// don't change under you. A failed download doesn't stop the install: run this again later.
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'avatars');

export const AVATAR_FILES = {
  // TalkingHead's own full-body avatar (its demo's default).
  'brunette.glb': 'https://raw.githubusercontent.com/met4citizen/TalkingHead/refs/tags/v1.8.0/avatars/brunette.glb',
  // A man, from HeadAudio's demo.
  'david.glb':
    'https://raw.githubusercontent.com/met4citizen/HeadAudio/c6d8af35034068b1c98dcc0fa3ec9602d711e784/avatars/david.glb',
};

await mkdir(dir, { recursive: true });

let failed = 0;
for (const [name, url] of Object.entries(AVATAR_FILES)) {
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
    await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    await rename(`${file}.part`, file);
    console.log('done');
  } catch (err) {
    failed++;
    console.log(`failed (${err.message}). Run "node scripts/fetch-avatars.mjs" again later.`);
  }
}
if (failed && process.env.CI) process.exit(1);
