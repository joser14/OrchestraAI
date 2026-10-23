// Agent details: pick an agent (or a run) and watch exactly what it does - every thought, message, tool call with
// its full arguments and result - following the live run as it happens. Data: /api/details (untruncated runs of
// the last day), refreshed every 2 s while the page is open. Uses $, el, showTab from index.html.
(() => {
  let visible = false, timer = null, data = null, agent = null, runKey = null, lastSig = '';
  const pick = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
  agent = pick('detAgent') || 'main';
  const colorOf = (a) => (a === 'main' ? 'var(--f-main)' : a.startsWith('worker') ? `var(--f-w${a === 'worker' ? 1 : a.replace('worker', '')})` : 'var(--muted)');
  const nameOf = (a) => (a === 'main' ? 'Composer (main)' : a === 'worker' ? 'Worker 1' : a.startsWith('worker') ? 'Worker ' + a.replace('worker', '') : a);
  const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dur = (a, b) => { const s = Math.max(0, Math.round(((b || Date.now()) - a) / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
  const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s ?? ''); } };
  const runId = (c) => `${c.key}|${c.startedAt}`;
  const runName = (c) => String(c.label || c.kind).replace(/^Automation: /, '').replace(/^main-board$/, 'Composer pass').replace(/^worker\d*-board$/, 'Task run');

  async function load() {
    const r = await fetch('/api/details?minutes=1440').then((x) => x.json()).catch(() => null);
    if (!r || !r.cards) return;
    data = r; render();
  }
  function runsOf(a) { return (data.cards || []).filter((c) => c.agent === a).sort((x, y) => (y.live - x.live) || (y.startedAt - x.startedAt)); }

  function render() {
    if (!data) return;
    const agents = [...new Set(['main', ...(data.cards || []).map((c) => c.agent)])].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.length - b.length || a.localeCompare(b)));
    // agent list
    $('detAgents').replaceChildren(...agents.map((a) => {
      const rs = runsOf(a); const live = rs.some((c) => c.live);
      const d = el('div', 'det-agent' + (a === agent ? ' on' : '') + (live ? ' live' : '')); d.style.setProperty('--c', colorOf(a));
      d.append(el('span', 'dot2'), el('b', null, nameOf(a)), el('span', 'st', live ? 'working now' : rs[0] ? `last ${t(rs[0].endedAt || rs[0].startedAt).slice(0, 5)}` : 'no runs today'));
      d.onclick = () => { agent = a; pick('detAgent', a); runKey = null; render(); };
      return d;
    }));
    $('liveBadge').textContent = (data.cards || []).filter((c) => c.live).length || '';
    // runs of this agent
    const rs = runsOf(agent);
    if ($('detFollow').checked && rs[0] && (rs[0].live || !runKey)) runKey = runId(rs[0]);
    if (!rs.some((c) => runId(c) === runKey)) runKey = rs[0] ? runId(rs[0]) : null;
    $('detRuns').replaceChildren(...(rs.length ? rs.map((c) => {
      const d = el('div', 'det-run' + (runId(c) === runKey ? ' on' : ''));
      const tools = c.timeline.filter((e) => e.kind === 'tool').length, errs = c.timeline.filter((e) => e.state === 'error').length;
      d.append(el('div', null, (c.live ? '● ' : '') + runName(c)), el('div', 't', `${t(c.startedAt)} · ${dur(c.startedAt, c.endedAt)} · ${tools} tools${errs ? ` · ${errs} failed` : ''}`));
      d.onclick = () => { runKey = runId(c); $('detFollow').checked = false; render(); };
      return d;
    }) : [el('div', 'sub', 'No runs in the last day.')]));
    const c = rs.find((x) => runId(x) === runKey);
    renderRun(c);
  }

  function renderRun(c) {
    const head = $('detHead'), box = $('detTimeline');
    if (!c) { head.replaceChildren(el('div', 'sub', `${nameOf(agent)} has no runs in the last day.`)); box.replaceChildren(); $('detCount').textContent = ''; return; }
    const tools = c.timeline.filter((e) => e.kind === 'tool'), errs = tools.filter((e) => e.state === 'error').length;
    const title = el('div', 'det-title'); const dot = el('span', 'dot2'); dot.style.background = colorOf(c.agent);
    title.append(dot, el('b', null, nameOf(c.agent)), el('span', 'sub', ' · ' + runName(c)), el('span', 'det-state ' + (c.live ? 'live' : c.phase === 'error' ? 'err' : 'done'), c.live ? 'working now' : c.phase === 'error' ? 'failed' : 'finished'));
    const k = el('div', 'det-kpis');
    for (const [l, v] of [['started', t(c.startedAt)], ['duration', dur(c.startedAt, c.endedAt)], ['model', c.model || '?'], ['tool calls', tools.length], ['failed', errs], ['thoughts', c.timeline.filter((e) => e.kind === 'think').length]]) { const s = el('span'); s.append(document.createTextNode(l + ' '), el('b', null, String(v))); k.append(s); }
    const task = el('div', 'det-task', c.task || '');
    head.replaceChildren(title, task, k);
    // timeline (rebuilt only when it changed, so open <details> and the scroll position survive)
    const show = { think: $('detThink').checked, tool: $('detTools').checked, say: $('detSay').checked };
    const sig = runId(c) + JSON.stringify(show) + c.timeline.length + (c.timeline.at(-1)?.state || '') + (c.timeline.at(-1)?.text || '').length;
    if (sig === lastSig) return; lastSig = sig;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const rows = []; let n = 0;
    c.timeline.forEach((e, i) => {
      if (!show[e.kind]) return; n++;
      const r = el('div', 'dev ' + e.kind + (e.state === 'error' ? ' err' : ''));
      const ic = el('span', 'ic', e.kind === 'tool' ? (e.state === 'pending' ? '◌' : e.state === 'error' ? '✕' : '⚙') : e.kind === 'think' ? '💭' : '💬');
      const bd = el('div', 'bd');
      if (e.kind === 'tool') {
        const top = el('div'); top.append(el('span', 'tn', e.tool), el('span', 'sub', e.state === 'pending' ? '  running…' : e.state === 'error' ? '  failed' : ''));
        const args = el('details'); args.open = i >= c.timeline.length - 3; args.append(el('summary', null, 'arguments'), el('pre', null, pretty(e.args)));
        bd.append(top, args);
        if (e.result != null) { const res = el('details'); res.open = e.state === 'error' || i >= c.timeline.length - 2; res.append(el('summary', null, e.state === 'error' ? 'error' : 'result'), el('pre', null, pretty(e.result))); bd.append(res); }
      } else bd.textContent = e.text;
      r.append(el('span', 'tm', e.ts ? t(Date.parse(e.ts)) : ''), ic, bd); rows.push(r);
    });
    if (c.report && show.say && !c.timeline.some((e) => e.kind === 'say' && e.text === c.report)) { const r = el('div', 'dev say final'); r.append(el('span', 'tm', c.endedAt ? t(c.endedAt) : ''), el('span', 'ic', '🏁'), el('div', 'bd', c.report)); rows.push(r); }
    box.replaceChildren(...(rows.length ? rows : [el('div', 'sub', 'Nothing to show with these filters.')]));
    $('detCount').textContent = `${n} of ${c.timeline.length} events`;
    if ($('detFollow').checked || atBottom) box.scrollTop = box.scrollHeight;
  }

  for (const id of ['detThink', 'detTools', 'detSay']) $(id).onchange = () => { lastSig = ''; render(); };
  $('detFollow').onchange = () => { lastSig = ''; render(); };
  window.detailsShow = (on) => {
    visible = on; clearInterval(timer); timer = null;
    if (on) { load(); timer = setInterval(() => { if (!document.hidden) load(); }, 2000); }
  };
  if ($('tab-details').classList.contains('on')) window.detailsShow(true);
})();
