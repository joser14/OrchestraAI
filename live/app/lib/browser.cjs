// A Chromium-family browser for headless PDFs and screenshots (md2pdf.cjs, the web screenshot tool). Edge on
// Windows; Chromium / Chrome / Edge on Linux (DGX Spark and other ARM64 boxes: Chromium, Chrome has no ARM build);
// Chrome or Edge on macOS. All take the same --headless / --print-to-pdf / --screenshot flags.
const fs = require('fs');
const path = require('path');

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = env.LOCALAPPDATA || '';
    return [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  }
  if (process.platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
}

/** Path of the first installed browser, or '' when there is none. */
function findBrowser() { return candidates().find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || ''; }

module.exports = { findBrowser, candidates };
