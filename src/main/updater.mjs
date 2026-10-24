// Updates: GitHub builds a release for every push to main (SuperFace.zip). This checks for a newer
// one at launch and every 6 hours, and installs it on request: downloads it, swaps the app in
// place once this copy has quit, and opens the new one. It talks to GitHub through `gh` when it's
// installed and signed in (so a private repository works), else directly.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = 'ainigh/JUST-super-mac-tts-ONLY-service';
export const ASSET = 'SuperFace.zip';

/** Is version `a` ("0.1.12") newer than `b`? Numbers compared part by part; anything else is older. */
export function newer(a, b) {
  const parse = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p > q;
  }
  return false;
}

const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
      else resolve(stdout);
    });
  });
}

export class Updater {
  /**
   * @param {object} o
   * @param {string} o.version - this copy's
   * @param {() => string|null} o.appPath - the .app bundle this runs from (null: not an app)
   * @param {() => void} o.quit
   * @param {(state: object) => void} [o.onChange]
   */
  constructor({ version, appPath, quit, onChange = () => {} }) {
    this.version = version;
    this.appPath = appPath;
    this.quit = quit;
    this.onChange = onChange;
    this.current = { state: 'idle', version };
    this.release = null;
  }

  state() {
    return this.current;
  }

  set(s) {
    this.current = { version: this.version, ...s };
    this.onChange(this.current);
  }

  start() {
    this.check(false);
    setInterval(() => this.check(false), 6 * 3600 * 1000).unref?.();
  }

  gh() {
    return GH.find((p) => fs.existsSync(p)) || null;
  }

  async latest() {
    const gh = this.gh();
    if (gh) {
      try {
        return JSON.parse(await run(gh, ['api', `repos/${REPO}/releases/latest`]));
      } catch {
        /* not signed in: try without */
      }
    }
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 404) throw new Error('no release yet (or the repository is private: install gh and sign in)');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return res.json();
  }

  async check(userInitiated = true) {
    if (this.current.state === 'checking' || this.current.state === 'installing') return this.current;
    const before = this.current;
    this.set({ state: 'checking' });
    try {
      const r = await this.latest();
      const asset = r.assets?.find((a) => a.name === ASSET);
      if (asset && newer(r.tag_name, this.version)) {
        this.release = { tag: r.tag_name, asset, notes: r.body || '' };
        this.set({ state: 'available', latest: r.tag_name.replace(/^v/, ''), notes: (r.body || '').slice(0, 500) });
      } else {
        this.set({ state: 'upToDate', latest: r.tag_name?.replace(/^v/, '') });
      }
    } catch (err) {
      // A quiet background check that fails doesn't leave an error showing.
      if (userInitiated) this.set({ state: 'failed', message: err.message });
      else this.set(before.state === 'available' ? before : { state: 'idle' });
    }
    return this.current;
  }

  async install() {
    if (this.current.state !== 'available') await this.check(true);
    if (this.current.state !== 'available' || !this.release) return this.current;
    const app = this.appPath();
    if (!app) {
      this.set({ state: 'failed', message: "this copy isn't an app bundle (npm start?): pull and restart instead" });
      return this.current;
    }
    this.set({ state: 'installing', step: 'Downloading…' });
    try {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'superface-update-'));
      const zip = path.join(work, ASSET);
      const gh = this.gh();
      let got = false;
      if (gh) {
        try {
          await run(gh, ['release', 'download', this.release.tag, '--repo', REPO, '--pattern', ASSET, '--dir', work]);
          got = fs.existsSync(zip);
        } catch {
          /* fall back to a plain download */
        }
      }
      if (!got) {
        const res = await fetch(this.release.asset.browser_download_url);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      }
      this.set({ state: 'installing', step: 'Unpacking…' });
      await run('/usr/bin/ditto', ['-x', '-k', zip, path.join(work, 'new')]);
      const fresh = fs.readdirSync(path.join(work, 'new')).find((n) => n.endsWith('.app'));
      if (!fresh) throw new Error("the download didn't hold the app");
      // Once this copy has quit: the new one goes in, the old one is kept until it has started.
      const script = path.join(work, 'swap.sh');
      fs.writeFileSync(
        script,
        `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
app=${JSON.stringify(app)}
old="$app.previous"
rm -rf "$old"; mv "$app" "$old"
if /usr/bin/ditto ${JSON.stringify(path.join(work, 'new', fresh))} "$app"; then
  xattr -dr com.apple.quarantine "$app" 2>/dev/null
  open "$app"; sleep 8
  if pgrep -f "$app/Contents/MacOS" >/dev/null; then rm -rf "$old"; else rm -rf "$app"; mv "$old" "$app"; open "$app"; fi
else
  rm -rf "$app"; mv "$old" "$app"; open "$app"
fi
rm -rf ${JSON.stringify(work)}
`,
        { mode: 0o755 },
      );
      spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
      this.set({ state: 'installing', step: 'Restarting…' });
      setTimeout(() => this.quit(), 300);
    } catch (err) {
      this.set({ state: 'failed', message: `Update failed: ${err.message}` });
    }
    return this.current;
  }
}
