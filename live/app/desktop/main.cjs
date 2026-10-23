// Orchestra desktop shell (Electron): the dashboard in an app window, a tray icon with status and pause/resume,
// the Orchestra service hosted as a child process, and the OS "stay awake" request while the team is busy.
// Security defaults: context isolation, sandbox, no Node.js in pages, only the local dashboard loads in-app.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, utilityProcess, powerSaveBlocker, Notification, dialog } = require('electron');
// Every process the desktop app starts (installers, Ollama, the gateway) without a console window. Live layout:
// desktop\..\lib; installed: resources\orchestra\lib.
for (const p of [require('path').join(__dirname, '..', 'lib', 'hide-windows.cjs'), require('path').join(process.resourcesPath || '', 'orchestra', 'lib', 'hide-windows.cjs')]) {
  try { if (require('fs').existsSync(p)) { require(p); break; } } catch {}
}
const path = require('path');
const fs = require('fs');
const net = require('net');

const DASH = 'http://127.0.0.1:8787';
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'orchestra') : path.join(__dirname, '..');
const prereqs = require(path.join(ROOT, 'lib', 'prereqs.cjs'));   // shared with the service's Setup page
// Data folder, same rule as src/config.ts: ORCHESTRA_ROOT (set by Orchestra.cmd), else ~/Orchestra. Exported to the
// environment so the service, the gateway it starts and the team plugin all use the same folder.
const DATA = process.env.ORCHESTRA_ROOT || path.join(app.getPath('home'), 'Orchestra');
process.env.ORCHESTRA_ROOT = DATA;
let win = null, tray = null, service = null, blocker = null, quitting = false, lastStatus = '', dashTab = 'dash';

// A second launch hands over to the running copy and exits WITHOUT the quit shutdown (it must not stop the gateway
// and Ollama the running copy uses). "Orchestra --quit" asks the running copy to quit (scripts, the uninstaller).
let shutDown = false;
if (!app.requestSingleInstanceLock()) { shutDown = true; app.quit(); }
app.on('second-instance', (_e, argv) => { if (argv.includes('--quit')) { quitting = true; app.quit(); } else showWindow(); });

const portOpen = (port) => new Promise((ok) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); });
async function api(p, body) {
  const r = await fetch(DASH + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: DASH }, body: JSON.stringify(body) } : {});
  return r.json();
}

/** Host the service unless one already runs (e.g. the logon task on this PC). */
async function startService() {
  if (await portOpen(8790)) return;
  service = utilityProcess.fork(path.join(ROOT, 'src', 'main.ts'), [], { serviceName: 'Orchestra service', stdio: 'ignore', env: { ...process.env, ORCHESTRA_KEEPAWAKE: 'electron' } });
  service.on('exit', (code) => { service = null; if (!quitting) setTimeout(startService, 5000); });   // restart if it dies
}

function iconImage() {
  const f = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(f) ? nativeImage.createFromPath(f) : nativeImage.createEmpty();
}

function createWindow() {
  if (win) return win;
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, title: 'Orchestra', backgroundColor: '#070505', icon: iconImage(), show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  // Only the local dashboard opens inside the app; every other link goes to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(DASH + '/api/file')) return { action: 'allow' };   // PDFs and files the agents made
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(DASH)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });   // closing hides to the tray
  return win;
}

function showWindow() {
  if (win) { win.show(); win.focus(); return; }
  createWindow(); loadDashboard();
}

/** The dashboard, once the service answers (the Setup page when something is still missing). */
function loadDashboard() {
  const load = async (tries = 0) => {
    if (await portOpen(8787)) { await win.loadURL(DASH + '/#' + dashTab).catch(() => {}); win.show(); }
    else if (tries < 60) setTimeout(() => load(tries + 1), 1000);
    else { win.loadURL('data:text/html,<body style="background:#070505;color:#f3e9ea;font:16px system-ui;padding:40px">Orchestra service did not start. Check that Ollama and OpenClaw are installed.</body>'); win.show(); }
  };
  load();
}

/** Remembered answers (userData/prereqs.json): { skipTools: true } after "don't ask again". */
const prefsFile = () => path.join(app.getPath('userData'), 'prereqs.json');
const prefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; } };
const savePrefs = (p) => { try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...prefs(), ...p })); } catch {} };

/** Startup check: start what is installed but stopped (Ollama, the gateway) without asking; list what is missing,
 *  ask, install it with progress in the window, then start the services. Returns when done or skipped. */
async function ensurePrereqs() {
  let items = await prereqs.check();
  const core = items.filter((i) => i.group === 'core' && !i.ok), tools = items.filter((i) => i.group === 'tools' && !i.ok);
  let todo = [];
  const line = (i) => `\u2022 ${i.name}: ${i.why} (${i.detail})`;
  if (core.length) {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question', title: 'Orchestra setup', buttons: ['Install now', 'Not now'], defaultId: 0, cancelId: 1, noLink: true,
      message: `Orchestra needs ${core.length === 1 ? 'one more thing' : `${core.length} more things`} on this PC`,
      detail: core.map(line).join('\n') + '\n\nInstall now? Windows may ask for permission' + (core.some((i) => i.interactive) ? ', and OpenClaw\'s first-time setup opens in a terminal window.' : '.'),
      ...(tools.length ? { checkboxLabel: `Also install the agent tools (${tools.map((i) => i.name).join(', ')})`, checkboxChecked: true } : {}),
    });
    if (response === 0) todo = [...core, ...(checkboxChecked ? tools : [])];
  } else if (tools.length && !prefs().skipTools) {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question', title: 'Orchestra setup', buttons: ['Install', 'Not now'], defaultId: 0, cancelId: 1, noLink: true,
      message: 'Install the tools the agents use?', detail: tools.map(line).join('\n') + '\n\nOrchestra runs without them, but agents that need one will fail at that step.',
      checkboxLabel: 'Don\'t ask again', checkboxChecked: false,
    });
    if (response === 0) todo = tools; else if (checkboxChecked) savePrefs({ skipTools: true });
  }

  const services = items.filter((i) => i.action === 'start' && !i.ok);
  if (todo.length || services.length) {
    createWindow(); await win.loadFile(path.join(__dirname, 'setup.html')); win.show();
    const page = (js) => win && !win.isDestroyed() && win.webContents.executeJavaScript(js).catch(() => {});
    const steps = [...todo, ...services];
    const state = steps.map((i) => ({ name: i.name, why: i.why, state: '', status: 'waiting' }));
    const show = (sub) => page(`update(${JSON.stringify({ items: state, sub })})`);
    const log = (l) => page(`log(${JSON.stringify(String(l).slice(0, 300))})`);
    show(todo.length ? undefined : 'Starting what is already installed\u2026');
    let stop = false;
    for (const [n, item] of todo.entries()) {
      while (!stop) {
        state[n].state = 'run'; state[n].status = 'installing\u2026'; show(); log(`== ${item.name}`);
        try { await item.fix(log); state[n].state = 'ok'; state[n].status = 'done'; show(); break; }
        catch (e) {
          state[n].state = 'fail'; state[n].status = 'failed'; show(); log(`!! ${e.message}`);
          const { response: r } = await dialog.showMessageBox(win, { type: 'error', title: 'Orchestra setup', buttons: ['Retry', 'Skip', 'Stop setup'], defaultId: 0, cancelId: 2, noLink: true,
            message: `Could not install ${item.name}`, detail: e.message });
          if (r === 1) break;
          if (r === 2) stop = true;
        }
      }
      if (stop) { for (let k = n + 1; k < todo.length; k++) state[k].status = 'skipped'; break; }
    }
    // Services: whatever is installed now gets started (a re-check sees fresh installs).
    if (todo.length) { await prereqs.refreshPath(); items = await prereqs.check(); }
    for (const [k, s] of services.entries()) {
      const n = todo.length + k, item = items.find((i) => i.id === s.id);
      if (item.ok) { state[n].state = 'ok'; state[n].status = 'running'; show(); continue; }
      state[n].state = 'run'; state[n].status = 'starting\u2026'; show();
      try { await item.fix(log); item.ok = true; state[n].state = 'ok'; state[n].status = 'running'; }
      catch (e) { state[n].state = 'fail'; state[n].status = 'not started'; log(`!! ${item.name}: ${e.message}`); }
      show();
    }
    show(items.some((i) => i.group !== 'tools' && !i.ok) ? 'Some pieces are still missing; the Setup page shows what is left.' : 'All set. Starting Orchestra\u2026');
  }
  if (items.some((i) => i.group !== 'tools' && !i.ok)) dashTab = 'setup';
}
// Desktop notification when the composer answers you while Orchestra is in the background: the start of the reply;
// clicking it opens the Board. Off in Settings > notifications, and quiet while you are looking at the window.
let replySeen = 0;
async function checkReplies() {
  try {
    const r = await api(`/api/replies?since=${replySeen}`);
    const first = !replySeen; replySeen = r.last || replySeen;
    if (first || !r.notify || !Notification.isSupported() || !r.replies.length) return;
    if (win && win.isVisible() && win.isFocused()) return;
    const latest = r.replies[r.replies.length - 1];
    const n = new Notification({ title: r.replies.length > 1 ? `Orchestra - ${r.replies.length} new replies` : 'Orchestra - the composer replied', body: latest.text, icon: iconImage() });
    n.on('click', () => { dashTab = 'board'; if (win) { win.loadURL(DASH + '/#board').catch(() => {}); win.show(); win.focus(); } else showWindow(); });
    n.show();
  } catch {}
}
async function refreshTray() {
  let agents = [], tasks = [], paused = false;
  try { agents = (await api('/api/agents')).agents || []; const t = await api('/api/tasks'); tasks = t.tasks || []; paused = !!t.paused; } catch {}
  const running = agents.filter((a) => a.running).map((a) => a.agent);
  const open = tasks.filter((t) => t.status === 'open').length;
  const status = paused ? 'Paused' : running.length ? `Working: ${running.join(', ')}` : open ? `${open} task(s) waiting` : 'Idle';
  // Keep the PC awake while the team has work (released when idle; power settings untouched).
  const busy = !paused && (running.length > 0 || open > 0);
  if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  lastStatus = status;   // (replies to you are announced by checkReplies, with their text)
  tray.setToolTip(`Orchestra - ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Orchestra - ${status}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Orchestra', click: showWindow },
    { label: 'Wake the brain', click: () => api('/api/control', { action: 'wake' }).catch(() => {}) },
    { label: paused ? 'Resume agents' : 'Pause agents', click: () => api('/api/control', { action: paused ? 'resume' : 'pause' }).then(refreshTray).catch(() => {}) },
    { label: 'Open work folder', click: () => shell.openPath(path.join(DATA, 'work')) },
    { type: 'separator' },
    { label: 'Quit Orchestra (stops OpenClaw and Ollama)', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.whenReady().then(async () => {
  if (shutDown) return;   // a second copy that is handing over: start nothing
  if (process.argv.includes('--quit')) { quitting = true; app.quit(); return; }   // nothing running: just stop gateway + Ollama
  app.setAppUserModelId('ai.orchestra.desktop');
  if (process.argv.includes('--hidden')) await prereqs.startServices(await prereqs.check()).catch(() => {});   // at login: start what is installed, ask nothing
  else await ensurePrereqs();   // start what is installed; ask before installing anything missing
  await startService();
  tray = new Tray(iconImage());
  tray.on('click', showWindow);
  await refreshTray();
  setInterval(refreshTray, 15000);
  checkReplies(); setInterval(checkReplies, 5000);
  if (!process.argv.includes('--hidden')) { if (win) loadDashboard(); else showWindow(); }
});
app.on('window-all-closed', (e) => { /* keep running in the tray */ });
// Quit stops everything the team runs on: the service, then the OpenClaw gateway (and its agent runs) and Ollama.
// Electron waits for it (bounded inside stopAll), then really quits.
app.on('before-quit', (e) => {
  quitting = true;
  if (shutDown) return;
  e.preventDefault();
  if (blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  if (tray) { try { tray.setToolTip('Orchestra - stopping OpenClaw and Ollama…'); } catch {} }
  if (win) win.hide();
  if (service) service.kill();
  prereqs.stopAll(() => {}).catch(() => {}).finally(() => { shutDown = true; app.quit(); });
});
