// No console windows on Windows. A process without a console of its own (the desktop app, the service, the OpenClaw
// gateway Orchestra starts in the background) gives every console program it launches - PowerShell for the agents'
// exec tool, git, npm, OpenClaw's own helpers - a brand-new visible window unless the launch asks for it hidden.
// Requiring this file makes "hidden" the default for every child_process launch in the process, and the gateway
// gets it with `node --require` (prereqs.cjs nodeEnv), so its children and their node children are hidden too.
// A caller can still opt in to a window with { windowsHide: false }.
'use strict';
if (process.platform === 'win32') {
  const cp = require('child_process');
  if (!cp.__orchestraHidden) {
    cp.__orchestraHidden = true;
    const isOpts = (a) => a !== null && typeof a === 'object' && !Array.isArray(a);
    // spawn(cmd, [args], [opts]) · execFile(file, [args], [opts], [cb]) · exec(cmd, [opts], [cb]) · fork(mod, [args], [opts])
    const { promisify } = require('util');
    const wrap = (name) => {
      const orig = cp[name]; if (typeof orig !== 'function') return;
      const wrapped = function (...a) {
        let i = 1; if (Array.isArray(a[i])) i++;
        if (isOpts(a[i])) { if (a[i].windowsHide === undefined) a[i] = { ...a[i], windowsHide: true }; }
        else if (a[i] === undefined || a[i] === null || typeof a[i] === 'function') a.splice(i, a[i] == null ? 1 : 0, { windowsHide: true });
        return orig.apply(this, a);
      };
      // execFile / exec carry util.promisify.custom so promisify() resolves { stdout, stderr }; keep that contract
      // (without it every `const { stdout } = await run(...)` got undefined: GPU readings and git broke)
      if (orig[promisify.custom]) {
        wrapped[promisify.custom] = (...a) => {
          let child;
          const p = new Promise((resolve, reject) => {
            child = wrapped(...a, (err, stdout, stderr) => { if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr }); });
          });
          p.child = child; return p;
        };
      }
      cp[name] = wrapped;
    };
    for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) wrap(n);
    // ES modules that `import { spawn } from 'node:child_process'` (the service, OpenClaw) see the wrapped versions
    try { require('module').syncBuiltinESMExports(); } catch {}
  }
}
