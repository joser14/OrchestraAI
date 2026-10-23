// Flow: the live team view. Fed by the server's push stream (/api/stream, Server-Sent Events) with a polling
// fallback; renders neon cards for You -> Composer -> Agents -> Output next to an IT orchestra scene and wires that carry particles
// while work moves along them. Uses the page helpers $, el, postJSON, toast, showTab from index.html.
(() => {
  // main + the team's workers (from the live snapshot; 1-8 of them)
  let WORKERS = ['worker', 'worker2'];
  const agentsNow = () => ['main', ...WORKERS];
  const wnum = (w) => (w === 'worker' ? 1 : Number(w.replace('worker', '')) || 1);
  const colorVar = (id) => (id.startsWith('worker') ? `--f-w${wnum(id)}` : `--f-${id}`);
  const ICON = {
    you: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    main: '<path d="M9.5 3a3.5 3.5 0 0 0-3.4 4.3A3.5 3.5 0 0 0 4 13.6 3.5 3.5 0 0 0 8 20h1.5V3z"/><path d="M14.5 3a3.5 3.5 0 0 1 3.4 4.3 3.5 3.5 0 0 1 2.1 6.3A3.5 3.5 0 0 1 16 20h-1.5V3z"/><path d="M9.5 9H7.5M14.5 9h2M9.5 14H7M14.5 14H17"/>',
    worker: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    out: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  };
  const TOOLI = {
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    brain: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  };
  const TOOL = {
    team_brief: ['Reading the brief', 'list'], team_assign: ['Assigning work', 'send'], team_post: ['Posting to the board', 'chat'], team_done: ['Reporting done', 'check'],
    team_sleep: ['Going to rest', 'moon'], team_say: ['Talking to the team', 'chat'], team_read: ['Reading messages', 'chat'], team_pdf: ['Making a PDF', 'file'], team_cancel: ['Cancelling a task', 'x'],
    read: ['Reading files', 'file'], write: ['Writing a file', 'pen'], edit: ['Editing a file', 'pen'], apply_patch: ['Editing a file', 'pen'], exec: ['Running a command', 'term'], process: ['Managing a process', 'term'],
    web_search: ['Searching the web', 'globe'], web_fetch: ['Reading a web page', 'globe'], browser: ['Using the browser', 'globe'], image: ['Looking at an image', 'eye'],
    sessions_spawn: ['Starting a helper', 'gear'], sessions_send: ['Messaging a helper', 'chat'], memory_search: ['Searching memory', 'brain'], memory_get: ['Reading memory', 'brain'],
  };
  const NAMES = { you: ['You', 'jr'], main: ['Composer', 'main'], out: ['Output', 'work folder'] };
  const nameOf = (id) => NAMES[id] ? NAMES[id][0] : id.startsWith('worker') ? `Worker ${wnum(id)}` : id;
  const svg = (paths, cls) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''}>${paths}</svg>`;
  const toolInfo = (name) => TOOL[name] || [String(name || 'Working').replace(/_/g, ' '), 'gear'];
  const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; };
  const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const argText = (a) => { try { const j = JSON.parse(a); return j.to ? `→ ${j.to}: ${j.text || j.job || ''}` : j.job || j.text || j.path || j.file_path || j.command || j.query || j.url || j.id || ''; } catch { return a || ''; } };

  // Only rows that were not on screen before fade in (the cards re-render on every update).
  const seen = new Set(); let primed = false;
  const fresh = (node, key) => { if (primed && !seen.has(key)) node.classList.add('new'); seen.add(key); return node; };
  let snap = null, visible = false, es = null, pollTimer = null, connected = false, lastFiles = new Set(), firstFiles = true, board = [], files = [], workDir = 'work', sideTimer = null, fileEvents = [], tokens = null;
  const kfmt = (n) => { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n); };
  /** Token tiles: [[value, label, title], ...] in the card's stat style. */
  const tokenStats = (rows) => { const s = el('div', 'fn-stats'); for (const [v, l, tip] of rows) { const d = el('div', 'fn-stat'); d.title = tip; d.append(el('b', null, v), el('span', null, l)); s.append(d); } return s; };

  // ---------- skeleton (built once, then only text/classes change so animations do not restart) ----------
  function skeleton(id) {
    let n = $('fn-' + id);
    if (!n) { n = document.createElement('article'); n.className = 'fnode'; n.id = 'fn-' + id; n.dataset.node = id; $('fcolWorkers').append(n); }
    if (n.dataset.built) return n;
    n.dataset.built = '1'; n.style.setProperty('--c', `var(${colorVar(id)})`);
    n.innerHTML = `<div class="fn-head"><div class="fn-ico">${svg(ICON[id] || ICON.worker)}</div><div class="fn-title"><div class="fn-name"></div><div class="fn-state"></div></div><button type="button" class="fn-menu" title="Open">⋯</button></div>
      <div class="fn-step"><div class="fn-step-top"><span class="fs-l"></span><span class="fs-r"></span></div><div class="fn-bar"><i></i></div></div><div class="fn-body"></div><div class="fn-foot"><span class="ff-l"></span><span class="ff-r"></span></div>`;
    n.querySelector('.fn-name').textContent = nameOf(id) + (id === 'main' || id.startsWith('worker') ? ' agent' : '');
    n.querySelector('.fn-menu').onclick = () => showTab(id === 'out' ? 'files' : id === 'you' ? 'board' : 'live');
    return n;
  }
  function setStep(n, label, right, pct, running) {
    n.querySelector('.fs-l').textContent = label; n.querySelector('.fs-r').textContent = right || '';
    const bar = n.querySelector('.fn-bar'); bar.classList.toggle('run', !!running); bar.firstChild.style.width = (pct || 0) + '%';
  }

  // ---------- agent cards ----------
  function latestCard(agent) {
    const cs = (snap.cards || []).filter((c) => c.agent === agent);
    return cs.find((c) => c.live) || cs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  }
  function agentCard(id) {
    const n = skeleton(id); const a = (snap.agents || []).find((x) => x.agent === id) || {}; const c = latestCard(id);
    const live = !!(c && c.live) || !!a.running; const tl = (c && c.timeline) || [];
    const lastTool = [...tl].reverse().find((e) => e.kind === 'tool');
    n.classList.toggle('active', live); n.classList.toggle('off', id !== 'main' && snap.workersOn && !snap.workersOn.includes(id));
    n.querySelector('.fn-state').textContent = live ? (lastTool && lastTool.state === 'pending' ? 'Working' : tl.length && tl[tl.length - 1].kind === 'think' ? 'Thinking' : 'Active') : cap(a.state || 'idle');
    if (live) setStep(n, lastTool ? toolInfo(lastTool.tool)[0] : 'Starting up', c && c.startedAt ? ago(c.startedAt) : '', 0, true);
    else if (c && c.endedAt) setStep(n, c.phase === 'error' ? 'Run failed' : 'Finished', `${ago(c.endedAt)} ago · ${Math.round(((c.endedAt || 0) - (c.startedAt || 0)) / 1000)}s run`, 100, false);
    else setStep(n, id === 'main' ? 'Waiting for news' : 'Waiting for work', '', 0, false);

    const body = n.querySelector('.fn-body'); body.replaceChildren();
    // focus: the task in hand
    const task = id === 'main' ? (live ? short(c && c.task, 160) : (snap.tasks.length ? `${snap.tasks.length} task(s) in flight` : 'Nothing in flight')) : a.task ? `${a.task.id} · ${a.task.text}` : (snap.tasks.find((t) => t.assignee === id) ? `${snap.tasks.find((t) => t.assignee === id).id} · ${snap.tasks.find((t) => t.assignee === id).text}` : '');
    const focus = el('div', 'fn-box'); focus.append(el('div', 'fn-lbl', id === 'main' ? 'Focus' : 'Task'), el('div', 'fn-task', task || 'No task assigned'));
    if (id === 'main') {
      // the brain: its latest decisions as a checklist
      body.append(focus);
      const dec = el('div', 'fn-box'); dec.append(el('div', 'fn-lbl', 'Decisions'));
      const chk = el('div', 'fn-checks');
      for (const d of (snap.decisions || []).slice(0, 4)) {
        const m = /^\[([^\]]+)\]\s*(.*)$/.exec(d) || [, '', d]; const r = el('div', 'fn-check');
        r.append(el('i', null, '✓'), el('span', null, m[2]), el('em', null, String(m[1]).slice(11, 16))); r.title = m[2]; chk.append(r);
      }
      if (!chk.children.length) chk.append(el('div', 'fn-empty', 'No decisions yet.'));
      dec.append(chk); body.append(dec);
    } else {
      // a worker: the chain of tools it just used, in order, with a pulse travelling along it while it works
      const chain = el('div', 'fn-chain'); const used = tl.filter((e) => e.kind === 'tool').slice(-6);
      used.forEach((e, i) => {
        if (i) chain.append(el('span', 'fn-link'));
        const d = el('div', 'fn-tool' + (i === used.length - 1 && live ? ' now' : '') + (e.state === 'error' ? ' err' : '')); d.innerHTML = svg(TOOLI[toolInfo(e.tool)[1]]); d.title = `${e.tool}${e.state === 'error' ? ' (failed)' : ''}`; chain.append(d);
      });
      if (used.length) focus.append(chain);
      body.append(focus);
    }
    // (the step-by-step feed lives on the Agent details page)
    n.querySelector('.ff-l').textContent = '◆ ' + (a.model || (c && c.model) || '');
    n.querySelector('.ff-r').textContent = a.openTasks ? `${a.openTasks} open` : (a.lastRun ? `last ${a.lastRun.at}` : '');
    return { live, lastTool: lastTool && lastTool.tool, lastToolAt: lastTool ? Date.parse(lastTool.ts) : 0 };
  }
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

  // ---------- you ----------
  function youCard(mainLive) {
    const n = skeleton('you'); n.querySelector('.fn-state').textContent = 'Directing the team';
    const mine = board.filter((p) => p.from === 'jr'); const last = mine[mine.length - 1];
    const replies = last ? board.filter((p) => p.to === 'jr' && board.indexOf(p) > board.indexOf(last)) : [];
    const waiting = !!last && !replies.length && Date.now() - Date.parse(String(last.ts).replace(' ', 'T')) < 20 * 60000;
    n.classList.toggle('active', waiting);
    setStep(n, waiting ? 'Waiting for the composer' : last ? 'Answered' : 'Ask for anything', last ? String(last.ts).slice(11, 16) : '', waiting ? 50 : last ? 100 : 0, waiting && mainLive);
    const body = n.querySelector('.fn-body');
    if (!body.dataset.built) {
      body.dataset.built = '1';
      body.innerHTML = '<div class="fn-box"><div class="fn-lbl">Your last request</div><div class="fn-task" id="fyLast"></div></div><div class="fn-box"><div class="fn-lbl">Input · tokens the team read</div><div id="fyTok"></div></div><form class="fn-ask" id="fyForm"><textarea id="fyText" placeholder="Ask the team… (Ctrl+Enter)"></textarea><button type="submit" class="small">Send</button></form>';
      $('fyForm').onsubmit = async (e) => {
        e.preventDefault(); const text = $('fyText').value.trim(); if (!text) return;
        try { await postJSON('/api/post', { to: 'main', text }); $('fyText').value = ''; toast('Sent to the composer. It picks it up within a minute.'); loadSide(); } catch (err) { toast(err.message, true); }
      };
      $('fyText').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('fyForm').requestSubmit(); };
    }
    $('fyLast').textContent = last ? short(last.body, 220) : 'Nothing yet: type below to give the composer a goal.';
    // input side: prompt tokens sent to the models (instructions, briefs, files read, tool results)
    $('fyTok').replaceChildren(tokens ? tokenStats([[kfmt(tokens.today.input), 'in today', 'prompt tokens read by all agents since midnight'], [kfmt(tokens.hour.input), 'last hour', 'prompt tokens in the last hour'], [String(tokens.today.runs), 'runs today', 'agent runs since midnight']]) : el('div', 'fn-empty', 'Counting…'));
    n.querySelector('.ff-l').textContent = `${mine.length} request${mine.length === 1 ? '' : 's'} on the board`;
    n.querySelector('.ff-r').textContent = '';
  }

  // ---------- deliverables ----------
  function outCard(anyWorkerLive) {
    // every file the team makes counts (a new .md report is output too), newest first
    const n = skeleton('out'); const pdfs = files.filter((f) => !/(^|[\\/])\./.test(f.path));
    const fresh = pdfs.filter((f) => Date.now() - f.mtime < 10 * 60000).length;
    n.classList.toggle('active', fresh > 0 || anyWorkerLive);
    n.querySelector('.fn-state').textContent = fresh ? `${fresh} new in the last 10 min` : anyWorkerLive ? 'Expecting output' : 'Collected';
    setStep(n, anyWorkerLive ? 'Producing' : 'Ready', `${snap.doneToday} done today`, anyWorkerLive ? 0 : 100, anyWorkerLive);
    const body = n.querySelector('.fn-body'); body.replaceChildren();
    const stats = el('div', 'fn-stats');
    for (const [v, l] of [[snap.doneToday, 'done today'], [snap.tasks.length, 'in flight'], [pdfs.length, 'files']]) { const s = el('div', 'fn-stat'); s.append(el('b', null, String(v)), el('span', null, l)); stats.append(s); }
    body.append(stats);
    const box = el('div', 'fn-box'); box.append(el('div', 'fn-lbl', 'Latest'));
    const shelf = el('div', 'fn-files'); box.append(shelf);
    for (const f of pdfs.slice(0, 4)) {
      const a = el('a', 'fn-file' + (!firstFiles && !lastFiles.has(f.path) ? ' new' : '')); a.href = '/api/file?root=work&p=' + encodeURIComponent(f.path); a.target = '_blank'; a.rel = 'noopener';
      a.append(el('span', 'fi', (/\.(\w+)$/.exec(f.path) || [, 'file'])[1].toUpperCase().slice(0, 4)), el('span', 'fname', f.path.replace(/\.\w+$/, '')), el('span', 'fwhen', ago(f.mtime)));
      a.title = f.path; shelf.append(a);
    }
    if (!pdfs.length) box.append(el('div', 'fn-empty', 'Reports and files the team makes land here.'));
    body.append(box);
    // changes: every file the team added or removed in the work folder (removals included, newest first)
    const ch = el('div', 'fn-box'); ch.append(el('div', 'fn-lbl', 'Changes'));
    const list = el('div', 'fn-changes');
    for (const e of fileEvents.slice(0, 5)) {
      const r = el('div', 'fn-change ' + e.kind); r.title = `${e.kind === 'removed' ? 'Removed' : 'Added'} ${e.path}`;
      r.append(el('i', null, e.kind === 'removed' ? '−' : '+'), el('span', 'fname', e.path), el('span', 'fwhen', ago(e.at)));
      list.append(r);
    }
    ch.append(fileEvents.length ? list : el('div', 'fn-empty', 'Files added or removed show up here.'));
    body.append(ch);
    // output side: tokens the models generated
    if (tokens) { const tb = el('div', 'fn-box'); tb.append(el('div', 'fn-lbl', 'Output · tokens the team wrote'), tokenStats([[kfmt(tokens.today.output), 'out today', 'tokens generated by all agents since midnight'], [kfmt(tokens.hour.output), 'last hour', 'tokens generated in the last hour'], [String(tokens.today.tools), 'tool calls', 'tool calls since midnight']])); body.append(tb); }
    lastFiles = new Set(pdfs.map((f) => f.path)); firstFiles = false;
    n.querySelector('.ff-l').textContent = workDir; n.querySelector('.ff-r').textContent = '';
  }

  // ---------- wires ----------
  const wires = () => [['you', 'main', 'fwd'], ...WORKERS.flatMap((w) => [['main', w, 'fwd'], [w, 'out', 'fwd'], [w, 'main', 'back']])];
  const colorOf = (id) => getComputedStyle(document.documentElement).getPropertyValue(colorVar(id)).trim();
  /** A polyline with rounded corners (circuit-trace look). */
  function ortho(pts, r = 14) {
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1], [x, y] = pts[i], [x1, y1] = pts[i + 1];
      const d0 = Math.hypot(x - x0, y - y0) || 1, d1 = Math.hypot(x1 - x, y1 - y) || 1, rr = Math.min(r, d0 / 2, d1 / 2);
      d += ` L${x - ((x - x0) / d0) * rr},${y - ((y - y0) / d0) * rr} Q${x},${y} ${x + ((x1 - x) / d1) * rr},${y + ((y1 - y) / d1) * rr}`;
    }
    const [lx, ly] = pts[pts.length - 1]; return d + ` L${lx},${ly}`;
  }
  function drawWires(active, tierOn = []) {
    const host = $('flow'), s = $('flowWires'); const hr = host.getBoundingClientRect(); if (!hr.width) return;
    // Rebuild only when something visible changed, so the scene's animations do not restart on every snapshot.
    const cardKey = [...host.querySelectorAll('.fnode')].map((n) => { const r = n.getBoundingClientRect(); return Math.round(r.top) + ':' + Math.round(r.height); }).join(',');
    const key = [Math.round(hr.width), Math.round(hr.height), cardKey, JSON.stringify(active), tierOn.join(), WORKERS.join(), document.documentElement.dataset.theme || '', document.documentElement.dataset.look || '', (snap && snap.workersOn || []).join(), files.length, tokens ? [tokens.today.input, tokens.today.output, tokens.hour.input, tokens.hour.output, tokens.today.tools].map(kfmt).join() : ''].join('|');
    if (key === drawWires.key) return; drawWires.key = key;
    const NS = 'http://www.w3.org/2000/svg'; const mk = (t, a, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (p) p.append(e); return e; };
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    s.replaceChildren(); s.setAttribute('viewBox', `0 0 ${hr.width} ${hr.height}`);
    const defs = mk('defs', {}, s);
    const noMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const glow = mk('filter', { id: 'fglow', x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
    mk('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 2.2, result: 'b' }, glow);
    const fm = mk('feMerge', {}, glow); mk('feMergeNode', { in: 'b' }, fm); mk('feMergeNode', { in: 'SourceGraphic' }, fm);
    // SMIL helpers (skipped for reduced motion)
    const anim = (e, attr, values, dur, begin = '0s', extra = {}) => noMotion ? null : mk('animate', { attributeName: attr, values, dur, begin, repeatCount: 'indefinite', ...extra }, e);
    const turn = (e, type, values, dur, begin = '0s') => noMotion ? null : mk('animateTransform', { attributeName: 'transform', type, values, dur, begin, repeatCount: 'indefinite', additive: 'sum' }, e);
    const txt = (p, x, y, t, a) => { const e = mk('text', { x, y, ...a }, p); e.textContent = t; return e; };
    const limb = (p, d, c, w, col) => { mk('path', { d, fill: 'none', stroke: c, 'stroke-width': w + 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .55 }, p); mk('path', { d, fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, p); };
    const rnd = (n) => { const x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); };   // stable pseudo-random, so redraws look the same
    const M = css('--f-main'), YOU = css('--f-you'), OUT = css('--f-out'), INK = css('--f-ink'), BG = css('--f-bg'), MET = css('--f-metal'), MET2 = css('--f-metal2');

    const rel = (r) => ({ l: r.left - hr.left, r: r.right - hr.left, t: r.top - hr.top, b: r.bottom - hr.top, cx: r.left - hr.left + r.width / 2, cy: r.top - hr.top + r.height / 2, w: r.width, h: r.height });
    const P = rel($('pyrCol').getBoundingClientRect());
    const tiers = ['t1', 't2', 't3', 't4'].map((q) => rel(host.querySelector('.tier.' + q).getBoundingClientRect()));
    const side = P.l > tiers[0].r - 4;   // wide layout: cards left, scene right (else the scene sits above the cards)
    let ranges = side ? tiers.map((t) => [t.t, t.b]) : [0, 1, 2, 3].map((i) => [P.t + (P.h * i) / 4, P.t + (P.h * (i + 1)) / 4]);
    ranges = ranges.map(([a, b]) => [a + 4, b - 4]);
    const mid = (i) => (ranges[i][0] + ranges[i][1]) / 2, hgt = (i) => ranges[i][1] - ranges[i][0];
    const cx = P.cx, SW = P.w * .96;

    // ---- background: faint red code rain behind the scene ----
    const rainTop = Math.min(...ranges.map((r) => r[0])) - 4, rainH = Math.max(...ranges.map((r) => r[1])) - rainTop + 8;
    const cp = mk('clipPath', { id: 'rainClip' }, defs); mk('rect', { x: P.l, y: rainTop, width: P.w, height: rainH }, cp);
    const rain = mk('g', { class: 'sc-rain', 'clip-path': 'url(#rainClip)' }, s);
    const GLYPHS = '01ABCDEF0123456789<>/{}[]#$%=;:*+-';
    for (let i = 0, cols = Math.floor(P.w / 24); i < cols; i++) {
      if (rnd(i + 1) < .35) continue;
      const x = P.l + 10 + i * 24, n = Math.ceil(rainH / 15), col = mk('g', {}, rain);
      for (const off of [0, -n * 15]) {
        const t = mk('text', { x, y: rainTop + off }, col);
        for (let j = 0; j < n; j++) { const sp = mk('tspan', { x, dy: 15, 'fill-opacity': (.25 + .75 * rnd(i * 97 + j)).toFixed(2) }, t); sp.textContent = GLYPHS[Math.floor(rnd(i * 31 + j * 7) * GLYPHS.length)]; }
      }
      turn(col, 'translate', `0 0;0 ${n * 15}`, `${(9 + rnd(i * 5) * 10).toFixed(1)}s`, `-${(rnd(i * 13) * 8).toFixed(1)}s`);
    }
    const scene = mk('g', { class: 'orch' }, s);

    // ---- a wireframe brain (200 x 140 box): a folded mesh lit by heat-map patches that drift and flare while it works ----
    const BRAIN = ['M28,92 C16,84 12,70 16,58 C14,46 22,36 32,32 C36,22 48,16 58,18 C66,10 80,8 90,12 C100,6 114,6 124,12 C136,10 148,16 156,24 C166,26 176,36 178,46 C188,52 192,66 186,76 C190,86 184,96 172,98 C166,104 154,106 146,104 C138,110 126,112 116,108 C106,114 92,112 84,108 C72,112 58,108 52,102 C42,104 32,100 28,92 Z'];
    const GYRI = 'M30,48 C40,40 50,46 58,38 M62,26 C70,34 80,26 88,32 M98,20 C102,30 96,40 104,48 M130,22 C126,32 134,40 128,50 M146,30 C150,40 160,40 164,50 '
      + 'M24,66 C34,62 42,70 52,64 M58,52 C66,58 76,52 82,60 M84,40 C90,48 86,58 94,64 M136,60 C146,56 152,64 162,60 M168,66 C172,74 178,76 180,84 '
      + 'M40,90 C50,84 60,92 70,88 M92,92 C100,86 110,92 118,88 M150,80 C156,88 164,86 170,92';
    function brain(parent, id, X, Y, k, cols, live, step, seed) {
      const g = mk('g', { class: 'sc-brain' + (live ? ' on' : ''), transform: `translate(${X},${Y}) scale(${k})` }, parent);
      const clip = mk('clipPath', { id: id + '-c' }, defs); BRAIN.forEach((d) => mk('path', { d }, clip));
      // the mesh: folded contour lines across the shape, ribs down it, the outline and the two big fissures
      const mask = mk('mask', { id: id + '-m', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 200, height: 140 }, defs);
      const ml = mk('g', { 'clip-path': `url(#${id}-c)`, stroke: '#fff', fill: 'none', 'stroke-width': .7 }, mask);
      for (let y = 4; y < 138; y += step) { let d = ''; for (let x = 10; x <= 194; x += 4) d += `${x === 10 ? 'M' : 'L'}${x},${(y + 2.4 * Math.sin(x * .09 + y * .31) + 1.5 * Math.sin(x * .21 - y * .13)).toFixed(1)} `; mk('path', { d }, ml); }
      for (let x = 12; x < 194; x += step * 2.2) { let d = ''; for (let y = 4; y <= 138; y += 4) d += `${y === 4 ? 'M' : 'L'}${(x + 2 * Math.sin(y * .12 + x * .2)).toFixed(1)},${y} `; mk('path', { d, 'stroke-opacity': .5 }, ml); }
      BRAIN.forEach((d) => mk('path', { d, stroke: '#fff', 'stroke-width': 1.3, fill: 'none' }, mask));
      mk('path', { d: 'M114,10 C106,40 118,62 106,108 M36,80 C68,70 100,74 132,98', stroke: '#fff', 'stroke-width': 1.6, fill: 'none' }, mask);
      mk('path', { d: GYRI, stroke: '#fff', 'stroke-width': 1.1, 'stroke-opacity': .75, fill: 'none', 'stroke-linecap': 'round', 'clip-path': `url(#${id}-c)` }, mask);
      // the heat: a dim wash in the brain's colour, bright patches, and (while working) a sweeping band and sparks
      const hot = mk('radialGradient', { id: id + '-hot' }, defs);
      [[0, '#fff4e6', 1], [.35, cols.hot, .95], [1, cols.hot, 0]].forEach(([o, c, a]) => mk('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, hot));
      for (const [n, c] of [['mid', cols.mid], ['alt', cols.alt]]) { const r = mk('radialGradient', { id: `${id}-${n}` }, defs); mk('stop', { offset: 0, 'stop-color': c, 'stop-opacity': 1 }, r); mk('stop', { offset: 1, 'stop-color': c, 'stop-opacity': 0 }, r); }
      const heat = mk('g', { id: id + '-h' }, defs);
      mk('rect', { x: 0, y: 0, width: 200, height: 140, fill: cols.mid, opacity: live ? .55 : .26 }, heat);
      const blobs = live ? 8 : 6;
      for (let b = 0; b < blobs; b++) {
        const r0 = 16 + rnd(seed + b * 3) * 26, x0 = 34 + rnd(seed + b * 7) * 140, y0 = 20 + rnd(seed + b * 11) * 90;
        const e = mk('circle', { cx: x0, cy: y0, r: r0, fill: `url(#${id}-${['hot', 'mid', 'alt'][b % 3]})` }, heat);
        if (live) {
          const x1 = 34 + rnd(seed + b * 13) * 140, y1 = 20 + rnd(seed + b * 17) * 90, dur = `${(2.4 + rnd(seed + b) * 2.6).toFixed(1)}s`;
          anim(e, 'cx', `${x0};${x1};${x0}`, dur); anim(e, 'cy', `${y0};${y1};${y0}`, dur); anim(e, 'r', `${r0};${r0 * 1.45};${r0 * .8};${r0}`, `${(1.3 + rnd(seed + b * 5)).toFixed(1)}s`);
        } else { e.setAttribute('opacity', .6); anim(e, 'opacity', '.35;.7;.35', `${(5 + rnd(seed + b) * 3).toFixed(1)}s`); }
      }
      if (live) {
        const sg = mk('linearGradient', { id: id + '-sw' }, defs);
        [[0, 0], [.5, .9], [1, 0]].forEach(([o, a]) => mk('stop', { offset: o, 'stop-color': cols.hot, 'stop-opacity': a }, sg));
        const band = mk('rect', { x: -50, y: 0, width: 46, height: 140, fill: `url(#${id}-sw)` }, heat); anim(band, 'x', '-50;200', '2.2s');
        for (let j = 0; j < 6; j++) { const sp = mk('circle', { cx: 40 + rnd(seed + j * 19) * 130, cy: 24 + rnd(seed + j * 23) * 80, r: 7, fill: `url(#${id}-hot)`, opacity: 0 }, heat); anim(sp, 'opacity', '0;1;0;0', `${(.9 + rnd(seed + j) * .9).toFixed(2)}s`, `${(rnd(seed + j * 29) * 1.5).toFixed(2)}s`); }
      }
      mk('use', { href: `#${id}-h`, 'clip-path': `url(#${id}-c)`, opacity: .2 }, g);   // translucent patches between the lines
      mk('use', { href: `#${id}-h`, mask: `url(#${id}-m)`, class: 'sc-brain-lit' }, g);   // the lit mesh
      return g;
    }
    const BRAIN_MAIN = { mid: M, hot: '#ff9a5c', alt: '#ff4f8b' };

    // ---- 8-bit look: pixel sprites drawn into the same boxes as the smooth figures (wires and labels line up) ----
    const PIX = document.documentElement.dataset.look === '8bit';
    /** Draw a sprite from rows of characters, one rect per run of the same character. pal: char -> { fill, anim }
     *  where anim is 'blink' | 'spark' | 'flicker' (only animated while `live`, except blink). */
    function sprite(parent, rows, x0, y0, px, pal, live, seed = 1) {
      const g = mk('g', { 'shape-rendering': 'crispEdges' }, parent);
      rows.forEach((row, ry) => {
        for (let cx0 = 0; cx0 < row.length;) {
          const ch = row[cx0]; let n = 1; while (row[cx0 + n] === ch) n++;
          const p = pal[ch];
          if (p) {
            const r = mk('rect', { x: (x0 + cx0 * px).toFixed(2), y: (y0 + ry * px).toFixed(2), width: (n * px + .3).toFixed(2), height: (px + .3).toFixed(2), fill: p.fill, opacity: p.opacity ?? 1 }, g);
            if (p.anim === 'blink') anim(r, 'opacity', '1;1;1;0;1', `${(3.5 + rnd(seed) * 2).toFixed(1)}s`);
            else if (p.anim && live) anim(r, 'opacity', p.anim === 'spark' ? '.15;1;.15' : '1;.3;1;.6;1', `${(.5 + rnd(seed + ry * 7 + cx0) * .9).toFixed(2)}s`, `${(rnd(seed + cx0 * 3 + ry) * .8).toFixed(2)}s`);
            else if (p.anim === 'spark') r.setAttribute('opacity', .35);
          }
          cx0 += n;
        }
      });
      return g;
    }
    const SPR_YOU = ['....oooooo....', '..oohhhhhhoo..', '.ohhhhhhhhhho.', '.ohhffffffhho.', 'ohhffffffffhho', 'ohffeeffeeffho', 'ohffeeffeeffho', 'ohffffffffffho',
      'ohfffffmmfffho', 'ohhffffffffhho', '.ohhffffffhho.', '.ohhhhhhhhhho.', '..oohhhhhhoo..', '...oohhhhoo...', '....oooooo....'];
    const SPR_BRAIN = ['.....oooooooooo.....', '...oobbbbbbbbbboo...', '..obbllbbbobbllbbo..', '.obbbblbbbobblbbbbo.', 'obbllbbbsbobbbsbllbo', 'obbbbllbbbobbllbbbbo',
      'oblbbbbsbbobbbbbblbo', 'obbbllbbbbobbbllbbbo', '.obbbbbllbobllbbbbo.', '..obbsbbbbobbbbsbbo.', '...oobbbbbobbbbboo..', '.....ooooooooooo....', '........oooo........'];
    const SPR_PC = ['oooooooooooooooo', 'okkkkkkkkkkkkkko', 'okkeekkkkkkeekko', 'okkeekkkkkkeekko', 'okkkkkkkkkkkkkko', 'okkkgggggggkkkko', 'okkkkkkkkkkkkkko',
      'oooooooooooooooo', '......oooo......', '....oooooooo....'];
    const SPR_PYR = ['......oooooo......', '......oddldo......', '......oooooo......', '....oooooooooo....', '....oddddddldo....', '....oooooooooo....',
      '..oooooooooooooo..', '..oddddddddlddlo..', '..oooooooooooooo..'];

    // ---- tier 0: you - a floating hooded face (70 x 92 box) ----
    const k0 = Math.min(hgt(0) * .9 / 92, SW * .3 / 70), ox = cx - 35 * k0, oy = mid(0) - 46 * k0;
    const O = (x, y) => [ox + x * k0, oy + y * k0];
    const op = mk('g', { class: 'sc-you' + (tierOn[0] ? ' on' : ''), transform: `translate(${ox},${oy}) scale(${k0})` }, scene);
    mk('ellipse', { cx: 35, cy: 84, rx: 20, ry: 3, fill: YOU, opacity: .18, filter: 'url(#fglow)' }, op);
    const face = mk('g', {}, op); turn(face, 'translate', PIX ? '0 0;0 -5;0 0' : '0 0;0 -3;0 0', PIX ? '2s' : '4.5s');
    if (PIX) sprite(face, SPR_YOU, 0, 2, 5, { o: { fill: YOU }, h: { fill: MET2 }, f: { fill: BG }, e: { fill: YOU, anim: 'blink' }, m: { fill: YOU, opacity: .5 } }, !!tierOn[0], 3);
    else {
      mk('path', { d: 'M35,4 C13,4 5,26 8,50 C10,64 20,74 35,76 C50,74 60,64 62,50 C65,26 57,4 35,4 Z', fill: MET2, stroke: YOU, 'stroke-width': 1.3, class: 'sc-glow' }, face);
      mk('path', { d: 'M35,13 C21,13 17,29 19,44 C21,58 49,58 51,44 C53,29 49,13 35,13 Z', fill: BG }, face);
      mk('path', { d: 'M22,20 C26,15 31,13 35,13', fill: 'none', stroke: YOU, 'stroke-width': .7, opacity: .5 }, face);
      for (const x of [25.5, 38.5]) { const e = mk('rect', { x, y: 34, width: 6, height: 2.6, rx: 1.2, fill: YOU, filter: 'url(#fglow)' }, face); anim(e, 'opacity', '1;1;.1;1', '4s', `${x / 100}s`); }
    }
    txt(op, 35, 92, 'you', { fill: YOU, 'font-size': 8, 'text-anchor': 'middle', 'font-weight': 700, 'letter-spacing': 2 });
    // input side, beside you: tokens the team read today and in the last hour
    if (tokens) {
      const tx = ox + 76 * k0, ty = oy + 34 * k0;
      txt(scene, tx, ty, `> ${kfmt(tokens.today.input)} tokens in today`, { fill: YOU, 'font-size': 9, 'font-weight': 700 });
      txt(scene, tx, ty + 13, `> ${kfmt(tokens.hour.input)} last hour · ${tokens.today.runs} runs`, { fill: YOU, 'font-size': 9, opacity: .75 });
    }
    const youBottom = O(35, 80), youSide = O(8, 46);

    // ---- tier 1: the composer - a big wireframe brain, floating, its heat moving while it thinks ----
    const k1 = Math.min((hgt(1) - 6) / 132, SW * .62 / 200), bx = cx - 100 * k1, by = ranges[1][0] + Math.max(0, hgt(1) - 132 * k1) / 2 - 4 * k1;
    const C = (x, y) => [bx + x * k1, by + y * k1];
    const cond = mk('g', { class: 'sc-cond' + (tierOn[1] ? ' on' : '') }, scene);
    mk('ellipse', { cx: cx, cy: by + 120 * k1, rx: 70 * k1, ry: 4 * k1, fill: M, opacity: .2, filter: 'url(#fglow)' }, cond);
    const cfloat = mk('g', {}, cond); turn(cfloat, 'translate', `0 0;0 ${-3 * k1};0 0`, '6s');
    if (PIX) sprite(cfloat, SPR_BRAIN, bx, by, 10 * k1, { o: { fill: M }, b: { fill: MET2 }, l: { fill: M, opacity: .55 }, s: { fill: '#ff9a5c', anim: 'spark' } }, !!tierOn[1], 7);
    else brain(cfloat, 'bmain', bx, by, k1, BRAIN_MAIN, !!tierOn[1], 2.6, 7);
    txt(cond, cx, by + 132 * k1, 'composer', { fill: M, 'font-size': 9, 'font-weight': 700, 'text-anchor': 'middle', 'letter-spacing': 3 });
    if (tierOn[1]) for (let j = 0; j < 4; j++) { const b = txt(cond, cx + (j - 1.5) * 30 * k1, by + 6 * k1, ['01', '1F', '<>', '10'][j], { fill: M, 'font-size': 8, opacity: 0, 'text-anchor': 'middle' }); anim(b, 'y', `${by + 8 * k1};${by - 14 * k1}`, '2s', `${j * .5}s`); anim(b, 'opacity', '0;1;0', '2s', `${j * .5}s`); }
    const baton = C(110, 112), condHead = C(112, 10), condHand = C(24, 82), condSide = C(18, 70);

    // ---- tier 2: the agents - one smaller brain per worker, in an arc; it lights up and shifts while that agent works ----
    const N = WORKERS.length, slot = SW / Math.max(N, 1);
    const k2 = Math.min(hgt(2) * .84 / 134, slot * .9 / 200, .85), depth = Math.max(0, hgt(2) - 134 * k2);
    const seats = {};
    WORKERS.forEach((w, i) => {
      const u = N > 1 ? (i / (N - 1)) * 2 - 1 : 0;
      const X = cx + u * (SW / 2 - slot / 2) - 100 * k2, Y = ranges[2][0] + depth * (.1 + .8 * (1 - u * u));
      const c = css(colorVar(w)), live = !!active[`${w}Live`], off = !!(snap && snap.workersOn && !snap.workersOn.includes(w));
      const at = (x, y) => [X + x * k2, Y + y * k2];
      seats[w] = { head: at(112, 10), side: at(18, 70), foot: at(100, 113), ear: at(176, 44) };
      const g = mk('g', { class: 'sc-agent' + (live ? ' on' : '') + (off ? ' off' : '') }, scene);
      mk('ellipse', { cx: X + 100 * k2, cy: Y + 120 * k2, rx: 60 * k2, ry: 3.5 * k2, fill: c, opacity: .18, filter: 'url(#fglow)' }, g);
      const fl = mk('g', {}, g); turn(fl, 'translate', `0 0;0 ${-3 * k2};0 0`, `${(4 + i * .7).toFixed(1)}s`);
      if (PIX) sprite(fl, SPR_PC, X + 20 * k2, Y + 8 * k2, 10 * k2, { o: { fill: c }, k: { fill: BG }, e: { fill: c, anim: 'blink' }, g: { fill: c, anim: 'flicker', opacity: live ? 1 : .4 } }, live, 31 + i * 17);
      else brain(fl, 'b' + w, X, Y, k2, { mid: c, hot: '#ffd0b8', alt: M }, live, 3.6, 31 + i * 17);
      if (live) for (let j = 0; j < 3; j++) {
        const bit = txt(g, X + (150 + j * 12) * k2, Y + 20 * k2, ['1', '0', '{}'][j], { fill: c, 'font-size': 8, opacity: 0, class: 'sc-bit' });
        anim(bit, 'y', `${Y + 20 * k2};${Y - 10 * k2}`, '1.9s', `${j * .6}s`); anim(bit, 'opacity', '0;1;0', '1.9s', `${j * .6}s`);
      }
      txt(g, X + 100 * k2, Y + 120 * k2 + 12, nameOf(w).toLowerCase().replace(' ', '-'), { fill: c, 'font-size': 9, 'font-weight': 700, 'text-anchor': 'middle' });
    });

    // ---- tier 3: the output - a database built as a pyramid: three discs, widest at the bottom, narrowest on top.
    // The numbers live in the Output card on the left; here the discs glow and records drop in while files arrive.
    const dk = Math.min(hgt(3) * .85 / 64, SW * .3 / 90, 1.6), dy = ranges[3][0] + Math.max(0, hgt(3) - 64 * dk) / 2;
    const db = mk('g', { class: 'sc-db' + (tierOn[3] ? ' on' : '') }, scene);
    mk('ellipse', { cx, cy: dy + 62 * dk, rx: 50 * dk, ry: 3.5 * dk, fill: OUT, opacity: .18, filter: 'url(#fglow)' }, db);
    const discs = [[90, 40], [64, 22], [38, 4]];   // [width, top y] bottom to top, in 64-unit box
    if (PIX) sprite(db, SPR_PYR, cx - 45 * dk, dy + 10 * dk, 5 * dk, { o: { fill: OUT }, d: { fill: MET2 }, l: { fill: M, anim: 'spark' } }, !!tierOn[3], 11);
    else discs.forEach(([w0, t0], d) => {
      const w = w0 * dk, x = cx - w / 2, top = dy + (t0 + 6) * dk, h = 14 * dk, ery = Math.max(2.5, w0 * .09) * dk;
      mk('path', { d: `M${x},${top} v${h} a${w / 2},${ery} 0 0 0 ${w},0 v${-h}`, fill: MET2, stroke: OUT, 'stroke-width': 1.1, class: d === 2 ? 'sc-glow' : '' }, db);
      mk('ellipse', { cx, cy: top, rx: w / 2, ry: ery, fill: d === 2 ? MET : MET2, stroke: OUT, 'stroke-width': 1.1 }, db);
      for (let j = 0; j < (d === 0 ? 3 : d === 1 ? 2 : 1); j++) {   // status lights along each disc
        const led = mk('circle', { cx: x + w - (8 + j * 7) * dk, cy: top + h * .7 + ery * .4, r: 1.5 * dk, fill: j % 2 ? M : OUT, opacity: tierOn[3] ? 1 : .35, filter: tierOn[3] ? 'url(#fglow)' : '' }, db);
        if (tierOn[3]) anim(led, 'opacity', '1;.15;1', `${(.45 + d * .3 + j * .2).toFixed(2)}s`);
      }
    });
    const peak = dy + (discs[2][1] + 6) * dk - 4 * dk;
    if (tierOn[3]) for (let j = 0; j < 2; j++) {   // records dropping onto the peak
      const r = mk('rect', { x: cx - 6 * dk, y: peak - 16 * dk, width: 12 * dk, height: 3 * dk, rx: 1.5 * dk, fill: OUT, opacity: 0 }, db);
      anim(r, 'y', `${peak - 16 * dk};${peak}`, '1.6s', `${j * .8}s`); anim(r, 'opacity', '0;1;0', '1.6s', `${j * .8}s`);
    }
    txt(db, cx, dy + 64 * dk + 12, 'output', { fill: OUT, 'font-size': 9, 'font-weight': 700, 'text-anchor': 'middle', 'letter-spacing': 3 });
    const dbTop = [cx, peak], dbSide = [cx - 45 * dk, dy + 53 * dk];
    // output side, beside the pyramid: tokens the team wrote today, in the last hour, and tool calls
    if (tokens) {
      const tx = cx + 52 * dk, ty = dy + 30 * dk;
      txt(scene, tx, ty, `> ${kfmt(tokens.today.output)} tokens out today`, { fill: OUT, 'font-size': 9, 'font-weight': 700 });
      txt(scene, tx, ty + 13, `> ${kfmt(tokens.hour.output)} last hour · ${tokens.today.tools} tool calls`, { fill: OUT, 'font-size': 9, opacity: .75 });
    }

    // ---- traffic: leader lines card -> its place; you -> composer; composer -> each agent; agents -> the rack ----
    const lines = [];
    const anchor = (id) => id === 'you' ? youSide : id === 'main' ? condSide : id === 'out' ? dbSide : seats[id] ? seats[id].side : null;
    if (side) {
      for (const id of ['you', 'main', ...WORKERS, 'out']) {
        const el2 = $('fn-' + id), T = anchor(id); if (!el2 || !T) continue; const A = rel(el2.getBoundingClientRect());
        const k = id.startsWith('worker') ? WORKERS.indexOf(id) : 0;
        const mx = A.r + Math.max(16, (T[0] - A.r) * .3) + (k % 4) * 6;
        const on = id === 'you' ? active['you>main'] : id === 'main' ? active.mainLive : id === 'out' ? WORKERS.some((w) => active[`${w}>out`]) : active[`${id}Live`];
        lines.push({ d: ortho([[A.r, A.cy], [mx, A.cy], [mx, T[1]], T], 10), from: colorVar(id), to: id === 'out' ? '--f-out' : colorVar(id), on, back: id === 'out' });
      }
    }
    const curve = (a, b, bend = 0) => `M${a[0]},${a[1]} Q${(a[0] + b[0]) / 2 + bend},${Math.min(a[1], b[1]) - Math.abs(b[0] - a[0]) * .08} ${b[0]},${b[1]}`;
    lines.push({ d: `M${youBottom[0]},${youBottom[1]} L${condHead[0]},${condHead[1]}`, from: '--f-you', to: '--f-main', on: active['you>main'], spine: true });
    // One wire per pair: work goes down the composer -> agent wire, reports come back up the SAME wire (reverse
    // comets), so the traffic always rides the line that is drawn.
    const condBottom = C(112, 116);
    for (const w of WORKERS) {
      const st = seats[w]; if (!st) continue;
      const down = !!active[`main>${w}`], up = !!active[`${w}>main`];
      lines.push({ d: curve(condBottom, st.head), from: '--f-main', to: colorVar(w), on: down || up, fwd: down, rev: up, spine: true });
      // files flow down from each agent to the peak of the output pyramid
      lines.push({ d: `M${st.foot[0]},${st.foot[1]} Q${(st.foot[0] + dbTop[0]) / 2},${dbTop[1]} ${dbTop[0]},${dbTop[1]}`, from: colorVar(w), to: '--f-out', on: active[`${w}>out`], spine: true });
    }

    lines.forEach((ln, n) => {
      const gid = 'wg' + n; const p0 = mk('path', { d: ln.d }, defs); const len = p0.getTotalLength(); const a0 = p0.getPointAtLength(0), a1 = p0.getPointAtLength(len); p0.remove();
      const g = mk('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: a0.x, y1: a0.y, x2: a1.x, y2: a1.y }, defs);
      mk('stop', { offset: 0, 'stop-color': css(ln.from) }, g); mk('stop', { offset: 1, 'stop-color': css(ln.to) }, g);
      mk('path', { d: ln.d, class: 'wire-glow' + (ln.on ? ' on' : ''), stroke: `url(#${gid})` }, s);
      mk('path', { d: ln.d, class: 'wire' + (ln.back ? ' back' : '') + (ln.spine ? ' spine' : '') + (ln.on ? ' on' : ''), stroke: `url(#${gid})`, 'stroke-width': ln.spine ? 2.2 : 1.6 }, s);
      if (!ln.spine) for (const [pt, c] of [[a0, ln.from], [a1, ln.to]]) mk('circle', { cx: pt.x, cy: pt.y, r: 2.6, fill: css(c), class: 'wire-node' }, s);
      if (ln.on && !noMotion) {
        const dur = Math.max(1.1, Math.min(3.4, len / 170));
        // direction(s) on this wire: forward along the path, or back along the same path (reports to the composer)
        const dirs = ln.fwd === undefined && ln.rev === undefined ? [false] : [...(ln.fwd ? [false] : []), ...(ln.rev ? [true] : [])];
        for (const back of dirs) for (let i = 0; i < 3; i++) for (let j = 0; j < 5; j++) {
          const head = back ? ln.to : ln.from, tail = back ? ln.from : ln.to;
          const c = mk('circle', { r: 3.3 - j * .55, fill: css(j < 2 ? head : tail), opacity: 1 - j * .19, class: 'wire-dot on', style: j ? '' : `filter: drop-shadow(0 0 5px ${css(head)})` }, s);
          mk('animateMotion', { dur: dur + 's', repeatCount: 'indefinite', begin: `${(i * dur) / 3 + j * .045}s`, path: ln.d, ...(back ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {}) }, c);
        }
      }
    });
  }

  // ---------- strip + lower panels ----------
  function strip(anyLive) {
    const g = snap.gpu; const working = (snap.agents || []).filter((a) => a.running).length;
    const pills = [];
    const p = (cls, html) => { const d = el('div', 'fpill ' + cls); d.innerHTML = html; pills.push(d); return d; };
    p(connected ? 'live' : 'off', `<span class="beacon"></span>${connected ? 'Live' : 'Reconnecting…'}`);
    if (snap.paused) p('paused', '⏸ <b>Paused</b> — no new runs');
    p('', `Agents working <b>${working}/3</b>`);
    p('', `In flight <b>${snap.tasks.length}</b>`);
    p('', `Done today <b>${snap.doneToday}</b>`);
    if (g) { const pct = Math.round(100 * g.used / g.total); p('', `GPU <b>${g.util}%</b> · <b>${(g.used / 1024).toFixed(1)}</b>/${(g.total / 1024).toFixed(0)} GB <span class="mini"><i style="width:${pct}%"></i></span> <b>${g.temp}°C</b>`); }
    p('', `Gateway <b style="color:var(--${snap.gateway ? 'ok' : 'bad'})">${snap.gateway ? 'up' : 'down'}</b>`);
    $('flowStrip').replaceChildren(...pills);
    $('flowNavDot').className = 'live-dot' + (anyLive ? ' on' : '');
  }
  function lower() {
    const lanes = [...WORKERS.map((w) => [w, nameOf(w)]), ['', 'Unassigned']];
    $('pipe').style.gridTemplateColumns = `repeat(${Math.min(lanes.length, 4)}, minmax(0, 1fr))`;
    $('pipe').replaceChildren(...lanes.map(([who, label]) => {
      const lane = el('div', 'lane'); const h = el('h3'); const dot = el('i'); dot.style.background = who ? `var(${colorVar(who)})` : 'var(--muted)'; h.append(dot, document.createTextNode(label));
      const ts = snap.tasks.filter((t) => (t.assignee || '') === who || !who && !WORKERS.includes(t.assignee));
      h.append(el('span', 'sub', ` · ${ts.length}`)); lane.append(h);
      for (const t of ts) { const c = el('div', 'tchip ' + t.status); c.style.setProperty('--lc', who ? `var(${colorVar(who)})` : 'var(--muted)'); c.append(el('span', 'tid', t.id), document.createTextNode(short(t.text, 140))); c.title = t.text; lane.append(fresh(c, 'task' + t.id + t.status + t.text)); }
      if (!ts.length) lane.append(el('div', 'sub', 'empty'));
      return lane;
    }));
    // merged live activity: every agent's recent events, newest first
    const evs = [];
    for (const c of snap.cards || []) for (const e of (c.timeline || []).slice(-12)) evs.push({ ...e, agent: c.agent, at: Date.parse(e.ts) || c.startedAt || 0 });
    evs.sort((a, b) => b.at - a.at);
    $('actStream').replaceChildren(...(evs.length ? evs.slice(0, 40).map((e) => {
      const r = el('div', 'ase ' + e.kind + (e.state === 'error' ? ' err' : '')); r.style.setProperty('--c', `var(${colorVar(e.agent)})`);
      const x = el('span', 'x');
      if (e.kind === 'tool') x.append(el('span', 'tn', e.tool), document.createTextNode(' ' + short(argText(e.args), 140) + (e.state === 'error' ? ' — failed' : '')));
      else x.textContent = (e.kind === 'think' ? '… ' : '') + short(e.text, 200);
      r.append(el('span', 't', new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), el('span', 'who', nameOf(e.agent)), x);
      r.title = e.kind === 'tool' ? `${e.tool} ${e.args || ''}` : e.text || '';
      return fresh(r, 'act' + e.agent + e.at + (e.tool || '') + (e.state || ''));
    }) : [el('div', 'sub', 'Quiet: nothing has run in the last half hour.')]));
    $('pipeSub').textContent = `${snap.tasks.length} open · ${snap.doneToday} done today`;
    $('fdecisions').replaceChildren(...(snap.decisions || []).map((d) => { const m = /^\[([^\]]+)\]\s*(.*)$/.exec(d) || [, '', d]; const r = el('div'); r.append(el('span', 't', String(m[1]).slice(11, 16)), el('span', null, m[2])); return fresh(r, 'dec' + d); }));
  }

  // ---------- render ----------
  function render() {
    if (!snap) return;
    const names = (snap.agents || []).map((a) => a.agent).filter((a) => /^worker\d*$/.test(a));
    if (names.length && names.join() !== WORKERS.join()) {
      WORKERS = names;
      for (const el of [...document.querySelectorAll('#fcolWorkers .fnode')]) if (!WORKERS.includes(el.dataset.node)) el.remove();
    }
    $('fcolWorkers').classList.toggle('many', WORKERS.length > 2); $('flow').classList.toggle('many', WORKERS.length > 2);
    const st = {}; for (const id of agentsNow()) st[id] = agentCard(id);
    const anyWorkerLive = WORKERS.some((w) => st[w].live);
    youCard(st.main.live); outCard(anyWorkerLive);
    const recent = (s, tools, ms = 120000) => s.lastTool && tools.includes(s.lastTool) && Date.now() - s.lastToolAt < ms;
    const active = { 'you>main': st.main.live };
    for (const w of WORKERS) {
      active[`main>${w}`] = st[w].live || st.main.live && recent(st.main, ['team_assign']);
      active[`${w}>out`] = st[w].live && recent(st[w], ['write', 'edit', 'team_pdf', 'exec', 'apply_patch'], 300000);
      active[`${w}>main`] = recent(st[w], ['team_done', 'team_post', 'team_say'], 90000);
    }
    active.mainLive = st.main.live; for (const w of WORKERS) active[`${w}Live`] = st[w].live;
    const tiers = [active['you>main'] || $('fn-you').classList.contains('active'), st.main.live, anyWorkerLive, $('fn-out').classList.contains('active')];
    render.tiers = tiers;
    strip(st.main.live || anyWorkerLive); lower();
    requestAnimationFrame(() => drawWires(active, render.tiers)); render.active = active; primed = true;
    if (seen.size > 3000) seen.clear();
  }

  // ---------- data ----------
  async function loadSide() {
    const [b, w, s, t] = await Promise.all(['/api/board', '/api/work', '/api/settings', '/api/flowstats'].map((u) => fetch(u).then((r) => r.json()).catch(() => null)));
    if (b && b.posts) board = b.posts; if (w && w.files) { files = w.files; workDir = w.dir || workDir; fileEvents = w.events || []; } if (s && s.workers && snap) snap.workersOn = s.workers;
    if (t && t.today) tokens = t;
    render();
  }
  function connect() {
    if (es) return;
    try {
      es = new EventSource('/api/stream');
      es.addEventListener('snapshot', (e) => { connected = true; const ws = snap && snap.workersOn; snap = JSON.parse(e.data); snap.workersOn = ws;
        if (visible) render(); else { try { lower(); } catch {} } if (!visible) $('flowNavDot').className = 'live-dot' + ((snap.cards || []).some((c) => c.live) ? ' on' : ''); });
      es.onopen = () => { connected = true; };
      es.onerror = () => { connected = false; if (visible && snap) strip(false); };
    } catch { es = null; }
    if (!pollTimer) pollTimer = setInterval(() => { if (!connected && visible) poll(); }, 4000);   // fallback when the stream is down
  }
  async function poll() {
    const [ag, live, tk, run] = await Promise.all(['/api/agents', '/api/live', '/api/tasks', '/api/running'].map((u) => fetch(u).then((r) => r.json()).catch(() => null)));
    if (!ag) return;
    const t = (tk && tk.tasks) || [];
    snap = { ...(snap || {}), agents: ag.agents || [], cards: (live && live.cards) || [], decisions: ((live && live.decisions) || []).slice(0, 12),
      tasks: t.filter((x) => ['open', 'stuck'].includes(x.status)), doneToday: t.filter((x) => x.status === 'done' && new Date(x.updated).toDateString() === new Date().toDateString()).length,
      paused: !!(tk && tk.paused), gpu: run && run.gpu, gateway: !!(run && run.gateway) };
    render();
  }
  window.flowShow = (on) => {
    visible = on; clearInterval(sideTimer); sideTimer = null;
    if (!on) return;
    connect(); loadSide(); if (!snap) poll(); else render();
    sideTimer = setInterval(loadSide, 10000);
  };
  // Keep wires attached to the cards when the layout changes; tick elapsed timers every second.
  new ResizeObserver(() => { if (visible && render.active) drawWires(render.active, render.tiers); }).observe($('flow'));
  setInterval(() => { if (visible && snap) for (const id of agentsNow()) { const c = latestCard(id); if (c && c.live && c.startedAt) { const r = $('fn-' + id).querySelector('.fs-r'); if (r) r.textContent = ago(c.startedAt); } } }, 1000);
  document.addEventListener('visibilitychange', () => { if (document.hidden && es) { es.close(); es = null; connected = false; } else if (!document.hidden && visible) connect(); });
  connect();   // the nav dot shows activity on every page
  if ($('tab-flow').classList.contains('on')) window.flowShow(true);
})();
