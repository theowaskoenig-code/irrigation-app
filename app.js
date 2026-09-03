// app.js — the UI. Talks only to the backend contract in backend.js.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let backend, state, screen = 'glance', sheet = null, hwText = '';
const SCREENS = ['glance', 'pots', 'tank', 'alerts', 'control', 'settings', 'rules', 'bench'];   // rules = Watering plan, bench = Test bench: full-width screens behind Control
const HIST = { days: 14, off: 0, data: null, key: '', at: 0, loading: null, err: null, pot: {}, topEvent: null };   // history() cache (charts) + per-pot moisture; off = days the chart window is shifted back
const CH_AHEAD = 2, CH_BACK_MAX = 92, CH_FWD_MAX = 7, CH_STEP = 7;   // the chart window: `days` + 2 look-ahead days, pannable −92 d (Open-Meteo past_days) … +7 d (forecast_days), a week per tap
const TB = { liveUntil: 0, prevIntervalS: null, lastSec: 5 };                                              // Test bench: cloud "live for 5 minutes"

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
function whenDate(ts) { const d = new Date(ts); return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function litres(ml) { return (ml / 1000).toFixed(ml < 2000 ? 2 : 1); }
function upStr(s) { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} d ${h} h` : `${h} h ${m} min`; }
function potName(i) { const n = state.household.potNames[i]; return n ? `${i + 1} · ${n}` : `Pot ${i + 1}`; }
// State chips: symbol + word, so no state relies on colour alone (Style C "Clear", app/design/cockpit-spec.json).
const SYM = { dry: '▲', wet: '●', implausible: '✕', uncal: '?', off: '—', unfitted: '·', warn: '▲', critical: '✕', info: '●', open: '●' };
function chip(cls, label) { return `<span class="tag ${cls}">${SYM[cls] || ''} ${esc(label)}</span>`; }
function autoText(min) { return min >= 60 ? (min / 60) + ' h' : min + ' min'; }
// The Glance "Next round" tile is derived from the controller's telemetry only (rulesHash / planNext / auto timer) —
// never from this phone's plan draft, which may differ from what the board runs (review A2).
function nextRound() {
  const t = state.telemetry;
  if (t.rulesHash) return t.planNext > 0 ? untilText(t.planNext * 1000, 'watering plan') : { v: 'None', s: 'No round planned on the controller' };
  if (!t.autoMin || !t.nextRoundAt) return { v: 'Auto off', s: 'start a round from Control' };
  return untilText(t.nextRoundAt, 'auto');
}
function untilText(at, why) {
  const ms = at - Date.now();
  if (ms <= 0) return { v: 'due now', s: 'waiting for the controller' };
  const h = Math.floor(ms / 3600e3), m = Math.round(ms % 3600e3 / 60e3);
  return { v: h ? `${h} h ${m} min` : `${m} min`, s: `at ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${why}` };
}
// Alert severity comes from the database / the controller: only the three classes the CSS knows may reach a class attribute (review S2).
const SEVERITIES = ['info', 'warn', 'critical'];
function sevCls(s) { return SEVERITIES.includes(s) ? s : 'info'; }
// Appearance: the chosen look is light, so light is the default whatever the OS says; 'system' hands it back to the OS.
function themeGet() { try { return localStorage.getItem('theme') || 'light'; } catch (e) { return 'light'; } }
function themeApply(v) {
  if (v === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v);
  try { localStorage.setItem('theme', v); } catch (e) { /* private mode */ }
}
function isCloud() { return !backend.isMock && !backend.lan; }

// Sensor state → { cls, label } used by tiles, tags and rows.
function potState(p) {
  const t = state.telemetry;
  if (p.i >= Math.max(t.nSensors, t.nServos)) return { cls: 'unfitted', label: 'not fitted' };
  if (!p.senEn) return { cls: 'off', label: 'sensor off' };
  if (p.i >= t.nSensors) return { cls: 'unfitted', label: 'no sensor' };
  if (p.sState === S_STATE.IMPLAUSIBLE) return { cls: 'implausible', label: 'sensor fault' };
  if (p.sState === S_STATE.UNCAL) return { cls: 'uncal', label: 'not calibrated' };
  if (p.sState !== S_STATE.OK) return { cls: 'uncal', label: 'no reading' };
  return p.pct < p.thrPct ? { cls: 'dry', label: 'dry' } : { cls: 'wet', label: 'wet' };
}
function valveText(p) {
  const t = state.telemetry;
  if (p.i >= t.nServos) return 'not fitted';
  if (!p.valEn) return 'off';
  return ['unknown', 'closed · holding', 'OPEN', 'closed'][p.vState] || 'unknown';   // 3 = closed and limp (the cam holds); 0 = not tracked since the last reset
}
function dailyUse() { return dailyUseML(state.events, Date.now()); }
function daysLeft() { const u = dailyUse(); return u ? (state.telemetry.tankLeft - state.config.tankReserve) / u : null; }

// ---------------------------------------------------------------- commands
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
// Commands that move water or a valve are sent once: while one of them is queued or sent, a second tap is refused and the
// buttons that would send it are disabled (review A1). `stop` is deliberately not in the list — it must always go through.
const CMD_WORD = { run: 'A round', water: 'A watering', p: 'A pump run', plan_run: 'A plan round', v: 'A valve move', vtest: 'A valve test', vall: 'A close-all', reseat: 'A re-seat', tank: 'A tank change' };
const inflight = new Set();
function cmdPending(name) { return inflight.has(name) || state.commands.some(c => c.cmd === name && (c.status === 'queued' || c.status === 'sent')); }
function dis(name) { return cmdPending(name) ? ' disabled' : ''; }
async function cmd(name, args, label) {
  if (CMD_WORD[name] && cmdPending(name)) { toast(`${CMD_WORD[name]} is already waiting for the controller`, 3500); return null; }
  const conn = connState(state.device, Date.now());
  toast(conn === 'offline' ? `${label} — queued, controller offline` : `${label}…`);
  inflight.add(name); render();
  const slow = setTimeout(() => toast(`${label} — still waiting — see Control › Commands`, 5000), 60000);   // the ack races a minute (review A4)
  try {
    const rec = await backend.sendCommand(name, args);
    if (rec.status === 'acked') toast(`${label} — done${rec.result && rec.result.ml ? ` (${rec.result.ml} mL, ${rec.result.sec} s)` : rec.result && typeof rec.result.tempC === 'number' ? ` (${rec.result.tempC.toFixed(1)} °C)` : ''}`);
    else if (rec.status === 'expired') toast(`${label} — expired, controller was offline`, 4000);
    else if (rec.status === 'queued' || rec.status === 'sent') toast(`${label} — still waiting — see Control › Commands`, 5000);
    else toast(`${label} — refused: ${reasonText(rec.result && rec.result.reason)}`, 4500);
    if (rec.result && rec.result.text) { hwText = rec.result.text; }
    return rec;
  } catch (e) { toast(`${label} — failed: ${e.message}`, 4500); return null; }
  finally { clearTimeout(slow); inflight.delete(name); render(); }
}
// A number field, checked before it becomes a command: empty or out of range → a plain-words toast and null (review A6).
function num(id, min, max, what) {
  const el = $(id), v = el && el.value.trim() !== '' ? +el.value : NaN;
  if (!Number.isFinite(v) || v < min || v > max) { toast(`${what}: type a number from ${min} to ${max}`, 3500); return null; }
  return v;
}

// ---------------------------------------------------------------- history (charts) — fetched from the backend, cached, refreshed when a new event arrives
function histEnsure(days, endOff) {
  const key = `${days}:${endOff}`, stale = HIST.key !== key || Date.now() - HIST.at > 5 * 60e3;
  if (!stale || HIST.loading === key) return;
  HIST.loading = key;
  backend.history(days, endOff).then(d => { HIST.data = d; HIST.key = key; HIST.err = null; }).catch(e => { HIST.err = e.message; HIST.key = key; })
    .finally(() => { HIST.at = Date.now(); HIST.loading = null; render(); });
}
// The chart window for a span of N days: N + 2 look-ahead days, shifted back by HIST.off days (clamped to −92 … +7 d).
function chartOffLimits(span) { return { min: CH_AHEAD - CH_FWD_MAX, max: CH_BACK_MAX - (span - 1) }; }
function chartPan(span, dir) { const l = chartOffLimits(span); HIST.off = dir === 0 ? 0 : Math.max(l.min, Math.min(l.max, HIST.off - dir * CH_STEP)); render(); }   // dir −1 = ◀ = a week further back (off grows)
function potHistEnsure(i) {
  const c = HIST.pot[i];
  if (c && (c.loading || Date.now() - c.at < 5 * 60e3)) return;
  HIST.pot[i] = { ...(c || {}), loading: true };
  backend.potHistory(i, 14).then(d => { HIST.pot[i] = { data: d, at: Date.now() }; }).catch(e => { HIST.pot[i] = { err: e.message, at: Date.now() }; }).finally(render);
}
function histInvalidate() { HIST.at = 0; Object.keys(HIST.pot).forEach(k => { if (!HIST.pot[k].loading) HIST.pot[k].at = 0; }); }

// ---------------------------------------------------------------- charts (inline SVG, 520 wide)
const CW = 520, CPL = 36, CPR = 14;
// Day labels along the bottom: every day's short weekday name (Mon … Sun), today in bold; when the days are too narrow
// (the 30-day span) only Mondays are named. daySeps() draws the light vertical separator between days.
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Day boundaries are local midnights (dayStart, backend.js): a DST day is 23 or 25 h, so "from + n × 24 h" would drift by an hour.
function dayMid(day) { return (day + dayStart(day, 1)) / 2; }
function xAxisLabels(x, from, days, y) {
  const dx = x(dayStart(from, 1)) - x(from), t = dayStart(Date.now(), 0);
  let s = '';
  for (let d = 0; d < days; d++) { const day = dayStart(from, d), wd = new Date(day).getDay(); if (dx < 22 && wd !== 1) continue; s += `<text class="lbl${day === t ? ' today' : ''}" x="${x(dayMid(day)).toFixed(1)}" y="${y}" text-anchor="middle">${WD[wd]}</text>`; }
  return s;
}
function daySeps(x, from, days, y0, y1) { let s = ''; for (let d = 1; d < days; d++) { const X = x(dayStart(from, d)).toFixed(1); s += `<line class="daysep" x1="${X}" x2="${X}" y1="${y0}" y2="${y1}"/>`; } return s; }
// Weather icons for the chart strip: monochrome line drawings in a 16 px box, one per Open-Meteo weather_code group.
const WX_ICON = {
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  suncloud: '<circle cx="5.5" cy="5.5" r="2.5"/><path d="M5.5 1v1.4M1 5.5h1.4M2.3 2.3l1 1M8.7 2.3l-1 1"/><path d="M6.5 14h6.5a2.5 2.5 0 0 0 0-5 3.5 3.5 0 0 0-6.7-.5A2.8 2.8 0 0 0 6.5 14z"/>',
  cloud: '<path d="M5 13h7.5a3 3 0 0 0 0-6 4 4 0 0 0-7.7 0A3 3 0 0 0 5 13z"/>',
  rain: '<path d="M5 10.5h7.5a3 3 0 0 0 0-6 4 4 0 0 0-7.7 0A3 3 0 0 0 5 10.5z"/><path d="M6 12.5l-.8 2M9 12.5l-.8 2M12 12.5l-.8 2"/>',
  snow: '<path d="M5 10.5h7.5a3 3 0 0 0 0-6 4 4 0 0 0-7.7 0A3 3 0 0 0 5 10.5z"/><path d="M5.5 12.5l2 2M7.5 12.5l-2 2M10 12.5l2 2M12 12.5l-2 2"/>',
  storm: '<path d="M5 10h7.5a3 3 0 0 0 0-6 4 4 0 0 0-7.7 0A3 3 0 0 0 5 10z"/><path d="M9.5 9.5l-2.5 3h3l-2 3"/>',
};
function wxKind(code) {
  if (code === null || code === undefined) return null;
  if (code === 0) return 'sun'; if (code <= 2) return 'suncloud'; if (code <= 48) return 'cloud';
  if (code >= 95) return 'storm'; if (code >= 85 || (code >= 71 && code <= 77)) return 'snow'; return 'rain';
}
function wxIcon(kind, x, y, size, cls) { return `<g class="wxi ${cls}" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${(size / 16).toFixed(3)})">${WX_ICON[kind]}</g>`; }
// The chart's weather: the demo's fake 17 days in mock mode, else the same Open-Meteo answer the Weather tile uses (null until it arrives / when it failed).
function chartWeather() {
  if (backend.isMock) return backend.mock.weatherChart();
  const hh = state.household; Weather.ensure(hh, render); const fc = Weather.get(hh); return fc && fc.chart ? fc.chart : null;
}
// The Glance chart — WATERING first: litres dosed per day as solid blue bars rising from the bottom (one bar per day, the pot
// count inside when there is room, the value on today's bar); RAIN in mm per day hanging down from the top strip as light-blue
// bars (never more than a quarter of the plot); the TANK level as a thin line over everything (0 … full = the plot height, its
// litres at the dot) with refill markers; a TOP STRIP per day with the weekday name (today bold), the weather icon and the
// day/night average °C (06–22 over 22–06; the balcony's measured hours where history() has them, darker ink; else the forecast)
// and the 3-step colour band by the DAY average (cool < 15 °C · mild 15–25 · hot > 25). Left axis = litres/day. The window is
// what history() returned (span + 2 days, pannable with ◀ today ▶); the "now" marks only when today is in view.
function tankChart(h) {
  const now = Date.now(), wx = chartWeather(), CPR2 = 14, t = state.telemetry, full = state.config.tankFull;
  const t0 = h.from, t1 = dayStart(h.from, h.days), nowIn = now >= t0 && now <= t1, today = dayStart(now, 0);
  const x = (ts) => CPL + (ts - t0) / (t1 - t0) * (CW - CPL - CPR2), clampX = (ts) => x(Math.min(t1, Math.max(t0, ts))), dx = x(dayStart(t0, 1)) - x(t0), mid = (day) => x(dayMid(day));
  const wxd = wx ? wx.days.filter(d => d.day >= t0 && d.day < t1) : [], icons = wxd.length > 0 && dx >= 22;
  const TS = icons ? 62 : 16, P0 = TS + 4, H = 130, P1 = P0 + H, bw = dx * 0.62;
  let s = daySeps(x, t0, h.days, 0, P1);
  // -- top strip: temperature band (by the day average), weekday, icon, day °C over night °C
  const meas = Weather.dayNight(h.temp), dn = (d) => { const m = meas[d.day] || {}, md = m.nDay >= 8, mn = m.nNight >= 4; return { day: md ? m.tDay : d.tDay, night: mn ? m.tNight : d.tNight, mDay: md, mNight: mn }; };   // measured when at least half the hours are there
  if (icons) wxd.forEach(d => { const v = dn(d).day; if (v !== null && v !== undefined) s += `<rect class="${v < 15 ? 'tcool' : v <= 25 ? 'tmild' : 'thot'}" x="${x(d.day).toFixed(1)}" y="0" width="${dx.toFixed(1)}" height="${TS}"/>`; });
  for (let d = 0; d < h.days; d++) { const day = dayStart(t0, d), wd = new Date(day).getDay(); if (dx >= 22 || wd === 1) s += `<text class="lbl${day === today ? ' today' : ''}" x="${mid(day).toFixed(1)}" y="12" text-anchor="middle">${WD[wd]}</text>`; }
  if (icons) wxd.forEach(dd => { const k = wxKind(dd.code); if (k) s += wxIcon(k, mid(dd.day) - 9, 18, 18, dd.day === today ? 'today' : ''); });
  // day °C over night °C, always both rows: a wide column (≥ 30 SVG units) shows "21°" over "12°" at 10 px; a narrow one (the
  // 16-day Glance window, phones) shows "21" over "12" at 9.5 px, tabular digits — the legend's "°C day over night" carries the unit
  if (icons) wxd.forEach(dd => { const v = dn(dd), wide = dx >= 30, deg = (c) => c === null || c === undefined ? '' : `${Math.round(c)}${wide ? '°' : ''}`, X = mid(dd.day).toFixed(1), cls = (m) => `tdn${wide ? '' : ' sm'}${m ? ' meas' : ''}`; s += `<text class="${cls(v.mDay)}" x="${X}" y="${wide ? 46 : 45}" text-anchor="middle">${deg(v.day)}</text><text class="${cls(v.mNight)}" x="${X}" y="${wide ? 60 : 57}" text-anchor="middle">${deg(v.night)}</text>`; });
  if (now < t1) s += `<rect class="future" x="${clampX(now).toFixed(1)}" y="${P0}" width="${(x(t1) - clampX(now)).toFixed(1)}" height="${H}"/>`;
  // -- watering: litres per day, up from the bottom (the tallest bar reaches ~70 % so it never meets the rain)
  const maxL = Math.max(0.5, ...h.perDay.map(dd => dd.ml / 1000)) / 0.7, yL = (l) => P1 - l / maxL * H;
  [0, maxL / 2].forEach(v => { s += `<line class="grid" x1="${CPL}" x2="${CW - CPR2}" y1="${yL(v).toFixed(1)}" y2="${yL(v).toFixed(1)}"/><text class="lbl" x="${CPL - 4}" y="${(yL(v) + 4).toFixed(1)}" text-anchor="end">${v ? v.toFixed(1) : '0 L'}</text>`; });
  h.perDay.forEach(dd => {
    const l = dd.ml / 1000; if (l <= 0) return;
    const y = yL(l), hh = P1 - y;
    s += `<rect class="wbar" x="${(mid(dd.day) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="1"/>`;
    if (dd.n && hh >= 16 && dx >= 22) s += `<text class="blbl" x="${mid(dd.day).toFixed(1)}" y="${(P1 - 4).toFixed(1)}" text-anchor="middle">${dd.n}</text>`;
    if (dd.day === today) s += `<text class="lbl acc" x="${mid(dd.day).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${l.toFixed(1)} L</text>`;
  });
  // -- rain per day, hanging from the strip
  if (wxd.length) {
    const maxMM = Math.max(1, ...wxd.map(dd => dd.mm || 0)), RH = H * 0.25;
    wxd.forEach(dd => { if (dd.mm > 0) s += `<rect class="rain" x="${(mid(dd.day) - bw / 2).toFixed(1)}" y="${P0}" width="${bw.toFixed(1)}" height="${(dd.mm / maxMM * RH).toFixed(1)}" rx="1"/>`; });
    if (maxMM > 1) s += `<text class="lbl wetl" x="${CPL - 4}" y="${P0 + 10}" text-anchor="end">${maxMM}</text><text class="lbl wetl" x="${CPL - 4}" y="${P0 + 20}" text-anchor="end">mm</text>`;   // the scale of the tallest rain bar, in the left gutter
  }
  // -- tank level: a thin line, 0 … full over the plot height, refills, now
  const yT = (ml) => P1 - ml / full * H, pts = h.tank.filter(p => p.ts >= t0 && p.ts <= Math.min(now, t1));
  let d = '', last = t.tankLeft;
  if (pts.length) { d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${yT(p.ml).toFixed(1)}`).join(' '); last = pts[pts.length - 1].ml; if (nowIn) d += ` L${x(now).toFixed(1)} ${yT(last).toFixed(1)}`; }
  else if (nowIn) d = `M${x(Math.max(t0, now - 3600e3)).toFixed(1)} ${yT(last).toFixed(1)} L${x(now).toFixed(1)} ${yT(last).toFixed(1)}`;
  if (nowIn && last !== t.tankLeft) d += ` L${x(now).toFixed(1)} ${yT(t.tankLeft).toFixed(1)}`;   // level changed since the last hourly point (a round or a refill just now)
  if (d) s += `<path class="tank" d="${d}"/>`;
  h.refills.forEach(ts => { const X = x(ts); s += `<polygon class="refill" points="${(X - 6).toFixed(1)},${P0 + 2} ${(X + 6).toFixed(1)},${P0 + 2} ${X.toFixed(1)},${P0 + 12}"><title>refill · ${esc(whenDate(ts))}</title></polygon>`; });   // the word is in the legend, so nothing collides with the rain bars
  if (nowIn) {
    s += `<line class="nowline" x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="${P0}" y2="${P1}"/>`;
    const right = x(now) + 60 < CW - CPR2;                         // the label goes into the (empty) future side when there is room
    s += `<circle class="now" cx="${x(now).toFixed(1)}" cy="${yT(t.tankLeft).toFixed(1)}" r="4"/><text class="lbl acc" x="${(x(now) + (right ? 7 : -7)).toFixed(1)}" y="${(yT(t.tankLeft) + 4).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}">${litres(t.tankLeft)} L</text>`;
  }
  s += `<line class="grid" x1="${CPL}" x2="${CW - CPR2}" y1="${P1}" y2="${P1}"/>`;
  const legend = `<div class="wxlegend"><span><svg viewBox="0 0 16 16"><rect class="wbar" x="4" y="4" width="8" height="10"/></svg>watered</span><span>·</span>${wxd.length ? `<span><svg viewBox="0 0 16 16"><rect class="rain" x="4" y="2" width="8" height="9"/></svg>rain</span><span>·</span>` : ''}<span><svg viewBox="0 0 16 16"><path class="tank" d="M1 11 L6 9 L10 10 L15 4"/></svg>tank</span><span><svg viewBox="0 0 16 16"><polygon class="refill" points="2,3 14,3 8,13"/></svg>refill</span>${wxd.length ? `<span>·</span><span>day average</span><span><svg viewBox="0 0 16 16"><rect class="tcool" x="1" y="3" width="14" height="10"/></svg>cool</span><span><svg viewBox="0 0 16 16"><rect class="tmild" x="1" y="3" width="14" height="10"/></svg>mild</span><span><svg viewBox="0 0 16 16"><rect class="thot" x="1" y="3" width="14" height="10"/></svg>hot</span><span>·</span><span>°C day over night</span>` : ''}</div>`;
  return `<div class="chead"><span class="l">Watered · L per day</span><span class="l">tank 0 – ${litres(full)} L · ${h.days} d</span></div>
  <svg viewBox="0 0 ${CW} ${P1 + 6}" role="img" aria-label="Litres watered per day, rain, tank level and weather over ${h.days} days">${s}</svg>
  ${legend}`;
}
// Temperature, hourly, over the same span.
function tempChart(h) {
  const top = 8, H = 70, axis = 18, t0 = h.from, t1 = dayStart(h.from, h.days), pts = h.temp.filter(p => p.ts >= t0);
  if (pts.length < 2) return `<div class="chead"><span class="l">Temperature · °C</span></div><div class="faint" style="font-size:14px">no temperature history yet</div>`;
  const lo = Math.floor(Math.min(0, ...pts.map(p => p.c)) / 5) * 5, hi = Math.ceil(Math.max(10, ...pts.map(p => p.c)) / 5) * 5;
  const x = (ts) => CPL + (ts - t0) / (t1 - t0) * (CW - CPL - CPR), y = (c) => top + H - (c - lo) / (hi - lo) * H;
  let s = daySeps(x, t0, h.days, top, top + H);
  [lo, hi].forEach(v => { s += `<line class="grid" x1="${CPL}" x2="${CW - CPR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="lbl" x="${CPL - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`; });
  const f = state.config.minTempC; if (f > lo) s += `<line class="floor" x1="${CPL}" x2="${CW - CPR}" y1="${y(f).toFixed(1)}" y2="${y(f).toFixed(1)}"/><text class="lbl" x="${CW - CPR}" y="${(y(f) - 3).toFixed(1)}" text-anchor="end">frost ${f} °C</text>`;
  s += `<path class="temp" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.c).toFixed(1)}`).join(' ')}"/>`;
  s += xAxisLabels(x, t0, h.days, top + H + 13);
  return `<div class="chead"><span class="l">Temperature · °C</span><span class="l">${Math.min(...pts.map(p => p.c)).toFixed(1)} – ${Math.max(...pts.map(p => p.c)).toFixed(1)} °C</span></div>
  <svg viewBox="0 0 ${CW} ${top + H + axis}" role="img" aria-label="Temperature over ${h.days} days">${s}</svg>`;
}
// One pot's moisture (hourly) with its threshold and a marker at every dose.
function moistureChart(ph, thrPct) {
  const now = Date.now(), days = ph.days, top = 8, H = 80, axis = 18;
  const t0 = dayStart(now, -(days - 1)), t1 = dayStart(t0, days);
  const x = (ts) => CPL + (ts - t0) / (t1 - t0) * (CW - CPL - CPR), y = (p) => top + H - p / 100 * H, pts = ph.moisture.filter(p => p.ts >= t0);
  let s = daySeps(x, t0, days, top, top + H);
  [0, 50, 100].forEach(v => { s += `<line class="grid" x1="${CPL}" x2="${CW - CPR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="lbl" x="${CPL - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`; });
  s += `<line class="floor" x1="${CPL}" x2="${CW - CPR}" y1="${y(thrPct).toFixed(1)}" y2="${y(thrPct).toFixed(1)}"/><text class="lbl" x="${CW - CPR}" y="${(y(thrPct) - 3).toFixed(1)}" text-anchor="end">water below ${thrPct} %</text>`;
  if (pts.length > 1) s += `<path class="moist" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.pct).toFixed(1)}`).join(' ')}"/>`;
  ph.doses.filter(d => d.ts >= t0).forEach(d => { const X = x(d.ts); s += `<polygon class="dose" points="${(X - 5).toFixed(1)},${top + H + 2} ${(X + 5).toFixed(1)},${top + H + 2} ${X.toFixed(1)},${top + H - 8}"><title>${esc(d.ml)} mL · ${esc(when(d.ts))}</title></polygon>`; });
  s += xAxisLabels(x, t0, days, top + H + 14);
  return `<div class="chead"><span class="l">Moisture · % · ${days} d</span><span class="l">▲ = a dose (${ph.doses.length})</span></div>
  <svg viewBox="0 0 ${CW} ${top + H + axis}" role="img" aria-label="Moisture over ${days} days with doses">${s}</svg>`;
}
// A chart over a pannable window of `span` + 2 days: ◀ a week back · today · a week ahead ▶ (also ← → on a keyboard).
function chartBox(span, fn) {
  const days = span + CH_AHEAD, endOff = HIST.off - CH_AHEAD, l = chartOffLimits(span);
  if (HIST.off < l.min || HIST.off > l.max) HIST.off = Math.max(l.min, Math.min(l.max, HIST.off));
  histEnsure(days, endOff);
  const h = HIST.data && HIST.key === `${days}:${endOff}` ? HIST.data : null;
  const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const pan = (from) => `<div class="cpan" role="group" aria-label="Move the chart window"><button class="btn sm" data-action="chart-pan" data-arg="-1" ${HIST.off >= l.max ? 'disabled' : ''} aria-label="A week back">◀</button><span class="range">${from ? `${fmt(from)} – ${fmt(dayStart(from, days - 1))}` : '…'}</span><button class="btn sm" data-action="chart-pan" data-arg="0" ${HIST.off === 0 ? 'disabled' : ''}>Today</button><button class="btn sm" data-action="chart-pan" data-arg="1" ${HIST.off <= l.min ? 'disabled' : ''} aria-label="A week ahead">▶</button></div>`;
  if (!h) return pan(null) + (HIST.err ? `<div class="faint" style="font-size:14px">History could not be loaded: ${esc(HIST.err)}</div>` : '<div class="faint" style="font-size:14px">loading history…</div>');
  return pan(h.from) + fn(h) + (h.note ? `<div class="faint" style="font-size:13px;margin-top:4px">${esc(h.note)}</div>` : '');
}

// ---------------------------------------------------------------- weather tile (Glance) — display only
function weatherTile() {
  const hh = state.household, loc = Weather.loc(hh), t = state.telemetry;
  let fc;
  if (backend.isMock) fc = Weather.fake(t);
  else { fc = Weather.get(hh); Weather.ensure(hh, render); }
  const err = backend.isMock ? null : Weather.error(hh);
  const ctl = t.rainPct !== undefined && t.rainPct !== null && t.wxAgeS !== undefined ? `<br>controller has ${t.rainPct} % · ${ago(Date.now() - t.wxAgeS * 1000)}` : '';
  if (!fc) return `<div class="w"><div class="l">Weather · ${esc(loc.label || 'set in Settings')}</div><div class="v">—</div><div class="s">${err ? `weather unavailable — ${esc(err)}` : 'loading the forecast…'}</div></div>`;
  return `<div class="w"><div class="l">Weather · ${esc(loc.label || `${loc.lat}, ${loc.lon}`)}</div>
    <div class="v">${fc.today.tMax === null ? '—' : fc.today.tMax + '<small>°C today</small>'}</div>
    <div class="s">rain <b>${fc.h12.pct} %</b> (${fc.h12.mm} mm) next 12 h<br>${fc.h24.pct} % (${fc.h24.mm} mm) next 24 h<br>tomorrow ${fc.tomorrow.tMax === null ? '—' : fc.tomorrow.tMax + ' °C'} · ${fc.tomorrow.pct === null ? '—' : fc.tomorrow.pct + ' %'}${fc.fake ? ' · demo' : ''}${ctl}</div></div>`;
}

// ---------------------------------------------------------------- screens
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
      <div class="h"><span class="n"><i>${p.i + 1}</i>${esc(name || 'Pot ' + (p.i + 1))}${fitted ? ruPotTag(p.i) : ''}</span><span class="p">${p.pct >= 0 ? p.pct + ' %' : '—'}</span></div>
      <div class="wbar"><i style="width:${pct}%"></i>${st.cls === 'dry' || st.cls === 'wet' ? `<b style="left:${p.thrPct}%"></b>` : ''}</div>
      <div class="s">${chip(st.cls, st.label)}<span class="faint">${fitted && !p.valEn ? '□ valve off' : p.todayML ? p.todayML + ' mL today' : (p.vState === V_STATE.OPEN ? 'valve open' : '')}</span></div>
    </button>`;
  }).join('');
  return `${banner}<div class="wgrid ${conn !== 'online' ? 'stale' : ''}">
    <div class="w x2 chart">${chartBox(14, tankChart)}</div>
    <div class="w x2"><div class="l" style="margin-bottom:${active.length ? 8 : 0}px">${active.length ? `Needs a human · ${active.length}` : 'Alerts'}</div>
      <div class="astrip">${active.length ? active.map(a => `<div class="a ${sevCls(a.severity)}"><div class="t">${SYM[sevCls(a.severity)]} ${esc(a.message)}</div><div class="m">${ago(a.ts)}${a.ch != null ? ` · <a href="#" data-action="pot" data-arg="${a.ch}">open ${esc(potName(a.ch))}</a>` : ''} · <a href="#" data-action="ack" data-arg="${a.id}">acknowledge</a></div></div>`).join('') : '<div class="s">Nothing needs a human right now.</div>'}</div></div>
    <div class="w"><div class="l">Tank</div><div class="v">${litres(t.tankLeft)}<small>L</small></div><div class="s">${d == null ? 'no history yet' : `<b>${d < 1 ? '< 1 day' : Math.floor(d) + (d >= 2 ? ' days' : ' day')}</b> left`} · ${Math.round(100 * t.tankLeft / c.tankFull)} % full</div></div>
    <div class="w"><div class="l">Temperature</div><div class="v">${t.tempEn && t.tempOK ? t.tempC.toFixed(1) + '<small>°C</small>' : '—'}</div><div class="s">${!t.tempEn ? 'probe switched off' : !t.tempOK ? '<b class="danger-text">no reading from the probe</b> — check red → 5 V, yellow → GPIO8, 4.7 kΩ' : (t.tempC < c.minTempC ? '<b class="danger-text">frost — watering suspended</b>' : 'no frost · watering allowed')}</div></div>
    ${weatherTile()}
    <div class="w"><div class="l">Pump · Auto</div><div class="v mid">${t.pumpRunning ? chip('open', 'pump running') : 'Idle'}</div><div class="s">${t.rulesHash ? 'Watering plan' : t.autoMin ? `Auto every ${autoText(t.autoMin)}` : 'Auto off'} · ${t.pumpEn ? 'ready' : '<b class="danger-text">pump switched OFF</b>'}</div></div>
    <div class="w"><div class="l">Next round</div><div class="v mid">${nr.v}</div><div class="s">${nr.s}</div></div>
    <div class="w x2"><div class="l">Last round${lr ? ` · ${ago(lr.ts)}` : ''}</div><div class="s" style="font-size:18px;margin-top:2px">${lr ? `<b>${lr.watered} watered</b> · ${lr.skipped} skipped${lr.skippedBy ? ` (the plan skipped it: ${esc(lr.skippedBy)})` : ''} · ${lr.refused ? `<b class="danger-text">${lr.refused} refused</b>` : 'none refused'}` : 'no round yet'}</div></div>
    <div class="x2"><div class="row" style="margin:4px 0 8px"><span class="l" style="font-weight:700">Pots · ${nDry} dry${nBad ? ` · ${nBad} problem${nBad > 1 ? 's' : ''}` : ''}</span><span class="faint" style="font-size:15px">tap a pot for details</span></div>
      <div class="pots">${pots}</div></div>
    <div class="w x2"><div class="acts"><button class="btn primary" data-action="confirm-run"${dis('run')}>Run round</button><button class="btn" data-action="confirm-refill"${dis('tank')}>Refilled</button><button class="btn danger-outline" data-action="confirm-stop">Stop</button></div></div>
  </div>`;
}

function renderPots() {
  const rows = state.pots.map(p => { const st = potState(p); return `
    <button class="btn block" style="justify-content:space-between;text-align:left;border:0;padding:10px 0" data-action="pot" data-arg="${p.i}">
      <span class="stack" style="flex:1"><span><strong>${esc(potName(p.i))}</strong> ${chip(st.cls, st.label)}</span>
      <span class="faint" style="font-size:14px">plan ${esc(ruPlanName(p.i))} · today ${p.todayML} mL · valve ${valveText(p)}</span></span>
      <span class="num" style="font-size:20px;font-weight:700">${p.pct >= 0 ? p.pct + ' %' : '—'}</span>
    </button>`; }).join('');
  return `<div class="card"><div class="list">${rows}</div></div>`;
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
  <div class="card section chart">
    <div class="row"><h2>History</h2><div class="btn-row" role="group" aria-label="Range">${[14, 30].map(n => `<button class="btn sm ${HIST.days === n ? 'primary' : ''}" aria-pressed="${HIST.days === n}" data-action="hist-days" data-arg="${n}">${n} days</button>`).join('')}</div></div>
    ${chartBox(HIST.days, h => tankChart(h) + '<div style="height:10px"></div>' + tempChart(h))}
    <div class="faint" style="font-size:14px">Software counter: every dose is subtracted; a leak is invisible to it — eyeball the tank now and then.</div>
  </div>
  <div class="card section">
    <button class="btn primary block" data-action="confirm-refill"${dis('tank')}>Refilled — mark tank full</button>
    <div class="inline"><div class="field"><label>Or set the level by hand (mL)</label><input type="number" id="tank-ml" min="0" max="${c.tankFull}" step="250" placeholder="${t.tankLeft}"></div><button class="btn" data-action="tank-set"${dis('tank')}>Set</button></div>
  </div>
  <div class="card"><h2>Refills</h2><div class="list">${refills.length ? refills.map(e => `<div class="row"><span>${whenDate(e.ts)}</span><span class="muted">${litres(+e.tankLeft || 0)} L</span></div>`).join('') : '<div class="empty">No refills recorded</div>'}</div></div>`;
}

function renderAlerts() {
  const active = state.alerts.filter(a => a.active), past = state.alerts.filter(a => !a.active).slice(0, 20);
  const item = (a) => `<div class="alert ${a.ackedAt ? 'acked' : ''}">
    ${chip(sevCls(a.severity), sevCls(a.severity))}
    <div class="stack"><span>${esc(a.message)}</span><span class="when">${when(a.ts)} · ${ago(a.ts)}${a.ch != null ? ` · <a href="#" data-action="pot" data-arg="${a.ch}">${esc(potName(a.ch))}</a>` : ''}${a.ackedAt ? ' · acknowledged' : ''}${!a.active ? ' · cleared' : ''}</span></div>
    ${a.active && !a.ackedAt ? `<button class="btn sm" data-action="ack" data-arg="${a.id}">Ack</button>` : ''}
  </div>`;
  return `
  <div class="card"><div class="row"><h2>Active</h2>${active.some(a => !a.ackedAt) ? '<button class="btn sm ghost" data-action="ack" data-arg="all">Acknowledge all</button>' : ''}</div>
    <div class="list">${active.length ? active.map(item).join('') : '<div class="empty">Nothing needs a human right now</div>'}</div></div>
  <div class="card"><h2>Recent</h2><div class="list">${past.length ? past.map(item).join('') : '<div class="empty">No past alerts</div>'}</div></div>
  <div class="faint" style="font-size:14px;margin-top:12px">You are alerted when: tank &lt; 20 % · tank at reserve · a pot is refused (sensor fault / not calibrated / daily amount used) · frost &lt; 3 °C · controller silent &gt; ${3 * state.device.intervalS / 60} min · a dose hits the 90 s pump cap · emergency stop. Push goes to ntfy topic <span class="mono">${esc(state.household.ntfyTopic)}</span>.</div>`;
}

// The Commands list in plain sentences — never the JSON that went over the wire (review U2).
function cmdText(c) {
  const a = c.args || {}, pot = (n) => Number.isInteger(n) && n >= 0 && n < 16 ? potName(n) : 'pot ?', VS = { o: 'open', c: 'close', x: 'limp' };
  switch (c.cmd) {
    case 'run': return 'Run a round';
    case 'water': return `Water ${pot(a.ch)}${a.ml > 0 ? ` · ${a.ml} mL` : ''}`;
    case 'plan_run': return `Run plan ${String(a.id || '').toUpperCase()} now`;
    case 'plan_preview': return `Preview plan ${String(a.id || '').toUpperCase()}`;
    case 'rules': return a.clear ? 'Remove the watering plan' : 'Apply the watering plan';
    case 'auto': return a.min > 0 ? `Auto every ${autoText(a.min)}` : 'Auto off';
    case 'tank': return a.full ? 'Tank refilled' : `Tank set to ${litres(a.ml | 0)} L`;
    case 'thr': return `${pot(a.ch)} waters below ${a.pct} %`;
    case 'dose': return `${pot(a.ch)} dose ${a.ml} mL`;
    case 'cal': return a.clear ? `Clear calibration of ${pot(a.ch)}` : a.which ? `Record the ${a.which === 'air' ? 'dry' : 'wet'} reading of ${pot(a.ch)}` : `Calibration of ${pot(a.ch)} · dry ${a.air} · wet ${a.water}`;
    case 'en': return `${enWord(a.what)} ${a.on ? 'on' : 'off'}`;
    case 'fit': return `${a.nSensors} sensors and ${a.nServos} servos fitted`;
    case 'flow': return `Flow ${a.mlPerSec} mL/s`;
    case 'vlim': return `Servo pulses ${a.openUs} / ${a.closedUs} µs`;
    case 'v': return `Valve of ${pot(a.ch)} ${VS[a.st] || ''}`;
    case 'vtest': return `Valve test ${pot(a.ch)}`;
    case 'vall': return 'Close all valves';
    case 'reseat': return 'Re-seat all valves';
    case 'p': return `Pump ${a.sec} s`;
    case 'pstop': return 'Stop the pump';
    case 'stop': return 'Emergency stop';
    case 'save': return 'Save settings on the controller';
    case 'defaults': return 'Back to factory settings';
    case 'refresh': return 'Refresh readings';
    case 'temp': return 'Read the temperature';
    case 'hwcheck': return 'Hardware check';
    case 'sweep': return 'Read every sensor';
    case 'interval': return `Readings every ${Math.round((a.s | 0) / 60)} min`;
    case 'reboot': return 'Restart the controller';
    default: return String(c.cmd);
  }
}
function enWord(w) {
  w = String(w || ''); const n = (k) => potName(Math.max(0, Math.min(15, (+w.slice(k) | 0) - 1)));
  if (w === 'pump') return 'Pump'; if (w === 'temp') return 'Temperature probe'; if (w === 'led') return 'Status LED'; if (w === 'all') return 'Everything';
  if (w === 'sensors') return 'All sensors'; if (w === 'valves') return 'All valves';
  if (w.startsWith('pot')) return n(3); if (w[0] === 's') return `Sensor of ${n(1)}`; if (w[0] === 'v') return `Valve of ${n(1)}`; return w;
}
function renderControl() {
  const t = state.telemetry, cmds = state.commands.filter(c => c.cmd !== 'weather').slice(0, 8);   // the hourly weather push is bookkeeping, not something Theo sent
  const st = (c) => c.status === 'acked' ? 'done' : c.status === 'failed' ? `refused · ${esc(reasonText(c.result && c.result.reason))}` : c.status === 'queued' ? 'waiting' : c.status;
  const autoCard = t.rulesHash
    ? `<div class="card section"><div class="row"><div class="stack"><strong>Rounds follow the Watering plan</strong><span class="faint" style="font-size:14px">the plan on the controller decides when; nothing to set here</span></div></div></div>`
    : `<div class="card section">
    <div class="row"><div class="stack"><strong>Auto mode</strong><span class="faint" style="font-size:14px">rounds run from the controller's own timer, cloud or no cloud</span></div>
      <button class="switch" role="switch" aria-checked="${t.autoMin > 0}" data-action="auto-toggle"></button></div>
    <div class="inline"><div class="field"><label>Interval</label><select id="auto-min">${[60, 120, 180, 360, 720, 1440].map(m => `<option value="${m}" ${t.autoMin === m || (!t.autoMin && m === 360) ? 'selected' : ''}>${m >= 60 ? m / 60 + ' h' : m + ' min'}</option>`).join('')}</select></div><button class="btn" data-action="auto-set">Apply</button></div>
  </div>`;
  return `
  <div class="card">
    <div class="row"><div class="kpi"><div class="v" style="font-size:22px">${t.pumpRunning ? '<span class="tag open">PUMP RUNNING</span>' : 'Pump idle'}</div><div class="l">${t.pumpEn ? 'enabled' : 'switched OFF — nothing waters'}</div></div>
      <button class="btn" data-action="cmd" data-cmd="pstop" data-label="Pump stop" ${t.pumpRunning ? '' : 'disabled'}>Stop pump</button></div>
  </div>
  ${autoCard}
  <div class="card section">
    <button class="btn primary block" data-action="confirm-run"${dis('run')}>Run a round now</button>
    <div class="btn-row"><button class="btn" data-action="cmd" data-cmd="refresh" data-label="Refresh readings">Refresh readings</button><button class="btn" data-action="go" data-arg="bench">Test the hardware</button></div>
    <button class="btn danger block" data-action="confirm-stop">Emergency stop</button>
    <div class="faint" style="font-size:14px">A round senses all pots first (pump off, valves limp), then waters dry pots one at a time through every interlock. Emergency stop cuts the pump and all servo PWM; closed valves stay closed on the cam.</div>
  </div>
  ${rulesCard()}
  <div class="card"><h2>Commands</h2><div class="list">${cmds.length ? cmds.map(c => `<div class="cmd"><span>${esc(cmdText(c))}</span><span class="st ${c.status}">${st(c)} · ${ago(c.ackedAt || c.createdAt)}</span></div>`).join('') : '<div class="empty">No commands yet</div>'}</div></div>`;
}

// ---- Test bench: every component on its own, with live readings (Theo 2026-09-03: "test all components and get live readings, also the pump").
function benchLiveText() {
  const d = state.device, t = state.telemetry;
  if (backend.isMock) return 'live — the demo reads every 5 s';
  if (backend.lan) return 'live — read from the controller every 2 s';
  if (TB.liveUntil > Date.now()) return `live for ${Math.ceil((TB.liveUntil - Date.now()) / 60e3)} more min — one reading a minute (the controller’s fastest)`;
  return `normal — one reading every ${Math.round(d.intervalS / 60)} min`;
}
function renderBench() {
  const t = state.telemetry, d = state.device, c = state.config;
  const sensors = state.pots.filter(p => p.i < t.nSensors).map(p => { const st = potState(p); return `<div class="tb-tile ${st.cls}"><span class="n">${esc(potName(p.i))}</span><span class="v">${p.pct >= 0 ? p.pct + ' %' : SYM[st.cls]}</span><span class="r">${p.senEn ? `reading ${p.raw}` : 'off'}</span></div>`; }).join('');
  const valves = state.pots.filter(p => p.i < t.nServos).map(p => `<div class="tb-valve"><div class="stack"><strong>${esc(potName(p.i))}</strong><span class="faint" style="font-size:14px">${p.valEn ? valveText(p) : 'switched off'}</span></div>
    <div class="btn-row">${[['o', 'Open'], ['c', 'Close'], ['x', 'Limp']].map(([s, l]) => `<button class="btn sm" data-action="cmd" data-cmd="v" data-ch="${p.i}" data-st="${s}" data-label="Valve ${p.i + 1} ${l.toLowerCase()}"${dis('v')}>${l}</button>`).join('')}<button class="btn sm" data-action="cmd" data-cmd="vtest" data-ch="${p.i}" data-label="Valve test ${p.i + 1}"${dis('vtest')}>Test</button></div></div>`).join('');
  const plaus = state.pots.filter(p => p.i < t.nSensors && p.senEn), nPlaus = plaus.filter(p => p.sState === S_STATE.OK).length;
  const flowNote = TB.lastSec ? `<div class="inline"><div class="field"><label>Pump ran ${TB.lastSec} s — measured how much?</label><input type="number" id="tb-ml" min="1" max="5000" placeholder="mL in the jug"></div><button class="btn" data-action="tb-flow">Set as flow</button></div>
    <div class="faint" style="font-size:14px">mL ÷ seconds = the flow constant the doses are timed with (now ${t.mlPerSec} mL/s; bench free-flow was 30).</div>` : '';
  return `
  <div class="ru-head"><button class="btn sm" data-action="go" data-arg="control" aria-label="Back to Control">‹ Control</button><div class="stack"><h3>Test bench</h3><span class="faint" style="font-size:14px">every part on its own · live readings</span></div></div>
  <div class="section">
    <div class="card section">
      <div class="row"><h2>Live readings</h2><span class="faint" style="font-size:14px">updated ${ago(t.ts || d.lastSeen)}</span></div>
      <div class="tb-tiles">${sensors || '<div class="empty">No sensors fitted</div>'}</div>
      <div class="row"><span class="faint" style="font-size:14px">${esc(benchLiveText())}</span>${isCloud() ? `<button class="btn sm" data-action="tb-live" ${TB.liveUntil > Date.now() ? 'disabled' : ''}>Live for 5 minutes</button>` : ''}</div>
      <div class="row"><div class="stack"><strong>Temperature probe</strong><span class="faint" style="font-size:14px">${!t.tempEn ? 'switched off' : t.tempOK ? `${t.tempC.toFixed(1)} °C` : '<span class="danger-text">no reading — check red → 5 V, yellow → GPIO8, 4.7 kΩ</span>'}</span></div><button class="btn sm" data-action="cmd" data-cmd="temp" data-label="Read temperature">Read now</button></div>
      <div class="row faint" style="font-size:14px;flex-wrap:wrap"><span>WiFi ${d.rssi} dBm</span><span>free memory ${Number.isFinite(t.heap) ? Math.round(t.heap / 1024) + ' kB' : '—'}</span><span>up ${upStr(d.up)}</span><span class="mono">${esc(d.fw)}</span></div>
    </div>
    <div class="card section">
      <h2>Valves</h2>
      <div class="list">${valves || '<div class="empty">No servos fitted</div>'}</div>
      <button class="btn block" data-action="cmd" data-cmd="vall" data-st="c" data-label="Close all valves"${dis('vall')}>Close all, then limp</button>
      <button class="btn block" data-action="cmd" data-cmd="reseat" data-label="Re-seat all valves"${dis('reseat')}>Re-seat all valves</button>
      <div class="faint" style="font-size:14px">Pushes every closed valve shut again — the board also does this after each round and once an hour.</div>
      <div class="faint" style="font-size:14px">An open valve holds ~0.25 A — open ONE at a time and close it again. Test = open 1 s, close, limp. Limp cuts the signal; the cam keeps a closed valve shut.</div>
    </div>
    <div class="card section">
      <h2>Pump</h2>
      <div class="row"><div class="stack"><span>Pump enabled</span><span class="faint" style="font-size:14px">${t.pumpEn ? 'on — the pump may run' : 'off — every dose and test is a dry run'}</span></div><button class="switch" role="switch" aria-checked="${t.pumpEn}" data-action="en" data-what="pump" data-on="${!t.pumpEn}"></button></div>
      <div class="inline"><div class="field"><label>Run for</label><select id="tb-sec">${[1, 2, 3, 5, 10, 15, 20, 30].map(s => `<option value="${s}" ${s === TB.lastSec ? 'selected' : ''}>${s} s</option>`).join('')}</select></div><button class="btn primary tb-big" style="flex:2" data-action="tb-pump"${dis('p')}>Run pump</button></div>
      <button class="btn danger block tb-big" data-action="cmd" data-cmd="pstop" data-label="Pump stop">STOP</button>
      ${t.pumpRunning ? `<div>${chip('open', 'pump running')}</div>` : ''}
      ${flowNote}
    </div>
    <div class="card section">
      <div class="row"><h2>Hardware check</h2><button class="btn sm" data-action="cmd" data-cmd="hwcheck" data-label="Hardware check">Run check</button></div>
      <div class="list">
        <div class="row"><span>Valve driver</span><span>${d.havePCA ? '● found' : '<span class="danger-text">✕ MISSING</span>'}</span></div>
        <div class="row"><span>Temperature probe</span><span>${!t.tempEn ? '— off' : t.tempOK ? '● answers' : '<span class="danger-text">✕ no answer</span>'}</span></div>
        <div class="row"><span>Sensors plausible</span><span>${nPlaus} of ${plaus.length}${plaus.length - nPlaus ? ` — <span class="danger-text">${plaus.filter(p => p.sState !== S_STATE.OK).map(p => p.i + 1).join(', ')}</span>` : ''}</span></div>
        <div class="row"><span>Pump gate</span><span>${t.pumpRunning ? '<span class="tag open">● ON</span>' : '— low (off)'}</span></div>
      </div>
      ${hwText ? `<pre class="mono" style="white-space:pre-wrap;margin:0;background:var(--surface-2);padding:10px;border-radius:8px">${esc(hwText)}</pre>` : `<div class="faint" style="font-size:14px">${backend.lan ? 'On the home WiFi the full checklist prints on the controller’s serial console; the rows above come from its live state.' : 'The rows above come from the last telemetry; "Run check" asks the controller for its own checklist.'}</div>`}
    </div>
    <div class="faint" style="font-size:14px">Every button here goes through the controller’s own interlocks: 90 s pump cap, one valve at a time, pump off = dry run, emergency stop always wins. Frost (${c.minTempC} °C) and the tank reserve only stop watering, not these tests.</div>
  </div>`;
}
function benchLiveStop() {
  if (!isCloud() || !TB.liveUntil) return;
  TB.liveUntil = 0;
  const back = TB.prevIntervalS || 300; TB.prevIntervalS = null;
  cmd('interval', { s: back }, `Readings back to every ${Math.round(back / 60)} min`);
}

function renderSettings() {
  const d = state.device, t = state.telemetry, c = state.config, hh = state.household, loc = Weather.loc(hh);
  const rows = state.pots.map(p => `<tr>
    <td>${esc(potName(p.i))}</td>
    <td><select data-change="plan" data-arg="${p.i}" aria-label="plan for pot ${p.i + 1}">${ruPlanOptions(p.i)}</select></td>
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
    <div class="row"><span class="muted">Valve driver</span><span>${d.havePCA ? 'found' : '<span class="danger-text">MISSING</span>'}</span></div>
    <div class="inline"><div class="field"><label>Telemetry interval</label><select id="interval-s">${[60, 120, 300, 600, 900].map(s => `<option value="${s}" ${d.intervalS === s ? 'selected' : ''}>${s / 60} min</option>`).join('')}</select></div><button class="btn" data-action="interval-set">Apply</button></div>
    <div class="row"><span class="muted">Firmware upload</span>
      <a class="btn" href="http://${esc(d.ip)}/update" target="_blank" rel="noopener">Open upload page</a></div>
    <div class="faint" style="font-size:14px">Opens http://${esc(d.ip)}/update on the controller — home WiFi only, by design. Sign in with user <b>admin</b> and your OTA password, pick the .bin, upload; the board stops the pump, flashes and reboots.</div>
  </div>
  <div class="card section">
    <h2>Fitted hardware &amp; constants</h2>
    <div class="inline"><div class="field"><label>Sensors fitted</label><input type="number" id="fit-sen" min="0" max="16" value="${t.nSensors}"></div><div class="field"><label>Servos fitted</label><input type="number" id="fit-srv" min="0" max="16" value="${t.nServos}"></div><button class="btn" data-action="fit-set">Apply</button></div>
    <div class="inline"><div class="field"><label>Flow (mL/s)</label><input type="number" id="flow" step="0.1" min="0.1" value="${t.mlPerSec}"><span class="hint">30 = free-flow bench value; measure it on the Test bench (Control)</span></div><button class="btn" data-action="flow-set">Apply</button></div>
    <div class="inline"><div class="field"><label>Servo open (µs)</label><input type="number" id="open-us" min="500" max="2500" value="${c.openUs}"></div><div class="field"><label>closed (µs)</label><input type="number" id="closed-us" min="500" max="2500" value="${c.closedUs}"></div><button class="btn" data-action="vlim-set">Apply</button></div>
    <div class="row"><div class="stack"><span>Temperature probe</span><span class="faint" style="font-size:14px">frost interlock below ${c.minTempC} °C</span></div><button class="switch" role="switch" aria-checked="${t.tempEn}" data-action="en" data-what="temp" data-on="${!t.tempEn}"></button></div>
    <div class="row"><div class="stack"><span>Pump</span><span class="faint" style="font-size:14px">off = the whole system is dry-run</span></div><button class="switch" role="switch" aria-checked="${t.pumpEn}" data-action="en" data-what="pump" data-on="${!t.pumpEn}"></button></div>
  </div>
  <div class="card section">
    <div class="row"><h2>Per pot</h2><span class="faint" style="font-size:14px">the plan is applied from the Watering plan screen; switches act at once</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Pot</th><th>Plan</th><th>Sensor</th><th>Valve</th><th>Dry / wet reading</th></tr></thead><tbody>${rows}</tbody></table></div>
    <button class="btn block" data-action="cmd" data-cmd="save" data-label="Save to flash">Save all settings to the controller's flash</button>
  </div>
  <div class="card section">
    <h2>Weather location</h2>
    <div class="inline"><div class="field"><label>Latitude</label><input type="number" id="wx-lat" step="0.01" min="-90" max="90" value="${loc.lat}"></div><div class="field"><label>Longitude</label><input type="number" id="wx-lon" step="0.01" min="-180" max="180" value="${loc.lon}"></div><button class="btn" data-action="wx-loc-set">Save</button></div>
    <div class="btn-row"><button class="btn" data-action="wx-loc-geo">Use my location</button>${hh.weatherLoc ? '<button class="btn ghost" data-action="wx-loc-default">Back to the default</button>' : ''}</div>
    <div class="faint" style="font-size:14px">${hh.weatherLoc ? `Using ${esc(hh.weatherLoc.label || 'your location')}.` : '<b>Default: Oldenburg, Germany</b> — set the balcony’s location once.'} The Weather tile and the forecast the cloud sends to the controller every hour both use it (Open-Meteo, free, no account).</div>
  </div>
  <div class="card section">
    <h2>Household</h2>
    <div class="inline"><div class="field"><label>ntfy.sh topic for push alerts</label><input type="text" id="ntfy" value="${esc(hh.ntfyTopic)}"><span class="hint">Install the ntfy app on every phone and subscribe to this topic.</span></div><button class="btn" data-action="ntfy-set">Save</button></div>
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
    if (!el.dataset.pot || +el.dataset.pot !== sheet.i) { el.dataset.pot = sheet.i; el.innerHTML = `<div class="grip"></div><div id="sheet-live"></div><div id="sheet-hist" class="section chart"></div><div id="sheet-form"></div>`; $('#sheet-form', el).innerHTML = potForm(state.pots[sheet.i]); }
    const live = $('#sheet-live', el);
    if (!(document.activeElement && live.contains(document.activeElement))) live.innerHTML = potLive(state.pots[sheet.i]);   // keep the amount field while it is being typed in
    $('#sheet-hist', el).innerHTML = potHist(state.pots[sheet.i]);
  } else if (sheet.type === 'confirm') {
    delete el.dataset.pot;
    el.innerHTML = `<div class="grip"></div><h3>${esc(sheet.title)}</h3><p class="muted">${esc(sheet.body)}</p>
      <div class="btn-row"><button class="btn" data-action="sheet-close">Cancel</button><button class="btn ${sheet.danger ? 'danger' : 'primary'}" data-action="confirm-go">${esc(sheet.ok)}</button></div>`;
  }
}
// "Water now" preset: the pot's plan dose, or the pot's own dose when it has no plan; sheet.ml = what Theo typed over it.
function waterPreset(p) { ruLoad(); const pl = Rules.planOf(RU.rules, p.i); return pl ? pl.dose : p.doseML; }
function waterML(v) { v = Math.round(+v / 10) * 10; return v >= 10 && v <= 2000 ? v : 0; }
function potLive(p) {
  const st = potState(p), budget = 2 * p.doseML, ml = sheet && sheet.ml > 0 ? sheet.ml : waterPreset(p);
  const last = state.events.find(e => e.ch === p.i && (e.kind === 'dose' || e.kind === 'refused'));
  return `<div class="row top"><div><h3>${esc(potName(p.i))}</h3>${chip(st.cls, st.label)}${p.valEn ? '' : ' ' + chip('off', 'valve off')}</div>
    <div class="kpi" style="text-align:right"><div class="v">${p.pct >= 0 ? p.pct + '<small>%</small>' : '—'}</div><div class="l">moisture reading ${p.raw} · waters below ${p.thrPct} %</div></div></div>
  <div class="bar ${st.cls}" style="margin:10px 0"><i style="width:${p.pct >= 0 ? p.pct : 0}%"></i><b style="left:${p.thrPct}%"></b></div>
  <div class="row faint" style="font-size:14px"><span>valve ${valveText(p)}</span><span>today ${p.todayML} of ${budget} mL allowed</span><span>${p.air > 0 && p.water > 0 ? `dry reading ${p.air} · wet reading ${p.water}` : 'not calibrated'}</span></div>
  ${last ? `<div class="faint" style="font-size:14px;margin-top:6px">last: ${last.kind === 'dose' ? `${esc(last.ml)} mL` : `refused — ${esc(reasonText(last.reason))}`} · ${ago(last.ts)}</div>` : ''}
  <div class="inline" style="margin-top:12px"><div class="field" style="flex:0 0 96px"><label>mL</label><input type="number" id="water-ml" data-input="water-ml" min="10" max="2000" step="10" value="${ml}" aria-label="Amount in millilitres"></div><button class="btn primary" id="water-now" data-action="water-now" data-arg="${p.i}"${dis('water')}>Water now · ${ml} mL</button><button class="btn" data-action="cmd" data-cmd="vtest" data-ch="${p.i}" data-label="Valve test ${p.i + 1}"${dis('vtest')}>Valve test</button></div>
  <div class="faint" style="font-size:14px;margin-top:6px">Controller firmware 0.4.3 or newer honours the amount — older boards water the pot's own dose (${p.doseML} mL).</div>`;
}
function potHist(p) {
  potHistEnsure(p.i);
  const c = HIST.pot[p.i] || {};
  const body = c.data ? (c.data.moisture.length > 1 ? moistureChart(c.data, p.thrPct) : `<div class="faint" style="font-size:14px">${c.data.doses.length ? `${c.data.doses.length} dose${c.data.doses.length > 1 ? 's' : ''} in 14 days, ` : ''}no moisture history yet${c.data.note ? ' — ' + esc(c.data.note) : ''}</div>`)
    : c.err ? `<div class="faint" style="font-size:14px">History could not be loaded: ${esc(c.err)}</div>` : '<div class="faint" style="font-size:14px">loading history…</div>';
  return `<h2>History</h2>${body}`;
}
function potForm(p) {
  return `<div class="section">
    <div class="field"><label>Plan</label><select data-change="plan" data-arg="${p.i}">${ruPlanOptions(p.i)}</select></div>
    <div class="faint" style="font-size:14px">The plan decides when, how dry and how much. Edit plans and apply them on the Watering plan screen (Control).</div>
    <div class="row"><span>Sensor</span><button class="switch" role="switch" aria-checked="${p.senEn}" data-action="en" data-what="s${p.i + 1}" data-on="${!p.senEn}"></button></div>
    <div class="row"><span>Valve</span><button class="switch" role="switch" aria-checked="${p.valEn}" data-action="en" data-what="v${p.i + 1}" data-on="${!p.valEn}"></button></div>
    <div class="field"><label>Name</label><input type="text" value="${esc(state.household.potNames[p.i] || '')}" placeholder="e.g. Basil" data-change="name" data-arg="${p.i}"></div>
  </div>
  <div class="section">
    <h2>Calibration</h2>
    <div class="faint" style="font-size:14px">Blade in air, then in a glass of water. Each records a 64-sample average on the controller. Wet reads lower; a healthy span is several hundred counts.</div>
    <div class="btn-row"><button class="btn" data-action="cmd" data-cmd="cal" data-ch="${p.i}" data-which="air" data-label="Record dry reading ${p.i + 1}">Record dry (in air)</button><button class="btn" data-action="cmd" data-cmd="cal" data-ch="${p.i}" data-which="water" data-label="Record wet reading ${p.i + 1}">Record wet (in water)</button></div>
    <div class="inline"><div class="field"><label>Dry reading</label><input type="number" id="cal-air" min="0" max="4095" value="${p.air > 0 ? p.air : ''}"></div><div class="field"><label>Wet reading</label><input type="number" id="cal-water" min="0" max="4095" value="${p.water > 0 ? p.water : ''}"></div><button class="btn" data-action="cal-type" data-arg="${p.i}">Set</button></div>
    <button class="btn ghost" data-action="cmd" data-cmd="cal" data-ch="${p.i}" data-clear="1" data-label="Clear calibration ${p.i + 1}">Clear calibration</button>
  </div>
  <div class="section"><h2>Valve (bench)</h2><div class="btn-row">${[['o', 'Open'], ['c', 'Close'], ['x', 'Limp']].map(([s, l]) => `<button class="btn sm" data-action="cmd" data-cmd="v" data-ch="${p.i}" data-st="${s}" data-label="Valve ${p.i + 1} ${l.toLowerCase()}"${dis('v')}>${l}</button>`).join('')}</div>
    <div class="faint" style="font-size:14px">An open valve holds ~0.25 A — do not leave it open. Close, then limp; the cam holds it shut.</div></div>`;
}

// ---------------------------------------------------------------- render
function render() {
  const conn = connState(state.device, Date.now());
  const c = $('#conn'); c.className = `conn ${conn}`; c.querySelector('span:last-child').textContent = conn === 'online' ? `online · ${ago(state.device.lastSeen)}` : conn === 'stale' ? `stale · ${ago(state.device.lastSeen)}` : `offline · ${ago(state.device.lastSeen)}`;
  $('#stopbar').hidden = !state.telemetry.pumpRunning;                       // a fixed red STOP on every screen while the pump runs (review A3)
  $('#downbar').hidden = !state.backendDown;                                  // the cloud could not be reached: this is the last known state (review B7)
  const nAlerts = state.alerts.filter(a => a.active && !a.ackedAt).length;
  const badge = $('#badge-alerts'); badge.hidden = !nAlerts; badge.textContent = nAlerts;
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === (screen === 'rules' || screen === 'bench' ? 'control' : screen)));
  const fn = { glance: renderGlance, pots: renderPots, tank: renderTank, alerts: renderAlerts, control: renderControl, settings: renderSettings, rules: renderRules, bench: renderBench }[screen];
  const host = $(`#screen-${screen}`);
  const focused = document.activeElement && host.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (!focused) host.innerHTML = fn();
  SCREENS.forEach(s => $(`#screen-${s}`).classList.toggle('active', s === screen));
  renderSheet();
  if (TB.liveUntil && Date.now() > TB.liveUntil) benchLiveStop();
}
function go(s) { if (screen === 'bench' && s !== 'bench') benchLiveStop(); screen = s; sheet = null; window.scrollTo(0, 0); render(); try { localStorage.setItem('screen', s); } catch (e) { /* private mode */ } }

// ---------------------------------------------------------------- actions
function onClick(e) {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, arg = el.dataset.arg;
  if (el.tagName === 'A') e.preventDefault();
  switch (a) {
    case 'pot': sheet = { type: 'pot', i: +arg }; render(); break;
    case 'sheet-close': sheet = null; render(); break;
    case 'go': go(arg); break;
    case 'cmd': {
      const args = {};
      if (el.dataset.ch != null) args.ch = +el.dataset.ch;
      if (el.dataset.which) args.which = el.dataset.which;
      if (el.dataset.clear) args.clear = true;
      if (el.dataset.st) args.st = el.dataset.st;
      cmd(el.dataset.cmd, args, el.dataset.label); break;
    }
    case 'en': cmd('en', { what: el.dataset.what, on: el.dataset.on === 'true' }, `${enWord(el.dataset.what)} ${el.dataset.on === 'true' ? 'on' : 'off'}`); break;
    case 'ack': backend.ackAlert(arg); break;
    case 'confirm-run': sheet = { type: 'confirm', title: 'Run a round now?', body: 'Senses every pot first, then waters the dry ones one at a time through every interlock. This pumps water.', ok: 'Run round', run: () => cmd('run', {}, 'Run a round') }; render(); break;
    case 'confirm-refill': sheet = { type: 'confirm', title: 'Tank refilled?', body: 'Sets the counter to 25 L. Only do this after actually topping the tank up.', ok: 'Yes, mark full', run: () => cmd('tank', { full: true }, 'Tank full') }; render(); break;
    case 'confirm-stop': sheet = { type: 'confirm', danger: true, title: 'Emergency stop', body: 'Cuts the pump and every servo signal immediately. Closed valves stay closed on the cam; an open one stays open until you close it. Auto mode is not changed.', ok: 'Stop everything', run: () => cmd('stop', {}, 'Emergency stop') }; render(); break;
    case 'confirm-go': { const r = sheet.run; sheet = null; render(); r(); break; }
    case 'tank-set': { const v = num('#tank-ml', 0, state.config.tankFull, 'Tank level in mL'); if (v !== null) cmd('tank', { ml: Math.round(v) }, `Tank ${Math.round(v)} mL`); break; }
    case 'auto-toggle': { const m = state.telemetry.autoMin ? 0 : num('#auto-min', 60, 1440, 'Interval'); if (m !== null) cmd('auto', { min: m }, state.telemetry.autoMin ? 'Auto off' : 'Auto on'); break; }
    case 'auto-set': { const m = num('#auto-min', 60, 1440, 'Interval'); if (m !== null) cmd('auto', { min: m }, 'Auto interval'); break; }
    case 'interval-set': { const v = num('#interval-s', 60, 3600, 'Readings interval in seconds'); if (v !== null) cmd('interval', { s: v }, 'Telemetry interval'); break; }
    case 'fit-set': { const ns = num('#fit-sen', 0, 16, 'Sensors fitted'), nv = ns === null ? null : num('#fit-srv', 0, 16, 'Servos fitted'); if (nv !== null) cmd('fit', { nSensors: Math.round(ns), nServos: Math.round(nv) }, 'Fitted counts'); break; }
    case 'flow-set': { const f = num('#flow', 0.1, 200, 'Flow in mL per second'); if (f !== null) cmd('flow', { mlPerSec: +f.toFixed(1) }, 'Flow'); break; }
    case 'vlim-set': { const o = num('#open-us', 500, 2500, 'Servo open pulse'), c = o === null ? null : num('#closed-us', 500, 2500, 'Servo closed pulse'); if (c !== null) cmd('vlim', { openUs: Math.round(o), closedUs: Math.round(c) }, 'Servo pulses'); break; }
    case 'water-now': {                                                    // the same short confirm as Run round (review A8); the pot sheet comes back behind it
      const i = +arg, v = num('#water-ml', 10, 2000, 'Amount in mL'); if (v === null) break;
      const ml = waterML(v);
      sheet = { type: 'confirm', title: `Water ${potName(i)} now?`, body: `${ml} mL through every interlock — the pot is watered even if it is not dry. This pumps water.`, ok: `Water ${ml} mL`,
        run: () => { sheet = { type: 'pot', i, ml }; render(); cmd('water', { ch: i, ml }, `Water ${potName(i)} · ${ml} mL`); } };
      render(); break;
    }
    case 'cal-type': { const a = num('#cal-air', 0, 4095, 'Dry reading'), w = a === null ? null : num('#cal-water', 0, 4095, 'Wet reading'); if (w !== null) cmd('cal', { ch: +arg, air: Math.round(a), water: Math.round(w) }, `Calibration ${+arg + 1}`); break; }
    case 'ntfy-set': backend.setHousehold({ ntfyTopic: $('#ntfy').value.trim() }); toast('Saved'); break;
    case 'wx-loc-set': { const lat = +$('#wx-lat').value, lon = +$('#wx-lon').value; if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || !lat) { toast('Latitude −90…90, longitude −180…180'); break; } backend.setHousehold({ weatherLoc: { lat: +lat.toFixed(3), lon: +lon.toFixed(3), label: `${lat.toFixed(2)}, ${lon.toFixed(2)}` } }).then(() => toast('Location saved')); break; }
    case 'wx-loc-geo':
      if (!navigator.geolocation) { toast('This browser cannot tell its location'); break; }
      toast('Asking the phone for its location…');
      navigator.geolocation.getCurrentPosition(pos => backend.setHousehold({ weatherLoc: { lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3), label: 'my location' } }).then(() => toast('Location saved')),
        err => toast(`No location: ${err.message}`, 4000), { timeout: 15000, maximumAge: 600e3 });
      break;
    case 'wx-loc-default': backend.setHousehold({ weatherLoc: null }).then(() => toast('Back to Oldenburg (default)')); break;
    case 'hist-days': HIST.days = +arg; render(); break;
    case 'chart-pan': chartPan(screen === 'tank' ? HIST.days : 14, +arg); break;
    case 'tb-pump': { const sec = num('#tb-sec', 1, 30, 'Pump seconds'); if (sec === null) break; TB.lastSec = sec; cmd('p', { sec }, `Pump ${sec} s`); break; }
    case 'tb-flow': { const ml = num('#tb-ml', 1, 5000, 'Millilitres in the jug'); if (ml === null || !TB.lastSec) break; const f = +(ml / TB.lastSec).toFixed(1); cmd('flow', { mlPerSec: f }, `Flow ${f} mL/s`); break; }
    case 'tb-live': { if (!isCloud()) break; TB.prevIntervalS = state.device.intervalS; TB.liveUntil = Date.now() + 5 * 60e3; cmd('interval', { s: 60 }, 'Live readings for 5 minutes'); render(); break; }
    case 'theme': themeApply(arg); render(); break;
    case 'logout': backend.logout().then(() => { if (backend.isMock) toast('Signed out (mock: nothing happens)'); else location.reload(); }); break;
    case 'mock-offline': backend.mock.setOffline(!backend.mock.isOffline()); break;
    case 'mock-dry': backend.mock.dryOut(0); toast('Pot 1 is now dry'); break;
  }
}
function onInput(e) {                                                  // the amount field: the button text follows what is typed
  const el = e.target.closest('[data-input="water-ml"]'); if (!el || !sheet || sheet.type !== 'pot') return;
  const ml = waterML(el.value); if (!ml) return;
  sheet.ml = ml; const b = $('#water-now'); if (b) b.textContent = `Water now · ${ml} mL`;
}
function onChange(e) {
  const el = e.target.closest('[data-change]'); if (!el) return;
  const i = +el.dataset.arg, v = el.value;
  if (el.dataset.change === 'plan') ruSetPot(i, v);
  else if (el.dataset.change === 'name') { const names = { ...state.household.potNames, [i]: v.trim() }; if (!v.trim()) delete names[i]; backend.setHousehold({ potNames: names }); }
}

// ---------------------------------------------------------------- boot
// Login gate (real backend only): resolves once backend.login() succeeded.
function showLogin() {
  const box = $('#login'), form = $('#login-form'), err = $('#login-err');
  box.hidden = false;
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
    err.innerHTML = 'The cloud is not set up yet (no project URL / key in backend.js — see app/SETUP.md). '
      + (location.protocol === 'https:' ? 'Meanwhile: <a href="?backend=mock">the demo</a>.' : 'Meanwhile: <a href="?backend=lan">open the live board on the home WiFi</a> or <a href="?backend=mock">the demo</a>.');   // a page served over https cannot reach http://irrigation.local (mixed content)
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
  const q = new URLSearchParams(location.search), qs = q.get('screen'); if (SCREENS.includes(qs)) screen = qs;
  const qp = q.get('pot'); if (qp !== null && state.pots[+qp]) sheet = { type: 'pot', i: +qp };
  backend.subscribe(s => {
    const top = s.events[0] && s.events[0].id; if (top !== HIST.topEvent) { HIST.topEvent = top; histInvalidate(); }   // a new event = the history changed
    state = s; render();
  });
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', (e) => {                       // ← → pan the chart on Glance / Tank
    if (sheet || !(screen === 'glance' || screen === 'tank') || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'ArrowLeft') { chartPan(screen === 'tank' ? HIST.days : 14, -1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { chartPan(screen === 'tank' ? HIST.days : 14, 1); e.preventDefault(); }
  });
  if (!backend.isMock) Weather.ensure(state.household, render);   // start the forecast fetch now, not on the first Glance paint
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.screen)));
  $('#scrim').addEventListener('click', () => { sheet = null; render(); });
  window.addEventListener('pagehide', benchLiveStop);
  setInterval(render, 15000);            // relative times + freshness
  render();
}
main().catch(e => {
  document.body.innerHTML = `<div class="login"><div class="card" style="max-width:380px;width:100%"><h2>Could not load</h2><p class="muted">${esc(e.message || e)}</p><button class="btn primary block" id="retry">Retry</button></div></div>`;
  $('#retry').addEventListener('click', () => location.reload());
});
