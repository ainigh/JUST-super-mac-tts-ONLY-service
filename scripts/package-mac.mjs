// After electron-builder: sign the app ad hoc (an Apple Silicon Mac won't open an arm64 app with
// no signature at all; ad hoc is enough for one that isn't notarised) and zip it the way the
// updater and install.sh unpack it: dist/SuperFace.zip, holding "Super Face.app".
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(import.meta.dirname, '..', 'dist');
const dir = ['mac-arm64', 'mac', 'mac-universal'].map((d) => join(dist, d)).find((d) => existsSync(join(d, 'Super Face.app')));
if (!dir) throw new Error('no Super Face.app in dist/');
const app = join(dir, 'Super Face.app');
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
const zip = join(dist, 'SuperFace.zip');
rmSync(zip, { force: true });
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], { stdio: 'inherit' });
console.log(`→ ${zip}`);
