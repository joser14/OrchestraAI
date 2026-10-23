// What Orchestra needs on this PC besides itself, shared by the desktop app (startup check, desktop/main.cjs) and
// the service (Setup page, src/web.ts). Three groups:
//   core     - Node.js (OpenClaw runs on it), Ollama (models), OpenClaw and its first-time setup: installed after asking
//   services - Ollama and the OpenClaw gateway running: started without asking whenever they are installed
//   tools    - what the agents call (git, uv, Python, ripgrep, jq, GitHub CLI, ffmpeg, Edge): optional, installed after asking
// Every item: { id, group, name, why, ok, detail, action: 'install' | 'start', fix(log) }. Windows only (winget + npm);
// other platforms report nothing missing.
require('./hide-windows.cjs');   // no console windows from this process (desktop app and service both load this file)
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const isWin = process.platform === 'win32';
const env = process.env;
const PF = env.ProgramFiles || 'C:\\Program Files', PF86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = env.LOCALAPPDATA || '', HOME = os.homedir();
const NODE_DIR = path.join(PF, 'nodejs');
const OLLAMA_DIR = path.join(LOCAL, 'Programs', 'Ollama');
// Linux / macOS (DGX Spark, workstations): OpenClaw is installed per user under ~/.local (no sudo), or wherever a
// global npm put it; locateOpenclaw() settles which.
const NPM_GLOBAL = isWin ? path.join(env.APPDATA || '', 'npm') : path.join(HOME, '.local');
const OPENCLAW_HOMES = isWin ? [path.join(NPM_GLOBAL, 'node_modules', 'openclaw')]
  : [path.join(HOME, '.local', 'lib', 'node_modules', 'openclaw'), path.join(HOME, '.npm-global', 'lib', 'node_modules', 'openclaw'), '/usr/local/lib/node_modules/openclaw', '/usr/lib/node_modules/openclaw', '/opt/homebrew/lib/node_modules/openclaw'];
let OPENCLAW_DIR = env.OPENCLAW_ROOT || OPENCLAW_HOMES.find((d) => fs.existsSync(path.join(d, 'openclaw.mjs'))) || OPENCLAW_HOMES[0];
const OPENCLAW_CONFIG = path.join(HOME, '.openclaw', 'openclaw.json');
const WINGET_LINKS = path.join(LOCAL, 'Microsoft', 'WinGet', 'Links');

/** Run a program, resolve with { code, out } (never rejects). */
function run(cmd, args, opts = {}) {
  return new Promise((ok) => {
    let out = '';
    const each = (d) => { out += d; opts.onLine && String(d).split(/\r?\n/).filter((l) => l.trim()).forEach(opts.onLine); };
    let p; try { p = spawn(cmd, args, { windowsHide: true, ...opts }); } catch (e) { return ok({ code: -1, out: e.message }); }
    p.stdout && p.stdout.on('data', each); p.stderr && p.stderr.on('data', each);
    p.on('error', (e) => ok({ code: -1, out: e.message }));
    p.on('close', (code) => ok({ code, out }));
  });
}
const where = (name) => new Promise((ok) => execFile(isWin ? 'where.exe' : 'which', [name], { windowsHide: true }, (e, so) => ok(e ? '' : String(so).split(/\r?\n/)[0].trim())));
/** Linux/macOS: the openclaw command is a link into its package folder; follow it when the usual homes miss. */
async function locateOpenclaw() {
  if (isWin || env.OPENCLAW_ROOT || fs.existsSync(path.join(OPENCLAW_DIR, 'openclaw.mjs'))) return;
  const bin = await where('openclaw'); if (!bin) return;
  try { const real = fs.realpathSync(bin); if (fs.existsSync(path.join(path.dirname(real), 'openclaw.mjs'))) OPENCLAW_DIR = path.dirname(real); } catch {}
}
/** Install commands for systems without winget: the user runs them (they need sudo); Fix explains instead of failing silently. */
const manual = (what, cmds) => async () => {
  const cmd = cmds[process.platform] || cmds.linux;
  throw new Error(`${what} needs an administrator install on this system. Run this in a terminal, then press Fix again:  ${cmd}`);
};
/** macOS: Homebrew installs without sudo, so Fix can do it (brew itself is the one thing the user installs). */
const brew = (formula, what, cask = false) => async (log) => {
  const b = await find('brew', ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
  if (!b) throw new Error(`${what}: install Homebrew first (https://brew.sh), then press Fix again. Or install ${what} yourself.`);
  log(`brew install ${cask ? '--cask ' : ''}${formula}`);
  const r = await run(b, ['install', ...(cask ? ['--cask'] : []), formula], { onLine: log, env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' } });
  if (r.code !== 0) throw new Error(`brew exited with ${r.code}`);
};
/** winget on Windows, Homebrew on macOS, the printed command on Linux (apt/dnf need sudo). */
const installer = (wingetId, what, cmds, brewFormula, cask = false) =>
  (isWin ? winget(wingetId) : process.platform === 'darwin' && brewFormula ? brew(brewFormula, what, cask) : manual(what, cmds));
const portOpen = (port) => new Promise((ok) => { const s = net.connect(port, '127.0.0.1'); s.setTimeout(3000, () => { s.destroy(); ok(false); }); s.on('connect', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Environment for the Node processes Orchestra starts (gateway, openclaw CLI): they preload hide-windows.cjs, so
 *  the consoles they open (the agents' PowerShell, git, npm, OpenClaw helpers) stay hidden. NODE_OPTIONS carries
 *  over to their own node children. */
const HIDE = path.join(__dirname, 'hide-windows.cjs');
// forward slashes: NODE_OPTIONS treats backslashes inside quotes as escapes (E:\Orchestra became "E:Orchestra...")
const nodeEnv = () => (isWin && fs.existsSync(HIDE) ? { ...env, NODE_OPTIONS: `${(env.NODE_OPTIONS || '').replace(/--require\s+"[^"]*hide-windows\.cjs"/g, '').trim()} --require "${HIDE.replace(/\\/g, '/')}"`.trim() } : env);
async function waitPort(port, seconds) { for (let i = 0; i < seconds; i++) { if (await portOpen(port)) return true; await sleep(1000); } return portOpen(port); }

/** First existing known path, else PATH (where.exe), else the winget links folder. */
async function find(name, known = []) {
  for (const k of known) if (k && fs.existsSync(k)) return k;
  const w = await where(name); if (w) return w;
  if (!isWin) return '';
  const l = path.join(WINGET_LINKS, name + '.exe'); return fs.existsSync(l) ? l : '';
}

/** Pick up PATH changes made by installers since this process started (Machine + User PATH from the registry). */
async function refreshPath() {
  if (!isWin) return;
  const read = (key) => new Promise((ok) => execFile('reg.exe', ['query', key, '/v', 'Path'], { windowsHide: true }, (e, so) => {
    const m = !e && /Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i.exec(String(so)); ok(m ? m[1].trim() : '');
  }));
  const expand = (s) => s.replace(/%([^%]+)%/g, (_, v) => env[v] ?? env[Object.keys(env).find((k) => k.toLowerCase() === v.toLowerCase())] ?? `%${v}%`);
  const sys = await read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), usr = await read('HKCU\\Environment');
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const have = new Set(String(env[key] || '').split(';').map((p) => p.toLowerCase().replace(/\\$/, '')));
  const add = [...expand(sys).split(';'), ...expand(usr).split(';'), WINGET_LINKS, path.join(HOME, '.local', 'bin')]
    .filter((p) => p && !have.has(p.toLowerCase().replace(/\\$/, '')) && fs.existsSync(p));
  if (add.length) env[key] = [env[key], ...add].filter(Boolean).join(';');
}

/** OpenClaw wants Node >=24.16 <25, or >=26.1. */
const nodeOk = (v) => { const [a, b] = String(v).replace(/^v/, '').split('.').map(Number); return a === 24 ? b >= 16 : a === 26 ? b >= 1 : a > 26; };
/** A link (junction/symlink) whose target folder is gone, e.g. OpenClaw kept on a drive that was cleared. */
const deadLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p); } catch { return false; } };
/** Remove only the dead link itself (its target no longer exists), so a fresh install can take its place. */
function clearDeadLink(p, log) {
  if (!deadLink(p)) return;
  log(`removing the broken link ${p} (it pointed to a folder that no longer exists)`);
  try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); }
}
const openclawOk = () => fs.existsSync(path.join(OPENCLAW_DIR, 'openclaw.mjs')) && fs.existsSync(path.join(OPENCLAW_DIR, 'dist', 'plugin-sdk', 'gateway-runtime.js'));
/** OpenClaw's config file exists and sets gateway.mode (JSON first, JSON5 fallback by pattern). */
function gatewayConfigured() {
  let s; try { s = fs.readFileSync(OPENCLAW_CONFIG, 'utf8'); } catch { return false; }
  try { return !!JSON.parse(s).gateway?.mode; } catch { return /["']?gateway["']?\s*:\s*\{[^}]*["']?mode["']?\s*:/.test(s); }
}
const nodeExe = () => find(isWin ? 'node' : 'node', isWin ? [path.join(NODE_DIR, 'node.exe')] : ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node']);
const ollamaExe = () => find('ollama', isWin ? [path.join(OLLAMA_DIR, 'ollama.exe')] : ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama']);

const winget = (id) => async (log) => {
  if (!(await where('winget'))) throw new Error('winget is not available on this PC (install "App Installer" from the Microsoft Store)');
  log(`winget install ${id}`);
  const r = await run('winget', ['install', '-e', '--id', id, '--silent', '--accept-source-agreements', '--accept-package-agreements'], { onLine: log });
  // -1978335189 = already installed / no newer version: fine
  if (r.code !== 0 && r.code !== -1978335189) throw new Error(`winget exited with ${r.code}`);
  await refreshPath();
};

/** Start Ollama the way its installer sets it up (tray app), else `ollama serve`; wait until it answers. */
async function startOllama(log) {
  if (await portOpen(11434)) return;
  const app = isWin ? path.join(OLLAMA_DIR, 'ollama app.exe') : '', exe = await ollamaExe();
  if (!exe && !(app && fs.existsSync(app))) throw new Error('Ollama is not installed');
  log('starting Ollama');
  // Linux: the install script's systemd service normally runs it already; if it is stopped, `ollama serve` as the
  // user (its models then live in ~/.ollama; `sudo systemctl start ollama` uses the service's own model store)
  const p = app && fs.existsSync(app) ? spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: true }) : spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => {}); p.unref();
  if (!(await waitPort(11434, 30))) throw new Error('Ollama did not answer within 30 seconds');
}
async function startGateway(log) {
  if (await portOpen(18789)) return;
  await locateOpenclaw();
  if (!openclawOk()) throw new Error('OpenClaw is not installed');
  if (!gatewayConfigured()) throw new Error('OpenClaw first-time setup is not finished (gateway mode not set)');
  const node = await nodeExe(); if (!node) throw new Error('Node.js is not installed');
  const mjs = path.join(OPENCLAW_DIR, 'openclaw.mjs');
  // Orchestra runs the gateway itself - hidden, with hide-windows preloaded, logging to ~/.openclaw/logs - rather than
  // through OpenClaw's optional background service (a scheduled task outside Orchestra's control). If that service
  // is installed and running, the port is already open and nothing is started here.
  log('starting the OpenClaw gateway in the background');
  const logDir = path.join(HOME, '.openclaw', 'logs'); fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'orchestra-gateway.log'), 'a');
  const p = spawn(node, [mjs, 'gateway'], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: nodeEnv() });
  p.on('error', () => {}); p.unref(); fs.closeSync(out);
  if (!(await waitPort(18789, 60))) throw new Error(`the gateway did not start within a minute (see ${path.join(logDir, 'orchestra-gateway.log')})`);
}

// Agent tools: [id, name, why, exe (Windows / elsewhere), winget id, apt package (Linux), brew formula (macOS), known paths]
const TOOLS = [
  ['git', 'Git', 'keeps the work folder history', ['git', 'git'], 'Git.Git', 'git', 'git', () => [path.join(PF, 'Git', 'cmd', 'git.exe'), path.join(LOCAL, 'OpenClaw', 'deps', 'portable-git', 'cmd', 'git.exe')]],
  ['python', 'Python', 'agents run Python scripts', ['py', 'python3'], 'Python.Python.3.13', 'python3', 'python', () => [path.join(env.WINDIR || 'C:\\Windows', 'py.exe')]],
  ['uv', 'uv', 'runs Python tools (PDF text, Whisper)', ['uv', 'uv'], 'astral-sh.uv', '', 'uv', () => [path.join(HOME, '.local', 'bin', isWin ? 'uv.exe' : 'uv')]],
  ['rg', 'ripgrep', 'fast file search', ['rg', 'rg'], 'BurntSushi.ripgrep.MSVC', 'ripgrep', 'ripgrep', () => []],
  ['jq', 'jq', 'reads JSON', ['jq', 'jq'], 'jqlang.jq', 'jq', 'jq', () => []],
  ['gh', 'GitHub CLI', 'works with GitHub', ['gh', 'gh'], 'GitHub.cli', 'gh', 'gh', () => [path.join(PF, 'GitHub CLI', 'gh.exe')]],
  ['ffmpeg', 'FFmpeg', 'audio and video', ['ffmpeg', 'ffmpeg'], 'Gyan.FFmpeg', 'ffmpeg', 'ffmpeg', () => []],
  // PDFs and screenshots: any Chromium-family browser (Linux ARM64 / DGX Spark: Chromium; Chrome has no ARM build)
  ['edge', isWin ? 'Microsoft Edge' : 'Chromium-based browser', 'makes PDFs and screenshots', ['msedge', 'chromium'], 'Microsoft.Edge', 'chromium-browser', 'chromium', () => require('./browser.cjs').candidates()],
];
const toolCmd = (apt, id) => (id === 'uv' ? 'curl -LsSf https://astral.sh/uv/install.sh | sh' : `sudo apt install -y ${apt}   (Fedora: sudo dnf install -y ${apt})`);

/** Everything, in fix order (installs before the services that need them). */
async function check() {
  await refreshPath(); await locateOpenclaw();
  const items = [];

  const node = await nodeExe();
  const ver = node ? (await run(node, ['--version'])).out.trim() : '';
  items.push({ id: 'node', group: 'core', action: 'install', name: 'Node.js', why: 'OpenClaw runs on it', ok: !!ver && nodeOk(ver),
    detail: !ver ? 'not installed' : nodeOk(ver) ? ver : `${ver} is too old (needs 24.16 or newer)`,
    fix: installer('OpenJS.NodeJS.LTS', 'Node.js 24', { linux: 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs' }, 'node') });

  const ollama = await ollamaExe();
  items.push({ id: 'ollama', group: 'core', action: 'install', name: 'Ollama', why: 'runs the AI models on this PC', ok: !!ollama, detail: ollama ? 'installed' : 'not installed',
    // Linux: the official script sets up the NVIDIA (incl. GB10 / DGX Spark, ARM64) or AMD build and a systemd service
    fix: installer('Ollama.Ollama', 'Ollama', { linux: 'curl -fsSL https://ollama.com/install.sh | sh' }, 'ollama', true) });

  items.push({ id: 'openclaw', group: 'core', action: 'install', name: 'OpenClaw', why: 'runs the agents', ok: openclawOk(),
    detail: openclawOk() ? 'installed' : deadLink(path.join(NPM_GLOBAL, 'node_modules', 'openclaw')) ? 'broken: it was linked to a folder that no longer exists'
      : isWin && fs.existsSync(path.join(NPM_GLOBAL, 'openclaw.cmd')) ? 'broken install (command is there, package is missing)' : 'not installed',
    fix: async (log) => {
      if (isWin) clearDeadLink(path.join(NPM_GLOBAL, 'node_modules', 'openclaw'), log);
      // npm's own script run by node directly: no shell, so paths with spaces ("C:\Program Files") are safe
      const n = await nodeExe(); if (!n) throw new Error('Node.js is not installed');
      // Windows: <nodejs>\node_modules\npm; Linux/macOS: <prefix>/bin/node -> <prefix>/lib/node_modules/npm
      const cli = [path.join(path.dirname(n), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(fs.realpathSync(n)), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p));
      if (!cli) throw new Error(`npm was not found next to ${n}`);
      // Linux/macOS: install for this user under ~/.local (no sudo; ~/.local/bin is on PATH on Ubuntu / DGX OS)
      const prefix = isWin ? [] : ['--prefix', NPM_GLOBAL];
      const npm = (...a) => run(n, [cli, ...a, ...prefix, 'openclaw@latest', '--no-fund', '--no-audit'], { onLine: log });
      log('npm install -g openclaw@latest');
      let r = await npm('install', '-g');
      if (r.code !== 0 && /EEXIST/.test(r.out)) { log('an old openclaw command is in the way - replacing it'); r = await npm('install', '-g', '--force'); }
      const why = (r.out.match(/npm (?:ERR!|error) .+/g) || []).slice(-1)[0];
      if (!isWin) { OPENCLAW_DIR = path.join(NPM_GLOBAL, 'lib', 'node_modules', 'openclaw'); }
      if (r.code !== 0 || !openclawOk()) throw new Error(`npm install failed (exit ${r.code})${why ? `: ${why}` : ''}`);
    } });

  // Set up = the config exists and says how the gateway runs (an unfinished onboarding leaves gateway.mode out,
  // and the gateway then refuses to start).
  const configured = gatewayConfigured();
  items.push({ id: 'openclaw-setup', group: 'core', action: 'install', name: 'OpenClaw first-time setup', why: 'creates its settings and the gateway', ok: configured,
    detail: configured ? 'done' : deadLink(path.dirname(OPENCLAW_CONFIG)) ? 'its settings folder was linked to a folder that no longer exists'
      : fs.existsSync(OPENCLAW_CONFIG) ? 'not finished: the gateway mode is not set' : 'not done yet',
    fix: async (log) => {
      if (!openclawOk()) throw new Error('install OpenClaw first');
      clearDeadLink(path.dirname(OPENCLAW_CONFIG), log);
      const n = await nodeExe(); if (!n) throw new Error('Node.js is not installed');
      // the non-interactive part: a local gateway on this PC (what OpenClaw's own error message asks for)
      log('openclaw config set gateway.mode local');
      const r = await run(n, [path.join(OPENCLAW_DIR, 'openclaw.mjs'), 'config', 'set', 'gateway.mode', 'local'], { onLine: log });
      if (gatewayConfigured()) return;
      if (!isWin) throw new Error(`config set did not finish it (exit ${r.code}). Run this in a terminal and answer its questions, then press Fix again:  node "${path.join(OPENCLAW_DIR, 'openclaw.mjs')}" onboard --mode local`);
      log(`config set did not finish it (exit ${r.code}). Opening OpenClaw setup in a terminal window: finish it there.`);
      const oc = path.join(NPM_GLOBAL, 'openclaw.cmd');
      // a visible console (onboarding asks questions); /wait holds until the user closes it
      await run(`start "OpenClaw setup" /wait cmd /c ""${oc}" onboard --mode local & pause"`, [], { shell: true, windowsHide: false });
      if (!gatewayConfigured()) throw new Error('OpenClaw setup was not finished');
    } });
  // Services: started without asking when installed.
  const olUp = await portOpen(11434);
  items.push({ id: 'ollama-running', group: 'services', action: 'start', name: 'Ollama running', why: 'the models load in it', ok: olUp,
    detail: olUp ? 'running' : ollama ? 'installed, not running' : 'needs Ollama installed', fix: startOllama });
  const gwUp = await portOpen(18789);
  // No OpenClaw background service on purpose: Orchestra starts the gateway itself (hidden, with hide-windows
  // preloaded) whenever it runs and restarts it if it stops; a scheduled-task service would run outside that.
  items.push({ id: 'gateway', group: 'services', action: 'start', name: 'OpenClaw gateway', why: 'the agents run inside it (Orchestra starts it for you; no separate service needed)', ok: gwUp,
    detail: gwUp ? 'running' : openclawOk() && configured ? 'installed, not running' : 'needs OpenClaw installed and set up', fix: startGateway });

  for (const [id, name, why, exe, wid, apt, brewF, known] of TOOLS) {
    const at = await find(exe[isWin ? 0 : 1], known());
    const cask = id === 'edge';   // macOS: the browser is a cask (Chromium)
    items.push({ id, group: 'tools', action: 'install', name, why, ok: !!at, detail: at || 'not installed', fix: installer(wid, name, { linux: toolCmd(apt, id), darwin: `brew install ${cask ? '--cask ' : ''}${brewF}` }, brewF, cask) });
  }
  return items;
}

/** Run the OpenClaw CLI with the system Node (never process.execPath: inside the desktop app that is electron.exe). */
async function openclaw(args, timeoutMs = 60000) {
  const node = await nodeExe(); if (!node) return { code: -1, out: 'Node.js is not installed' };
  if (!openclawOk()) return { code: -1, out: 'OpenClaw is not installed' };
  return Promise.race([run(node, [path.join(OPENCLAW_DIR, 'openclaw.mjs'), ...args], { env: nodeEnv() }), sleep(timeoutMs).then(() => ({ code: -2, out: 'timed out' }))]);
}

/** Start every installed service that is not running. Returns what could not be started, with the reason. */
async function startServices(items, log = () => {}) {
  const failed = [];
  for (const it of items.filter((i) => i.action === 'start' && !i.ok)) {
    try { await it.fix(log); it.ok = true; it.detail = 'running'; } catch (e) { failed.push({ id: it.id, error: e.message }); }
  }
  return failed;
}

/** PIDs listening on a local TCP port (netstat on Windows, lsof elsewhere). */
function pidsOnPort(port) {
  return new Promise((ok) => {
    if (isWin) execFile('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true }, (e, so) => ok(e ? [] : [...new Set(String(so).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((c) => c[1] && c[1].endsWith(':' + port) && /LISTEN/i.test(c[3] || '')).map((c) => Number(c[4])).filter((p) => p > 0))]));
    else execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (e, so) => ok(e ? [] : String(so).split(/\s+/).map(Number).filter((p) => p > 0)));
  });
}
/** End a process and everything it started (the gateway's agent runs and helpers). */
const killTree = (pid) => new Promise((ok) => {
  if (isWin) execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => ok());
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } ok(); }
});
const killByName = (names) => new Promise((ok) => {
  if (isWin) execFile('taskkill.exe', ['/F', '/T', ...names.flatMap((n) => ['/IM', n])], { windowsHide: true }, () => ok());
  else execFile('pkill', ['-u', String(os.userInfo().uid), '-x', ...names.slice(0, 1)], () => ok());   // only this user's processes
});

/** Quit: stop everything the team runs on - unload the models, the OpenClaw gateway (and its runs), Ollama
 *  (tray app and server). Each step is bounded, so quitting never hangs; failures are logged and skipped. */
async function stopAll(log = () => {}) {
  const step = (name, p, ms = 8000) => { let t; return Promise.race([p.catch((e) => log(`${name}: ${e.message}`)), new Promise((ok) => { t = setTimeout(() => { log(`${name}: gave up after ${ms / 1000} s`); ok(); }, ms); })]).finally(() => clearTimeout(t)); };
  // free VRAM cleanly first (Ollama may be shared with other apps until it is closed below)
  await step('unload models', (async () => {
    const ps = await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3000) })).json();
    for (const m of ps.models || []) await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(3000) }).catch(() => {});
  })(), 6000);
  await step('gateway', (async () => {
    const pids = await pidsOnPort(18789);
    for (const p of pids) await killTree(p);
    if (pids.length) log(`stopped the OpenClaw gateway (pid ${pids.join(', ')})`);
  })());
  await step('ollama', (async () => {
    if (!(await portOpen(11434))) return;
    if (process.platform === 'darwin') await new Promise((ok) => execFile('osascript', ['-e', 'quit app "Ollama"'], () => ok()));
    await killByName(isWin ? ['ollama app.exe', 'ollama.exe'] : ['ollama']);
    for (const p of await pidsOnPort(11434)) await killTree(p);   // a server started some other way
    log('stopped Ollama');
  })());
}

/** For JSON (the Setup page): everything but the fix functions. */
const plain = (items) => items.map(({ fix, ...rest }) => rest);

module.exports = { check, startServices, startOllama, startGateway, stopAll, openclaw, plain, refreshPath, nodeOk };
