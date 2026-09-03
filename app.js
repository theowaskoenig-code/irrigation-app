// app.js — the UI. Talks only to the backend contract in backend.js.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let backend, state, screen = 'glance', sheet = null, hwText = '';
const SCREENS = ['glance', 'pots', 'tank', 'alerts', 'control', 'settings'];

// ---------------------------------------------------------------- formatting
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function when(ts) { const d = new Date(ts); return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }); }
function litres(ml) { return (ml / 1000).toFixed(ml < 2000 ? 2 : 1); }
function upStr(s) { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} d ${h} h` : `${h} h ${m} min`; }
function potName(i) { const n = state.household.potNames[i]; return n ? `${i + 1} · ${n}` : `Pot ${i + 1}`; }
// State chips: symbol + word, so no state relies on colour alone (Style C "Clear", app/design/cockpit-spec.json).
const SYM = { dry: '▲', wet: '●', implausible: '✕', uncal: '?', off: '—', unfitted: '·', warn: '▲', critical: '✕', info: '●', open: '●' };
function chip(cls, label) { return `<span class="tag ${cls}">${SYM[cls] || ''} ${esc(label)}</span>`; }
function autoText(min) { return min >= 60 ? (min / 60) + ' h' : min + ' min'; }
function nextRound() {
  const t = state.telemetry;
  if (!t.autoMin) return { v: 'Auto off', s: 'start a round from Control' };
  const ms = t.nextRoundAt - Date.now();
  if (ms <= 0) return { v: 'due now', s: 'waiting for the controller' };
  const h = Math.floor(ms / 3600e3), m = Math.round(ms % 3600e3 / 60e3);
  return { v: h ? `${h} h ${m} min` : `${m} min`, s: `at ${new Date(t.nextRoundAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` };
}
function reasonText(r) { return backend.mock ? backend.mock.reasonText(r) : r; }
// Appearance: the chosen look is light, so light is the default whatever the OS says; 'system' hands it back to the OS.
function themeGet() { try { return localStorage.getItem('theme') || 'light'; } catch (e) { return 'light'; } }
function themeApply(v) {
  if (v === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v);
  try { localStorage.setItem('theme', v); } catch (e) { /* private mode */ }
}

// Sensor state → { cls, label } used by tiles, tags and rows.
function potState(p) {
  const t = state.telemetry;
  if (p.i >= Math.max(t.nSensors, t.nServos)) return { cls: 'unfitted', label: 'not fitted' };
  if (!p.senEn) return { cls: 'off', label: 'sensor off' };
  if (p.i >= t.nSensors) return { cls: 'unfitted', label: 'no sensor' };
  if (p.sState === S_STATE.IMPLAUSIBLE) return { cls: 'implausible', label: 'implausible' };
  if (p.sState === S_STATE.UNCAL) return { cls: 'uncal', label: 'uncalibrated' };
  if (p.sState !== S_STATE.OK) return { cls: 'uncal', label: 'no reading' };
  return p.pct < p.thrPct ? { cls: 'dry', label: 'dry' } : { cls: 'wet', label: 'wet' };
}
function valveText(p) {
  const t = state.telemetry;
  if (p.i >= t.nServos) return 'not fitted';
  if (!p.valEn) return 'off';
  return ['?', 'closed', 'OPEN', 'limp'][p.vState] || '?';
}
function dailyUse() { return dailyUseML(state.events, Date.now()); }
function daysLeft() { const u = dailyUse(); return u ? (state.telemetry.tankLeft - state.config.tankReserve) / u : null; }

// ---------------------------------------------------------------- commands
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
async function cmd(name, args, label) {
  const conn = connState(state.device, Date.now());
  toast(conn === 'offline' ? `${label} — queued, controller offline` : `${label}…`);
  try {
    const rec = await backend.sendCommand(name, args);
    if (rec.status === 'acked') toast(`${label} — done${rec.result && rec.result.ml ? ` (${rec.result.ml} mL, ${rec.result.sec} s)` : ''}`);
    else if (rec.status === 'expired') toast(`${label} — expired, controller was offline`, 4000);
    else toast(`${label} — refused: ${reasonText(rec.result && rec.result.reason)}`, 4500);
    if (rec.result && rec.result.text) { hwText = rec.result.text; render(); }
    return rec;
  } catch (e) { toast(`${label} — failed: ${e.message}`, 4500); }
}

// ---------------------------------------------------------------- screens
// Tank level (steps down at every round, up at every refill) over litres dosed per day — 14 days, one time axis, from events.
function tankChart() {
  const now = Date.now(), SPAN = 14, W = 520, padL = 36, padR = 14, top = 8, H1 = 80, gap = 24, H2 = 50, axis = 18, DAY = 86400e3;
  const full = state.config.tankFull, t = state.telemetry;
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
  const t0 = today0.getTime() - (SPAN - 1) * DAY, t1 = today0.getTime() + DAY;
  const x = (ts) => padL + (ts - t0) / (t1 - t0) * (W - padL - padR), y1 = (ml) => top + H1 - ml / full * H1;
  const isLevel = (e) => e.kind === 'round' || e.kind === 'refill';
  const evs = state.events.filter(e => isLevel(e) && e.ts >= t0).sort((a, b) => a.ts - b.ts);
  const before = state.events.find(e => isLevel(e) && e.ts < t0);      // events are newest first
  let level = before ? before.tankLeft : evs.length ? evs[0].tankLeft : t.tankLeft, s = '';
  [0, full / 2, full].forEach(v => { s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y1(v).toFixed(1)}" y2="${y1(v).toFixed(1)}"/><text class="lbl" x="${padL - 4}" y="${(y1(v) + 4).toFixed(1)}" text-anchor="end">${v / 1000}</text>`; });
  let d = `M${x(t0).toFixed(1)} ${y1(level).toFixed(1)}`;
  evs.forEach(e => { const X = x(e.ts).toFixed(1); d += ` L${X} ${y1(level).toFixed(1)} L${X} ${y1(e.tankLeft).toFixed(1)}`; level = e.tankLeft; });
  d += ` L${x(now).toFixed(1)} ${y1(level).toFixed(1)}`;
  if (level !== t.tankLeft) d += ` L${x(now).toFixed(1)} ${y1(t.tankLeft).toFixed(1)}`;   // level set by hand since the last round
  s += `<path class="tank" d="${d}"/>`;
  evs.filter(e => e.kind === 'refill').forEach(e => { const X = x(e.ts); s += `<polygon class="refill" points="${(X - 6).toFixed(1)},${top + H1} ${(X + 6).toFixed(1)},${top + H1} ${X.toFixed(1)},${top + H1 - 10}"/><text class="lbl wet" x="${(X < padL + 60 ? X + 8 : X - 8).toFixed(1)}" y="${top + H1 - 2}" text-anchor="${X < padL + 60 ? 'start' : 'end'}">refill</text>`; });
  s += `<circle class="now" cx="${x(now).toFixed(1)}" cy="${y1(t.tankLeft).toFixed(1)}" r="5"/><text class="lbl acc" x="${(x(now) - 8).toFixed(1)}" y="${(y1(t.tankLeft) + (y1(t.tankLeft) + 22 > top + H1 ? -9 : 17)).toFixed(1)}" text-anchor="end">${litres(t.tankLeft)} L</text>`;
  const days = []; for (let i = 0; i < SPAN; i++) days.push({ start: t0 + i * DAY, ml: 0 });
  state.events.forEach(e => { if (e.kind !== 'dose' || e.ts < t0) return; const dd = days[Math.min(SPAN - 1, Math.floor((e.ts - t0) / DAY))]; dd.ml += e.ml || 0; });
  const maxL = Math.max(0.5, ...days.map(dd => dd.ml / 1000)) * 1.15, b0 = top + H1 + gap, y2 = (l) => b0 + H2 - l / maxL * H2;
  const dx = (W - padL - padR) / SPAN, bw = dx * 0.62;
  days.forEach(dd => { const l = dd.ml / 1000; if (l > 0) s += `<rect class="bar" x="${(x(dd.start + DAY / 2) - bw / 2).toFixed(1)}" y="${y2(l).toFixed(1)}" width="${bw.toFixed(1)}" height="${(l / maxL * H2).toFixed(1)}" rx="1"/>`; });
  s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${b0 + H2}" y2="${b0 + H2}"/><text class="lbl" x="${padL - 4}" y="${b0 + 3}" text-anchor="end">${maxL.toFixed(1)}</text>`;
  [-7, 0].forEach(dd => { s += `<text class="lbl" x="${x(today0.getTime() + dd * DAY + DAY / 2).toFixed(1)}" y="${b0 + H2 + 13}" text-anchor="middle">${dd ? `−${-dd} d` : 'today'}</text>`; });
  return `<div class="chead"><span class="l">Tank · L</span><span class="l">Dosed / day · ${SPAN} d</span></div>
  <svg viewBox="0 0 ${W} ${b0 + H2 + axis}" role="img" aria-label="Tank level and litres dosed per day over ${SPAN} days">${s}</svg>`;
}

// Glance = exactly the widget stack Theo chose in the lab (app/design/cockpit-spec.json), top to bottom:
// Charts · Alerts strip · Tank | Temperature · Weather | Pump & auto · Next round | Last round · Pot grid · Quick actions.
function renderGlance() {
  const t = state.telemetry, c = state.config, d = daysLeft(), conn = connState(state.device, Date.now()), lr = state.lastRound, nr = nextRound();
  const banner = conn === 'offline' ? `<div class="card" style="border-color:var(--red);margin-bottom:12px"><div class="row"><strong class="danger-text">✕ Controller offline</strong><span class="faint">last seen ${ago(state.device.lastSeen)}</span></div><div class="muted" style="font-size:15px;margin-top:4px">It keeps watering on its own schedule. Commands wait until it reconnects.</div></div>` : '';
  const active = state.alerts.filter(a => a.active && !a.ackedAt).slice(0, 3);
  const states = state.pots.map(potState), nDry = states.filter(st => st.cls === 'dry').length, nBad = states.filter(st => st.cls === 'implausible').length;
  const pots = state.pots.map((p, i) => {
    const st = states[i], fitted = st.cls !== 'unfitted', pct = p.pct >= 0 ? p.pct : 0, name = state.household.potNames[i];
    return `<button class="pot ${st.cls}" data-action="pot" data-arg="${p.i}">
      <div class="h"><span class="n"><i>${p.i + 1}</i>${esc(name || 'Pot ' + (p.i + 1))}</span><span class="p">${p.pct >= 0 ? p.pct + ' %' : '—'}</span></div>
      <div class="bar"><i style="width:${pct}%"></i>${st.cls === 'dry' || st.cls === 'wet' ? `<b style="left:${p.thrPct}%"></b>` : ''}</div>
      <div class="s">${chip(st.cls, st.label)}<span class="faint">${fitted && !p.valEn ? '□ valve off' : p.todayML ? p.todayML + ' mL today' : (p.vState === V_STATE.OPEN ? 'valve open' : '')}</span></div>
    </button>`;
  }).join('');
  return `${banner}<div class="wgrid ${conn !== 'online' ? 'stale' : ''}">
    <div class="w x2 chart">${tankChart()}</div>
    <div class="w x2"><div class="l" style="margin-bottom:${active.length ? 8 : 0}px">${active.length ? `Needs a human · ${active.length}` : 'Alerts'}</div>
      <div class="astrip">${active.length ? active.map(a => `<div class="a ${a.severity}"><div class="t">${SYM[a.severity] || ''} ${esc(a.message)}</div><div class="m">${ago(a.ts)}${a.ch != null ? ` · <a href="#" data-action="pot" data-arg="${a.ch}">open ${esc(potName(a.ch))}</a>` : ''} · <a href="#" data-action="ack" data-arg="${a.id}">acknowledge</a></div></div>`).join('') : '<div class="s">Nothing needs a human right now.</div>'}</div></div>
    <div class="w"><div class="l">Tank</div><div class="v">${litres(t.tankLeft)}<small>L</small></div><div class="s">${d == null ? 'no history yet' : `<b>${d < 1 ? '< 1 day' : Math.floor(d) + (d >= 2 ? ' days' : ' day')}</b> left`} · ${Math.round(100 * t.tankLeft / c.tankFull)} % full</div></div>
    <div class="w"><div class="l">Temperature</div><div class="v">${t.tempEn && t.tempOK ? t.tempC.toFixed(1) + '<small>°C</small>' : '—'}</div><div class="s">${t.tempEn ? (t.tempC < c.minTempC ? '<b class="danger-text">frost — watering suspended</b>' : 'no frost · watering allowed') : 'probe switched off'}</div></div>
    <div class="w weather"><div class="l">Weather</div><div class="v">—</div><div class="s">forecast and rain-skip land here (phase 2)</div></div>
    <div class="w"><div class="l">Pump · Auto</div><div class="v mid">${t.pumpRunning ? chip('open', 'pump running') : 'Idle'}</div><div class="s">${t.autoMin ? `Auto every ${autoText(t.autoMin)}` : 'Auto off'} · ${t.pumpEn ? 'ready' : '<b class="danger-text">pump switched OFF</b>'}</div></div>
    <div class="w"><div class="l">Next round</div><div class="v mid">${nr.v}</div><div class="s">${nr.s}</div></div>
    <div class="w x2"><div class="l">Last round${lr ? ` · ${ago(lr.ts)}` : ''}</div><div class="s" style="font-size:18px;margin-top:2px">${lr ? `<b>${lr.watered} watered</b> · ${lr.skipped} skipped · ${lr.refused ? `<b class="danger-text">${lr.refused} refused</b>` : 'none refused'}` : 'no round yet'}</div></div>
    <div class="x2"><div class="row" style="margin:4px 0 8px"><span class="l" style="font-weight:700">Pots · ${nDry} dry${nBad ? ` · ${nBad} problem${nBad > 1 ? 's' : ''}` : ''}</span><span class="faint" style="font-size:15px">tap a pot for details</span></div>
      <div class="pots">${pots}</div></div>
    <div class="w x2"><div class="acts"><button class="btn primary" data-action="cmd" data-cmd="run" data-label="Run a round">Run round</button><button class="btn" data-action="confirm-refill">Refilled</button><button class="btn danger-outline" data-action="confirm-stop">Stop</button></div></div>
  </div>`;
}

function renderPots() {
  const rows = state.pots.map(p => { const st = potState(p); return `
    <button class="btn block" style="justify-content:space-between;text-align:left;border:0;padding:10px 0" data-action="pot" data-arg="${p.i}">
      <span class="stack" style="flex:1"><span><strong>${esc(potName(p.i))}</strong> ${chip(st.cls, st.label)}</span>
      <span class="faint" style="font-size:14px">thr ${p.thrPct} % · dose ${p.doseML} mL · today ${p.todayML} mL · valve ${valveText(p)}</span></span>
      <span class="num" style="font-size:20px;font-weight:700">${p.pct >= 0 ? p.pct + ' %' : '—'}</span>
    </button>`; }).join('');
  return `<div class="card"><div class="list">${rows}</div></div>`;
}

function sparkline(points, key, floor) {
  if (points.length < 2) return '';
  const w = 300, h = 56, xs = points.map(p => p.ts), ys = points.map(p => p[key]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = 0, y1 = Math.max(...ys, 1);
  const X = (x) => ((x - x0) / (x1 - x0 || 1)) * w, Y = (y) => h - 4 - ((y - y0) / (y1 - y0 || 1)) * (h - 8);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)},${Y(p[key]).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}"/>${floor != null ? `<line x1="0" x2="${w}" y1="${Y(floor)}" y2="${Y(floor)}"/>` : ''}</svg>`;
}

function renderTank() {
  const t = state.telemetry, c = state.config, pct = Math.round(100 * t.tankLeft / c.tankFull), d = daysLeft(), u = dailyUse();
  const refills = state.events.filter(e => e.kind === 'refill').slice(0, 10);
  const todayML = state.pots.reduce((s, p) => s + p.todayML, 0);
  return `
  <div class="card">
    <div class="grid-2">
      <div class="kpi"><div class="v">${litres(t.tankLeft)}<small>L</small></div><div class="l">${pct} % of ${litres(c.tankFull)} L</div></div>
      <div class="kpi"><div class="v">${d == null ? '—' : d < 1 ? '< 1' : Math.floor(d)}<small>days</small></div><div class="l">${u ? `at ≈ ${litres(u)} L/day (7-day avg)` : 'no dosing history yet'}</div></div>
    </div>
    <div class="bar ${pct < 20 ? 'dry' : ''}" style="height:14px;margin:12px 0 6px"><i style="width:${pct}%"></i><b style="left:${100 * c.tankReserve / c.tankFull}%"></b></div>
    <div class="row faint" style="font-size:14px"><span>reserve ${c.tankReserve} mL — nothing waters below it</span><span>${todayML} mL dosed today</span></div>
  </div>
  <div class="card">
    <h2>Last 3 days</h2>
    ${sparkline(state.readings.slice(-400), 'tankLeft', c.tankReserve)}
    <div class="faint" style="font-size:14px">Software counter: every dose is subtracted; a leak is invisible to it — eyeball the tank now and then. Full history charts come in phase 2.</div>
  </div>
  <div class="card section">
    <button class="btn primary block" data-action="confirm-refill">Refilled — mark tank full</button>
    <div class="inline"><div class="field"><label>Or set the level by hand (mL)</label><input type="number" id="tank-ml" min="0" max="${c.tankFull}" step="250" placeholder="${t.tankLeft}"></div><button class="btn" data-action="tank-set">Set</button></div>
  </div>
  <div class="card"><h2>Refills</h2><div class="list">${refills.length ? refills.map(e => `<div class="row"><span>${when(e.ts)}</span><span class="muted">${litres(e.tankLeft)} L</span></div>`).join('') : '<div class="empty">No refills recorded</div>'}</div></div>`;
}

function renderAlerts() {
  const active = state.alerts.filter(a => a.active), past = state.alerts.filter(a => !a.active).slice(0, 20);
  const item = (a) => `<div class="alert ${a.ackedAt ? 'acked' : ''}">
    ${chip(a.severity, a.severity)}
    <div class="stack"><span>${esc(a.message)}</span><span class="when">${when(a.ts)} · ${ago(a.ts)}${a.ch != null ? ` · <a href="#" data-action="pot" data-arg="${a.ch}">${esc(potName(a.ch))}</a>` : ''}${a.ackedAt ? ' · acknowledged' : ''}${!a.active ? ' · cleared' : ''}</span></div>
    ${a.active && !a.ackedAt ? `<button class="btn sm" data-action="ack" data-arg="${a.id}">Ack</button>` : ''}
  </div>`;
  return `
  <div class="card"><div class="row"><h2>Active</h2>${active.some(a => !a.ackedAt) ? '<button class="btn sm ghost" data-action="ack" data-arg="all">Acknowledge all</button>' : ''}</div>
    <div class="list">${active.length ? active.map(item).join('') : '<div class="empty">Nothing needs a human right now</div>'}</div></div>
  <div class="card"><h2>Recent</h2><div class="list">${past.length ? past.map(item).join('') : '<div class="empty">No past alerts</div>'}</div></div>
  <div class="faint" style="font-size:14px;margin-top:12px">Rules: tank &lt; 20 % · tank at reserve · pot refused (implausible / uncalibrated / budget) · frost &lt; 3 °C · controller silent &gt; ${3 * state.device.intervalS / 60} min · 90 s pump cap · emergency stop. Push goes to ntfy topic <span class="mono">${esc(state.household.ntfyTopic)}</span>.</div>`;
}

function renderControl() {
  const t = state.telemetry, cmds = state.commands.slice(0, 8);
  const st = (c) => c.status === 'acked' ? 'done' : c.status === 'failed' ? `refused · ${reasonText(c.result && c.result.reason)}` : c.status;
  return `
  <div class="card">
    <div class="row"><div class="kpi"><div class="v" style="font-size:22px">${t.pumpRunning ? '<span class="tag open">PUMP RUNNING</span>' : 'Pump idle'}</div><div class="l">${t.pumpEn ? 'enabled' : 'switched OFF — nothing waters'}</div></div>
      <button class="btn" data-action="cmd" data-cmd="pstop" data-label="Pump stop" ${t.pumpRunning ? '' : 'disabled'}>Stop pump</button></div>
  </div>
  <div class="card section">
    <div class="row"><div class="stack"><strong>Auto mode</strong><span class="faint" style="font-size:14px">rounds run from the controller's own timer, cloud or no cloud</span></div>
      <button class="switch" role="switch" aria-checked="${t.autoMin > 0}" data-action="auto-toggle"></button></div>
    <div class="inline"><div class="field"><label>Interval</label><select id="auto-min">${[60, 120, 180, 360, 720, 1440].map(m => `<option value="${m}" ${t.autoMin === m || (!t.autoMin && m === 360) ? 'selected' : ''}>${m >= 60 ? m / 60 + ' h' : m + ' min'}</option>`).join('')}</select></div><button class="btn" data-action="auto-set">Apply</button></div>
  </div>
  <div class="card section">
    <button class="btn primary block" data-action="cmd" data-cmd="run" data-label="Run a round">Run a round now</button>
    <div class="btn-row"><button class="btn" data-action="cmd" data-cmd="refresh" data-label="Refresh readings">Refresh readings</button><button class="btn" data-action="cmd" data-cmd="hwcheck" data-label="Hardware check">Hardware check</button></div>
    ${hwText ? `<pre class="mono" style="white-space:pre-wrap;margin:0;background:var(--surface-2);padding:10px;border-radius:8px">${esc(hwText)}</pre>` : ''}
    <button class="btn danger block" data-action="confirm-stop">Emergency stop</button>
    <div class="faint" style="font-size:14px">A round senses all pots first (pump off, valves limp), then waters dry pots one at a time through every interlock. Emergency stop cuts the pump and all servo PWM; closed valves stay closed on the cam.</div>
  </div>
  <div class="card"><h2>Commands</h2><div class="list">${cmds.length ? cmds.map(c => `<div class="cmd"><span>${esc(c.cmd)}${c.args && Object.keys(c.args).length ? ` <span class="faint mono">${esc(JSON.stringify(c.args))}</span>` : ''}</span><span class="st ${c.status}">${st(c)} · ${ago(c.ackedAt || c.createdAt)}</span></div>`).join('') : '<div class="empty">No commands yet</div>'}</div></div>`;
}

function renderSettings() {
  const d = state.device, t = state.telemetry, c = state.config;
  const rows = state.pots.map(p => `<tr>
    <td>${esc(potName(p.i))}</td>
    <td><input type="number" min="1" max="99" value="${p.thrPct}" data-change="thr" data-arg="${p.i}"></td>
    <td><input type="number" min="10" max="2000" step="10" value="${p.doseML}" data-change="dose" data-arg="${p.i}"></td>
    <td><button class="switch" role="switch" aria-checked="${p.senEn}" data-action="en" data-what="s${p.i + 1}" data-on="${!p.senEn}"></button></td>
    <td><button class="switch" role="switch" aria-checked="${p.valEn}" data-action="en" data-what="v${p.i + 1}" data-on="${!p.valEn}"></button></td>
    <td class="faint">${p.air > 0 && p.water > 0 ? `${p.air} / ${p.water}` : '—'}</td>
  </tr>`).join('');
  const theme = themeGet();
  return `
  <div class="card section">
    <h2>Appearance</h2>
    <div class="btn-row" role="group" aria-label="Appearance">${[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([v, l]) => `<button class="btn ${theme === v ? 'primary' : ''}" aria-pressed="${theme === v}" data-action="theme" data-arg="${v}">${l}</button>`).join('')}</div>
    <div class="faint" style="font-size:14px">Light is the chosen look; System follows the phone's setting.</div>
  </div>
  <div class="card section">
    <h2>Controller</h2>
    <div class="row"><span class="muted">Name</span><span>${esc(d.name)} <span class="faint mono">${esc(d.id)}</span></span></div>
    <div class="row"><span class="muted">Firmware</span><span class="mono">${esc(d.fw)}</span></div>
    <div class="row"><span class="muted">Last seen</span><span>${ago(d.lastSeen)}</span></div>
    <div class="row"><span class="muted">Uptime · WiFi</span><span>${upStr(d.up)} · ${d.rssi} dBm</span></div>
    <div class="row"><span class="muted">PCA9685</span><span>${d.havePCA ? 'found' : '<span class="danger-text">MISSING</span>'}</span></div>
    <div class="inline"><div class="field"><label>Telemetry interval</label><select id="interval-s">${[60, 120, 300, 600, 900].map(s => `<option value="${s}" ${d.intervalS === s ? 'selected' : ''}>${s / 60} min</option>`).join('')}</select></div><button class="btn" data-action="interval-set">Apply</button></div>
    <div class="row"><span class="muted">Firmware upload</span>
      <a class="btn" href="http://${esc(d.ip)}/update" target="_blank" rel="noopener">Open upload page</a></div>
    <div class="faint" style="font-size:14px">Opens http://${esc(d.ip)}/update on the controller — home WiFi only, by design. Sign in with user <b>admin</b> and your OTA password, pick the .bin, upload; the board stops the pump, flashes and reboots.</div>
  </div>
  <div class="card section">
    <h2>Fitted hardware &amp; constants</h2>
    <div class="inline"><div class="field"><label>Sensors fitted</label><input type="number" id="fit-sen" min="0" max="16" value="${t.nSensors}"></div><div class="field"><label>Servos fitted</label><input type="number" id="fit-srv" min="0" max="16" value="${t.nServos}"></div><button class="btn" data-action="fit-set">Apply</button></div>
    <div class="inline"><div class="field"><label>Flow (mL/s)</label><input type="number" id="flow" step="0.1" min="0.1" value="${t.mlPerSec}"><span class="hint">30 = free-flow bench value; re-measure on a real branch</span></div><button class="btn" data-action="flow-set">Apply</button></div>
    <div class="inline"><div class="field"><label>Servo open (µs)</label><input type="number" id="open-us" min="500" max="2500" value="${c.openUs}"></div><div class="field"><label>closed (µs)</label><input type="number" id="closed-us" min="500" max="2500" value="${c.closedUs}"></div><button class="btn" data-action="vlim-set">Apply</button></div>
    <div class="row"><div class="stack"><span>Temperature probe</span><span class="faint" style="font-size:14px">frost interlock below ${c.minTempC} °C</span></div><button class="switch" role="switch" aria-checked="${t.tempEn}" data-action="en" data-what="temp" data-on="${!t.tempEn}"></button></div>
    <div class="row"><div class="stack"><span>Pump</span><span class="faint" style="font-size:14px">off = the whole system is dry-run</span></div><button class="switch" role="switch" aria-checked="${t.pumpEn}" data-action="en" data-what="pump" data-on="${!t.pumpEn}"></button></div>
    <div class="row"><div class="stack"><span>Status LED</span><span class="faint" style="font-size:14px">not fitted on Rev A4 — the firmware still has the switch</span></div><button class="switch" role="switch" aria-checked="${t.ledEn}" data-action="en" data-what="led" data-on="${!t.ledEn}"></button></div>
  </div>
  <div class="card section">
    <div class="row"><h2>Per pot</h2><span class="faint" style="font-size:14px">edits are sent when you leave the field</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Pot</th><th>Thr %</th><th>Dose mL</th><th>Sensor</th><th>Valve</th><th>Air / water</th></tr></thead><tbody>${rows}</tbody></table></div>
    <button class="btn block" data-action="cmd" data-cmd="save" data-label="Save to flash">Save all settings to the controller's flash</button>
  </div>
  <div class="card section">
    <h2>Household</h2>
    <div class="inline"><div class="field"><label>ntfy.sh topic for push alerts</label><input type="text" id="ntfy" value="${esc(state.household.ntfyTopic)}"><span class="hint">Install the ntfy app on every phone and subscribe to this topic.</span></div><button class="btn" data-action="ntfy-set">Save</button></div>
    <div class="row"><span class="muted">Signed in as</span><span>${esc((backend.session() || {}).email || '—')}</span></div>
    <button class="btn block" data-action="logout">Sign out</button>
  </div>
  ${backend.isMock ? `<div class="card section" style="border-style:dashed">
    <h2>Mock controls (this build runs on fake data)</h2>
    <div class="row"><span>Simulate controller offline</span><button class="switch" role="switch" aria-checked="${backend.mock.isOffline()}" data-action="mock-offline"></button></div>
    <button class="btn" data-action="mock-dry">Dry out pot 1 now</button>
  </div>` : ''}`;
}

// ---------------------------------------------------------------- sheets
function renderSheet() {
  const el = $('#sheet'), scrim = $('#scrim');
  if (!sheet) { el.classList.remove('open'); scrim.classList.remove('open'); el.innerHTML = ''; return; }
  el.classList.add('open'); scrim.classList.add('open');
  if (sheet.type === 'pot') {
    if (!el.dataset.pot || +el.dataset.pot !== sheet.i) { el.dataset.pot = sheet.i; el.innerHTML = `<div class="grip"></div><div id="sheet-live"></div><div id="sheet-form"></div>`; $('#sheet-form', el).innerHTML = potForm(state.pots[sheet.i]); }
    $('#sheet-live', el).innerHTML = potLive(state.pots[sheet.i]);
  } else if (sheet.type === 'confirm') {
    delete el.dataset.pot;
    el.innerHTML = `<div class="grip"></div><h3>${esc(sheet.title)}</h3><p class="muted">${esc(sheet.body)}</p>
      <div class="btn-row"><button class="btn" data-action="sheet-close">Cancel</button><button class="btn ${sheet.danger ? 'danger' : 'primary'}" data-action="confirm-go">${esc(sheet.ok)}</button></div>`;
  }
}
function potLive(p) {
  const st = potState(p), budget = 2 * p.doseML;
  const last = state.events.find(e => e.ch === p.i && (e.kind === 'dose' || e.kind === 'refused'));
  return `<div class="row top"><div><h3>${esc(potName(p.i))}</h3>${chip(st.cls, st.label)}${p.valEn ? '' : ' ' + chip('off', 'valve off')}</div>
    <div class="kpi" style="text-align:right"><div class="v">${p.pct >= 0 ? p.pct + '<small>%</small>' : '—'}</div><div class="l">raw ${p.raw} · thr ${p.thrPct} %</div></div></div>
  <div class="bar ${st.cls}" style="margin:10px 0"><i style="width:${p.pct >= 0 ? p.pct : 0}%"></i><b style="left:${p.thrPct}%"></b></div>
  <div class="row faint" style="font-size:14px"><span>valve ${valveText(p)}</span><span>today ${p.todayML} / ${budget} mL budget</span><span>${p.air > 0 && p.water > 0 ? `air ${p.air} · water ${p.water}` : 'not calibrated'}</span></div>
  ${last ? `<div class="faint" style="font-size:14px;margin-top:6px">last: ${last.kind === 'dose' ? `${last.ml} mL` : `refused — ${reasonText(last.reason)}`} · ${ago(last.ts)}</div>` : ''}
  <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-action="cmd" data-cmd="water" data-ch="${p.i}" data-label="Water ${esc(potName(p.i))}">Water now (${p.doseML} mL)</button><button class="btn" data-action="cmd" data-cmd="vtest" data-ch="${p.i}" data-label="Valve test ${p.i + 1}">Valve test</button></div>`;
}
function potForm(p) {
  return `<div class="section">
    <div class="inline"><div class="field"><label>Water below (%)</label><input type="number" min="1" max="99" value="${p.thrPct}" data-change="thr" data-arg="${p.i}"></div>
      <div class="field"><label>Dose (mL)</label><select data-change="dose" data-arg="${p.i}"><option value="250" ${p.doseML === 250 ? 'selected' : ''}>250 · small pot</option><option value="900" ${p.doseML === 900 ? 'selected' : ''}>900 · large pot</option>${[250, 900].includes(p.doseML) ? '' : `<option value="${p.doseML}" selected>${p.doseML}</option>`}</select></div></div>
    <div class="row"><span>Sensor</span><button class="switch" role="switch" aria-checked="${p.senEn}" data-action="en" data-what="s${p.i + 1}" data-on="${!p.senEn}"></button></div>
    <div class="row"><span>Valve</span><button class="switch" role="switch" aria-checked="${p.valEn}" data-action="en" data-what="v${p.i + 1}" data-on="${!p.valEn}"></button></div>
    <div class="field"><label>Name</label><input type="text" value="${esc(state.household.potNames[p.i] || '')}" placeholder="e.g. Basil" data-change="name" data-arg="${p.i}"></div>
  </div>
  <div class="section">
    <h2>Calibration</h2>
    <div class="faint" style="font-size:14px">Blade in air, then in a glass of water. Each records a 64-sample average on the controller. Wet reads lower; a healthy span is several hundred counts.</div>
    <div class="btn-row"><button class="btn" data-action="cmd" data-cmd="cal" data-ch="${p.i}" data-which="air" data-label="Record air ${p.i + 1}">Record air</button><button class="btn" data-action="cmd" data-cmd="cal" data-ch="${p.i}" data-which="water" data-label="Record water ${p.i + 1}">Record water</button></div>
    <div class="inline"><div class="field"><label>Air</label><input type="number" id="cal-air" value="${p.air > 0 ? p.air : ''}"></div><div class="field"><label>Water</label><input type="number" id="cal-water" value="${p.water > 0 ? p.water : ''}"></div><button class="btn" data-action="cal-type" data-arg="${p.i}">Set</button></div>
    <button class="btn ghost" data-action="cmd" data-cmd="cal" data-ch="${p.i}" data-clear="1" data-label="Clear calibration ${p.i + 1}">Clear calibration</button>
  </div>
  <div class="section"><h2>Valve (bench)</h2><div class="btn-row">${[['o', 'Open'], ['c', 'Close'], ['x', 'Limp']].map(([s, l]) => `<button class="btn sm" data-action="cmd" data-cmd="v" data-ch="${p.i}" data-st="${s}" data-label="Valve ${p.i + 1} ${l.toLowerCase()}">${l}</button>`).join('')}</div>
    <div class="faint" style="font-size:14px">An open valve holds ~0.25 A — do not leave it open. Close, then limp; the cam holds it shut.</div></div>`;
}

// ---------------------------------------------------------------- render
function render() {
  const conn = connState(state.device, Date.now());
  const c = $('#conn'); c.className = `conn ${conn}`; c.querySelector('span:last-child').textContent = conn === 'online' ? `online · ${ago(state.device.lastSeen)}` : conn === 'stale' ? `stale · ${ago(state.device.lastSeen)}` : `offline · ${ago(state.device.lastSeen)}`;
  const nAlerts = state.alerts.filter(a => a.active && !a.ackedAt).length;
  const badge = $('#badge-alerts'); badge.hidden = !nAlerts; badge.textContent = nAlerts;
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === screen));
  const fn = { glance: renderGlance, pots: renderPots, tank: renderTank, alerts: renderAlerts, control: renderControl, settings: renderSettings }[screen];
  const host = $(`#screen-${screen}`);
  const focused = document.activeElement && host.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
  if (!focused) host.innerHTML = fn();
  SCREENS.forEach(s => $(`#screen-${s}`).classList.toggle('active', s === screen));
  renderSheet();
}
function go(s) { screen = s; sheet = null; window.scrollTo(0, 0); render(); try { localStorage.setItem('screen', s); } catch (e) { /* private mode */ } }

// ---------------------------------------------------------------- actions
function onClick(e) {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, arg = el.dataset.arg;
  if (el.tagName === 'A') e.preventDefault();
  switch (a) {
    case 'pot': sheet = { type: 'pot', i: +arg }; render(); break;
    case 'sheet-close': sheet = null; render(); break;
    case 'cmd': {
      const args = {};
      if (el.dataset.ch != null) args.ch = +el.dataset.ch;
      if (el.dataset.which) args.which = el.dataset.which;
      if (el.dataset.clear) args.clear = true;
      if (el.dataset.st) args.st = el.dataset.st;
      cmd(el.dataset.cmd, args, el.dataset.label); break;
    }
    case 'en': cmd('en', { what: el.dataset.what, on: el.dataset.on === 'true' }, `${el.dataset.what} ${el.dataset.on === 'true' ? 'on' : 'off'}`); break;
    case 'ack': backend.ackAlert(arg); break;
    case 'confirm-refill': sheet = { type: 'confirm', title: 'Tank refilled?', body: 'Sets the counter to 25 L. Only do this after actually topping the tank up.', ok: 'Yes, mark full', run: () => cmd('tank', { full: true }, 'Tank full') }; render(); break;
    case 'confirm-stop': sheet = { type: 'confirm', danger: true, title: 'Emergency stop', body: 'Cuts the pump and every servo signal immediately. Closed valves stay closed on the cam; an open one stays open until you close it. Auto mode is not changed.', ok: 'Stop everything', run: () => cmd('stop', {}, 'Emergency stop') }; render(); break;
    case 'confirm-go': { const r = sheet.run; sheet = null; render(); r(); break; }
    case 'tank-set': { const v = +$('#tank-ml').value; if (v >= 0) cmd('tank', { ml: v }, `Tank ${v} mL`); break; }
    case 'auto-toggle': cmd('auto', { min: state.telemetry.autoMin ? 0 : +$('#auto-min').value }, state.telemetry.autoMin ? 'Auto off' : 'Auto on'); break;
    case 'auto-set': cmd('auto', { min: +$('#auto-min').value }, 'Auto interval'); break;
    case 'interval-set': cmd('interval', { s: +$('#interval-s').value }, 'Telemetry interval'); break;
    case 'fit-set': cmd('fit', { nSensors: +$('#fit-sen').value, nServos: +$('#fit-srv').value }, 'Fitted counts'); break;
    case 'flow-set': cmd('flow', { mlPerSec: +$('#flow').value }, 'Flow'); break;
    case 'vlim-set': cmd('vlim', { openUs: +$('#open-us').value, closedUs: +$('#closed-us').value }, 'Servo pulses'); break;
    case 'cal-type': cmd('cal', { ch: +arg, air: +$('#cal-air').value, water: +$('#cal-water').value }, `Calibration ${+arg + 1}`); break;
    case 'ntfy-set': backend.setHousehold({ ntfyTopic: $('#ntfy').value.trim() }); toast('Saved'); break;
    case 'theme': themeApply(arg); render(); break;
    case 'logout': backend.logout().then(() => { if (backend.isMock) toast('Signed out (mock: nothing happens)'); else location.reload(); }); break;
    case 'mock-offline': backend.mock.setOffline(!backend.mock.isOffline()); break;
    case 'mock-dry': backend.mock.dryOut(0); toast('Pot 1 is now dry'); break;
  }
}
function onChange(e) {
  const el = e.target.closest('[data-change]'); if (!el) return;
  const i = +el.dataset.arg, v = el.value;
  if (el.dataset.change === 'thr') cmd('thr', { ch: i, pct: +v }, `Threshold ${i + 1}`);
  else if (el.dataset.change === 'dose') cmd('dose', { ch: i, ml: +v }, `Dose ${i + 1}`);
  else if (el.dataset.change === 'name') { const names = { ...state.household.potNames, [i]: v.trim() }; if (!v.trim()) delete names[i]; backend.setHousehold({ potNames: names }); }
}

// ---------------------------------------------------------------- boot
// Login gate (real backend only): resolves once backend.login() succeeded.
function showLogin() {
  const box = $('#login'), form = $('#login-form'), err = $('#login-err');
  box.hidden = false;
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
    err.innerHTML = 'The cloud is not set up yet (no project URL / key in backend.js — see app/SETUP.md). '
      + 'Meanwhile: <a href="?backend=lan">open the live board on the home WiFi</a> or <a href="?backend=mock">the demo</a>.';
    form.querySelector('button').disabled = true;
  }
  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const btn = form.querySelector('button'); btn.disabled = true;
      try {
        await backend.login($('#login-email').value.trim(), $('#login-pw').value, $('#login-stay').checked);
        box.hidden = true; resolve();
      } catch (ex) { err.textContent = ex.message; }
      btn.disabled = false;
    });
    $('#login-email').focus();
  });
}
async function main() {
  themeApply(themeGet());
  backend = await createBackend();
  await backend.init();
  if (!backend.session()) { await showLogin(); await backend.init(); }
  state = backend.getState();
  try { const s = localStorage.getItem('screen'); if (SCREENS.includes(s)) screen = s; } catch (e) { /* ignore */ }
  const q = new URLSearchParams(location.search).get('screen'); if (SCREENS.includes(q)) screen = q;
  backend.subscribe(s => { state = s; render(); });
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.screen)));
  $('#scrim').addEventListener('click', () => { sheet = null; render(); });
  setInterval(render, 15000);            // relative times + freshness
  render();
}
main().catch(e => { document.body.innerHTML = `<pre style="padding:16px">${esc(e.stack || e)}</pre>`; });
