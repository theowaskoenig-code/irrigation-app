// app.js — the UI. Talks only to the backend contract in backend.js.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let backend, state, screen = 'glance', sheet = null, hwText = '';
const SCREENS = ['glance', 'pots', 'tank', 'alerts', 'control', 'settings', 'rules', 'bench'];   // rules = Watering plan, bench = Test bench: full-width screens behind Control
const HIST = { days: 14, data: null, key: '', at: 0, loading: null, err: null, pot: {}, topEvent: null };   // history() cache (charts) + per-pot moisture
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
function nextRound() {
  const t = state.telemetry;
  if (!t.autoMin && !t.nextRoundAt) return { v: 'Auto off', s: 'start a round from Control' };   // the watering plan sets nextRoundAt with auto off
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
function isCloud() { return !backend.isMock && !backend.lan; }

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
    if (rec.status === 'acked') toast(`${label} — done${rec.result && rec.result.ml ? ` (${rec.result.ml} mL, ${rec.result.sec} s)` : rec.result && typeof rec.result.tempC === 'number' ? ` (${rec.result.tempC.toFixed(1)} °C)` : ''}`);
    else if (rec.status === 'expired') toast(`${label} — expired, controller was offline`, 4000);
    else toast(`${label} — refused: ${reasonText(rec.result && rec.result.reason)}`, 4500);
    if (rec.result && rec.result.text) { hwText = rec.result.text; render(); }
    return rec;
  } catch (e) { toast(`${label} — failed: ${e.message}`, 4500); }
}

// ---------------------------------------------------------------- history (charts) — fetched from the backend, cached, refreshed when a new event arrives
function histEnsure(days) {
  const key = `${days}`, stale = HIST.key !== key || Date.now() - HIST.at > 5 * 60e3;
  if (!stale || HIST.loading === key) return;
  HIST.loading = key;
  backend.history(days).then(d => { HIST.data = d; HIST.key = key; HIST.err = null; }).catch(e => { HIST.err = e.message; HIST.key = key; })
    .finally(() => { HIST.at = Date.now(); HIST.loading = null; render(); });
}
function potHistEnsure(i) {
  const c = HIST.pot[i];
  if (c && (c.loading || Date.now() - c.at < 5 * 60e3)) return;
  HIST.pot[i] = { ...(c || {}), loading: true };
  backend.potHistory(i, 14).then(d => { HIST.pot[i] = { data: d, at: Date.now() }; }).catch(e => { HIST.pot[i] = { err: e.message, at: Date.now() }; }).finally(render);
}
function histInvalidate() { HIST.at = 0; Object.keys(HIST.pot).forEach(k => { if (!HIST.pot[k].loading) HIST.pot[k].at = 0; }); }

// ---------------------------------------------------------------- charts (inline SVG, 520 wide)
const CW = 520, CPL = 36, CPR = 14, DAY_MS = 86400e3;
function xAxisLabels(x, from, days, ahead, y) {
  const marks = (days > 14 ? [-21, -14, -7, 0] : [-7, 0]).concat(ahead ? [ahead] : []), today = from + (days - 1) * DAY_MS;
  return marks.filter(d => today + d * DAY_MS >= from).map(d => `<text class="lbl" x="${x(today + d * DAY_MS + DAY_MS / 2).toFixed(1)}" y="${y}" text-anchor="middle">${d > 0 ? `+${d} d` : d ? `−${-d} d` : 'today'}</text>`).join('');
}
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
// Tank level (hourly) over litres dosed per day — one time axis from 14 days back to 2 days ahead, with the weather behind it:
// icons per day along the top, blue bands in rain hours, hatched grey in snow hours, the temperature (measured solid · forecast dashed) on a right-hand axis.
function tankChart(h) {
  const now = Date.now(), SPAN = h.days, AHEAD = 2, wx = chartWeather(), CPR2 = 34;
  const dx = (CW - CPL - CPR2) / (SPAN + AHEAD), icons = wx && dx >= 24, strip = icons ? 24 : 0, top = strip + 8, H1 = 80, gap = 24, H2 = 50, axis = 18, b0 = top + H1 + gap, bottom = b0 + H2;
  const full = state.config.tankFull, t = state.telemetry, t0 = h.from, t1 = h.from + (SPAN + AHEAD) * DAY_MS;
  const x = (ts) => CPL + (ts - t0) / (t1 - t0) * (CW - CPL - CPR2), y1 = (ml) => top + H1 - ml / full * H1, clampX = (ts) => x(Math.min(t1, Math.max(t0, ts)));
  let s = `<defs><pattern id="wxsnow" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="snowline"/></pattern></defs>`;
  // -- weather layers (behind everything)
  s += `<rect class="future" x="${x(now).toFixed(1)}" y="${strip}" width="${(x(t1) - x(now)).toFixed(1)}" height="${bottom - strip}"/>`;
  if (wx) {
    const hrs = wx.hours.filter(p => p.ts + 3600e3 > t0 && p.ts < t1).sort((a, b) => a.ts - b.ts), runs = [];
    hrs.forEach(p => { const snow = wxKind(p.code) === 'snow', last = runs[runs.length - 1]; if (last && last.snow === snow && p.ts - last.end <= 3600e3) last.end = p.ts + 3600e3; else runs.push({ snow, start: p.ts, end: p.ts + 3600e3 }); });
    runs.forEach(r => { s += `<rect class="${r.snow ? 'snowband' : 'rainband'}" x="${clampX(r.start).toFixed(1)}" y="${strip}" width="${Math.max(1.5, clampX(r.end) - clampX(r.start)).toFixed(1)}" height="${bottom - strip}"/>`; });
  }
  // -- temperature on the right axis: forecast min–max band + dashed max ahead, measured hourly line (solid) behind
  const meas = h.temp.filter(p => p.ts >= t0 && p.ts <= now), wxd = wx ? wx.days.filter(d => d.day + DAY_MS > t0 && d.day < t1 && d.tMax !== null && d.tMin !== null) : [];
  const tv = meas.map(p => p.c).concat(wxd.map(d => d.tMax), wxd.map(d => d.tMin));
  if (tv.length) {
    let lo = Math.floor(Math.min(...tv) / 10) * 10, hi = Math.ceil(Math.max(...tv) / 10) * 10; if (hi - lo < 20) hi = lo + 20;
    const yt = (c) => top + H1 - (c - lo) / (hi - lo) * H1, mid = (d) => clampX(d.day + DAY_MS / 2);
    if (wxd.length) {
      s += `<polygon class="tband" points="${wxd.map(d => `${mid(d).toFixed(1)},${yt(d.tMax).toFixed(1)}`).join(' ')} ${wxd.slice().reverse().map(d => `${mid(d).toFixed(1)},${yt(d.tMin).toFixed(1)}`).join(' ')}"/>`;
      const ahead = wxd.filter(d => d.day + DAY_MS > now); if (ahead.length > 1) s += `<path class="tfc" d="${ahead.map((d, i) => `${i ? 'L' : 'M'}${mid(d).toFixed(1)} ${yt(d.tMax).toFixed(1)}`).join(' ')}"/>`;
    }
    if (meas.length > 1) s += `<path class="tmeas" d="${meas.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${yt(p.c).toFixed(1)}`).join(' ')}"/>`;
    const labels = (hi - lo) % 20 === 0 && hi - lo <= 40 ? [lo, (lo + hi) / 2, hi] : [lo, hi];
    labels.forEach(v => { s += `<text class="lbl amb" x="${CW - CPR2 + 5}" y="${(yt(v) + 4).toFixed(1)}">${v}°</text>`; });
    if (strip) s += `<g class="wxi amb" transform="translate(${CW - CPR2 + 8},3)"><path d="M6 2.5a2 2 0 0 1 4 0v6.2a3.5 3.5 0 1 1-4 0z"/><path d="M8 6v5"/><circle cx="8" cy="12" r="1.2"/></g>`;
  }
  // -- tank level and doses (unchanged)
  [0, full / 2, full].forEach(v => { s += `<line class="grid" x1="${CPL}" x2="${CW - CPR2}" y1="${y1(v).toFixed(1)}" y2="${y1(v).toFixed(1)}"/><text class="lbl" x="${CPL - 4}" y="${(y1(v) + 4).toFixed(1)}" text-anchor="end">${v / 1000}</text>`; });
  const pts = h.tank.filter(p => p.ts >= t0 && p.ts <= now);
  let d = '', last = t.tankLeft;
  if (pts.length) { d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y1(p.ml).toFixed(1)}`).join(' '); last = pts[pts.length - 1].ml; d += ` L${x(now).toFixed(1)} ${y1(last).toFixed(1)}`; }
  else d = `M${x(Math.max(t0, now - 3600e3)).toFixed(1)} ${y1(last).toFixed(1)} L${x(now).toFixed(1)} ${y1(last).toFixed(1)}`;
  if (last !== t.tankLeft) d += ` L${x(now).toFixed(1)} ${y1(t.tankLeft).toFixed(1)}`;   // level changed since the last hourly point (a round or a refill just now)
  s += `<path class="tank" d="${d}"/>`;
  h.refills.forEach(ts => { const X = x(ts); s += `<polygon class="refill" points="${(X - 6).toFixed(1)},${top + H1} ${(X + 6).toFixed(1)},${top + H1} ${X.toFixed(1)},${top + H1 - 10}"/><text class="lbl wet" x="${(X < CPL + 60 ? X + 8 : X - 8).toFixed(1)}" y="${top + H1 - 2}" text-anchor="${X < CPL + 60 ? 'start' : 'end'}">refill</text>`; });
  s += `<line class="nowline" x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="${strip}" y2="${bottom}"/>`;
  s += `<circle class="now" cx="${x(now).toFixed(1)}" cy="${y1(t.tankLeft).toFixed(1)}" r="5"/><text class="lbl acc" x="${(x(now) - 8).toFixed(1)}" y="${(y1(t.tankLeft) + (y1(t.tankLeft) + 22 > top + H1 ? -9 : 17)).toFixed(1)}" text-anchor="end">${litres(t.tankLeft)} L</text>`;
  const maxL = Math.max(0.5, ...h.perDay.map(dd => dd.ml / 1000)) * 1.15, y2 = (l) => b0 + H2 - l / maxL * H2, bw = dx * 0.62;
  h.perDay.forEach(dd => { const l = dd.ml / 1000; if (l > 0) s += `<rect class="bar" x="${(x(dd.day + DAY_MS / 2) - bw / 2).toFixed(1)}" y="${y2(l).toFixed(1)}" width="${bw.toFixed(1)}" height="${(l / maxL * H2).toFixed(1)}" rx="1"/>`; });
  s += `<line class="grid" x1="${CPL}" x2="${CW - CPR2}" y1="${bottom}" y2="${bottom}"/><text class="lbl" x="${CPL - 4}" y="${b0 + 3}" text-anchor="end">${maxL.toFixed(1)}</text>`;
  s += xAxisLabels(x, t0, SPAN, AHEAD, bottom + 13);
  // -- the icon strip, one per day, today a little bolder
  if (icons) wx.days.filter(dd => dd.day >= t0 && dd.day < t1).forEach(dd => { const k = wxKind(dd.code); if (k) s += wxIcon(k, x(dd.day + DAY_MS / 2) - 9, 3, 18, dd.day <= now && now < dd.day + DAY_MS ? 'today' : ''); });
  const legend = [wx ? '<svg viewBox="0 0 16 16"><rect class="rainband" x="1" y="3" width="14" height="10"/></svg>rain' : '', wx ? '<svg viewBox="0 0 16 16"><rect class="snowband" x="1" y="3" width="14" height="10"/></svg>snow' : '', tv.length ? '<svg viewBox="0 0 16 16"><path class="tmeas" d="M1 11 L6 5 L10 9 L15 4"/></svg>temperature' : ''].filter(Boolean);
  return `<div class="chead"><span class="l">Tank · L</span><span class="l">Dosed / day · ${SPAN} d</span></div>
  <svg viewBox="0 0 ${CW} ${bottom + axis}" role="img" aria-label="Tank level, litres dosed per day and the weather over ${SPAN} days and ${AHEAD} days ahead">${s}</svg>
  ${legend.length ? `<div class="wxlegend">${legend.join('<span>·</span>')}</div>` : ''}`;
}
// Temperature, hourly, over the same span.
function tempChart(h) {
  const top = 8, H = 70, axis = 18, t0 = h.from, t1 = h.from + h.days * DAY_MS, pts = h.temp.filter(p => p.ts >= t0);
  if (pts.length < 2) return `<div class="chead"><span class="l">Temperature · °C</span></div><div class="faint" style="font-size:14px">no temperature history yet</div>`;
  const lo = Math.floor(Math.min(0, ...pts.map(p => p.c)) / 5) * 5, hi = Math.ceil(Math.max(10, ...pts.map(p => p.c)) / 5) * 5;
  const x = (ts) => CPL + (ts - t0) / (t1 - t0) * (CW - CPL - CPR), y = (c) => top + H - (c - lo) / (hi - lo) * H;
  let s = '';
  [lo, hi].forEach(v => { s += `<line class="grid" x1="${CPL}" x2="${CW - CPR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="lbl" x="${CPL - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`; });
  const f = state.config.minTempC; if (f > lo) s += `<line class="floor" x1="${CPL}" x2="${CW - CPR}" y1="${y(f).toFixed(1)}" y2="${y(f).toFixed(1)}"/><text class="lbl" x="${CW - CPR}" y="${(y(f) - 3).toFixed(1)}" text-anchor="end">frost ${f} °C</text>`;
  s += `<path class="temp" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.c).toFixed(1)}`).join(' ')}"/>`;
  s += xAxisLabels(x, t0, h.days, 0, top + H + 13);
  return `<div class="chead"><span class="l">Temperature · °C</span><span class="l">${Math.min(...pts.map(p => p.c)).toFixed(1)} – ${Math.max(...pts.map(p => p.c)).toFixed(1)} °C</span></div>
  <svg viewBox="0 0 ${CW} ${top + H + axis}" role="img" aria-label="Temperature over ${h.days} days">${s}</svg>`;
}
// One pot's moisture (hourly) with its threshold and a marker at every dose.
function moistureChart(ph, thrPct) {
  const now = Date.now(), days = ph.days, top = 8, H = 80, axis = 18, d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime() - (days - 1) * DAY_MS, t1 = t0 + days * DAY_MS;
  const x = (ts) => CPL + (ts - t0) / (t1 - t0) * (CW - CPL - CPR), y = (p) => top + H - p / 100 * H, pts = ph.moisture.filter(p => p.ts >= t0);
  let s = '';
  [0, 50, 100].forEach(v => { s += `<line class="grid" x1="${CPL}" x2="${CW - CPR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="lbl" x="${CPL - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`; });
  s += `<line class="floor" x1="${CPL}" x2="${CW - CPR}" y1="${y(thrPct).toFixed(1)}" y2="${y(thrPct).toFixed(1)}"/><text class="lbl" x="${CW - CPR}" y="${(y(thrPct) - 3).toFixed(1)}" text-anchor="end">water below ${thrPct} %</text>`;
  if (pts.length > 1) s += `<path class="moist" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.pct).toFixed(1)}`).join(' ')}"/>`;
  ph.doses.filter(d => d.ts >= t0).forEach(d => { const X = x(d.ts); s += `<polygon class="dose" points="${(X - 5).toFixed(1)},${top + H + 2} ${(X + 5).toFixed(1)},${top + H + 2} ${X.toFixed(1)},${top + H - 8}"><title>${d.ml} mL · ${esc(when(d.ts))}</title></polygon>`; });
  s += xAxisLabels(x, t0, days, 0, top + H + 14);
  return `<div class="chead"><span class="l">Moisture · % · ${days} d</span><span class="l">▲ = a dose (${ph.doses.length})</span></div>
  <svg viewBox="0 0 ${CW} ${top + H + axis}" role="img" aria-label="Moisture over ${days} days with doses">${s}</svg>`;
}
function chartBox(days, fn) {
  histEnsure(days);
  const h = HIST.data && HIST.data.days === days ? HIST.data : null;
  if (!h) return HIST.err ? `<div class="faint" style="font-size:14px">History could not be loaded: ${esc(HIST.err)}</div>` : '<div class="faint" style="font-size:14px">loading history…</div>';
  return fn(h) + (h.note ? `<div class="faint" style="font-size:13px;margin-top:4px">${esc(h.note)}</div>` : '');
}

// ---------------------------------------------------------------- weather tile (Glance) — display only
function weatherTile() {
  const hh = state.household, loc = Weather.loc(hh), t = state.telemetry;
  let fc;
  if (backend.isMock) fc = Weather.fake(t);
  else { fc = Weather.get(hh); Weather.ensure(hh, render); }
  const err = backend.isMock ? null : Weather.error(hh);
  const ctl = t.rainPct !== undefined && t.rainPct !== null && t.wxAgeS !== undefined ? `<br>controller has ${t.rainPct} % · ${ago(Date.now() - t.wxAgeS * 1000)}` : '';
  if (!fc) return `<div class="w"><div class="l">Weather · ${esc(loc.label || 'set in Settings')}</div><div class="v">—</div><div class="s">${err ? 'weather unavailable' : 'loading the forecast…'}</div></div>`;
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
      <div class="h"><span class="n"><i>${p.i + 1}</i>${esc(name || 'Pot ' + (p.i + 1))}</span><span class="p">${p.pct >= 0 ? p.pct + ' %' : '—'}</span></div>
      <div class="bar"><i style="width:${pct}%"></i>${st.cls === 'dry' || st.cls === 'wet' ? `<b style="left:${p.thrPct}%"></b>` : ''}</div>
      <div class="s">${chip(st.cls, st.label)}<span class="faint">${fitted && !p.valEn ? '□ valve off' : p.todayML ? p.todayML + ' mL today' : (p.vState === V_STATE.OPEN ? 'valve open' : '')}</span></div>
    </button>`;
  }).join('');
  return `${banner}<div class="wgrid ${conn !== 'online' ? 'stale' : ''}">
    <div class="w x2 chart">${chartBox(14, tankChart)}</div>
    <div class="w x2"><div class="l" style="margin-bottom:${active.length ? 8 : 0}px">${active.length ? `Needs a human · ${active.length}` : 'Alerts'}</div>
      <div class="astrip">${active.length ? active.map(a => `<div class="a ${a.severity}"><div class="t">${SYM[a.severity] || ''} ${esc(a.message)}</div><div class="m">${ago(a.ts)}${a.ch != null ? ` · <a href="#" data-action="pot" data-arg="${a.ch}">open ${esc(potName(a.ch))}</a>` : ''} · <a href="#" data-action="ack" data-arg="${a.id}">acknowledge</a></div></div>`).join('') : '<div class="s">Nothing needs a human right now.</div>'}</div></div>
    <div class="w"><div class="l">Tank</div><div class="v">${litres(t.tankLeft)}<small>L</small></div><div class="s">${d == null ? 'no history yet' : `<b>${d < 1 ? '< 1 day' : Math.floor(d) + (d >= 2 ? ' days' : ' day')}</b> left`} · ${Math.round(100 * t.tankLeft / c.tankFull)} % full</div></div>
    <div class="w"><div class="l">Temperature</div><div class="v">${t.tempEn && t.tempOK ? t.tempC.toFixed(1) + '<small>°C</small>' : '—'}</div><div class="s">${!t.tempEn ? 'probe switched off' : !t.tempOK ? '<b class="danger-text">no reading from the probe</b> — check red → 5 V, yellow → GPIO8, 4.7 kΩ' : (t.tempC < c.minTempC ? '<b class="danger-text">frost — watering suspended</b>' : 'no frost · watering allowed')}</div></div>
    ${weatherTile()}
    <div class="w"><div class="l">Pump · Auto</div><div class="v mid">${t.pumpRunning ? chip('open', 'pump running') : 'Idle'}</div><div class="s">${t.rulesHash ? 'Watering plan' : t.autoMin ? `Auto every ${autoText(t.autoMin)}` : 'Auto off'} · ${t.pumpEn ? 'ready' : '<b class="danger-text">pump switched OFF</b>'}</div></div>
    <div class="w"><div class="l">Next round</div><div class="v mid">${nr.v}</div><div class="s">${nr.s}</div></div>
    <div class="w x2"><div class="l">Last round${lr ? ` · ${ago(lr.ts)}` : ''}</div><div class="s" style="font-size:18px;margin-top:2px">${lr ? `<b>${lr.watered} watered</b> · ${lr.skipped} skipped${lr.skippedBy ? ` (the plan skipped it: ${esc(lr.skippedBy)})` : ''} · ${lr.refused ? `<b class="danger-text">${lr.refused} refused</b>` : 'none refused'}` : 'no round yet'}</div></div>
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
    <button class="btn primary block" data-action="confirm-refill">Refilled — mark tank full</button>
    <div class="inline"><div class="field"><label>Or set the level by hand (mL)</label><input type="number" id="tank-ml" min="0" max="${c.tankFull}" step="250" placeholder="${t.tankLeft}"></div><button class="btn" data-action="tank-set">Set</button></div>
  </div>
  <div class="card"><h2>Refills</h2><div class="list">${refills.length ? refills.map(e => `<div class="row"><span>${whenDate(e.ts)}</span><span class="muted">${litres(e.tankLeft)} L</span></div>`).join('') : '<div class="empty">No refills recorded</div>'}</div></div>`;
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
  <div class="faint" style="font-size:14px;margin-top:12px">You are alerted when: tank &lt; 20 % · tank at reserve · a pot is refused (implausible / uncalibrated / budget) · frost &lt; 3 °C · controller silent &gt; ${3 * state.device.intervalS / 60} min · a dose hits the 90 s pump cap · emergency stop. Push goes to ntfy topic <span class="mono">${esc(state.household.ntfyTopic)}</span>.</div>`;
}

function renderControl() {
  const t = state.telemetry, cmds = state.commands.filter(c => c.cmd !== 'weather').slice(0, 8);   // the hourly weather push is bookkeeping, not something Theo sent
  const st = (c) => c.status === 'acked' ? 'done' : c.status === 'failed' ? `refused · ${reasonText(c.result && c.result.reason)}` : c.status;
  return `
  <div class="card">
    <div class="row"><div class="kpi"><div class="v" style="font-size:22px">${t.pumpRunning ? '<span class="tag open">PUMP RUNNING</span>' : 'Pump idle'}</div><div class="l">${t.pumpEn ? 'enabled' : 'switched OFF — nothing waters'}</div></div>
      <button class="btn" data-action="cmd" data-cmd="pstop" data-label="Pump stop" ${t.pumpRunning ? '' : 'disabled'}>Stop pump</button></div>
  </div>
  <div class="card section">
    <div class="row"><div class="stack"><strong>Auto mode</strong><span class="faint" style="font-size:14px">rounds run from the controller's own timer, cloud or no cloud${t.rulesHash ? ' — the watering plan’s times take over while it is applied' : ''}</span></div>
      <button class="switch" role="switch" aria-checked="${t.autoMin > 0}" data-action="auto-toggle"></button></div>
    <div class="inline"><div class="field"><label>Interval</label><select id="auto-min">${[60, 120, 180, 360, 720, 1440].map(m => `<option value="${m}" ${t.autoMin === m || (!t.autoMin && m === 360) ? 'selected' : ''}>${m >= 60 ? m / 60 + ' h' : m + ' min'}</option>`).join('')}</select></div><button class="btn" data-action="auto-set">Apply</button></div>
  </div>
  <div class="card section">
    <button class="btn primary block" data-action="cmd" data-cmd="run" data-label="Run a round">Run a round now</button>
    <div class="btn-row"><button class="btn" data-action="cmd" data-cmd="refresh" data-label="Refresh readings">Refresh readings</button><button class="btn" data-action="go" data-arg="bench">Test the hardware</button></div>
    <button class="btn danger block" data-action="confirm-stop">Emergency stop</button>
    <div class="faint" style="font-size:14px">A round senses all pots first (pump off, valves limp), then waters dry pots one at a time through every interlock. Emergency stop cuts the pump and all servo PWM; closed valves stay closed on the cam.</div>
  </div>
  ${rulesCard()}
  <div class="card"><h2>Commands</h2><div class="list">${cmds.length ? cmds.map(c => `<div class="cmd"><span>${esc(c.cmd)}${c.args && Object.keys(c.args).length && c.cmd !== 'rules' ? ` <span class="faint mono">${esc(JSON.stringify(c.args))}</span>` : ''}</span><span class="st ${c.status}">${st(c)} · ${ago(c.ackedAt || c.createdAt)}</span></div>`).join('') : '<div class="empty">No commands yet</div>'}</div></div>`;
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
  const sensors = state.pots.filter(p => p.i < t.nSensors).map(p => { const st = potState(p); return `<div class="tb-tile ${st.cls}"><span class="n">${esc(potName(p.i))}</span><span class="v">${p.pct >= 0 ? p.pct + ' %' : SYM[st.cls]}</span><span class="r">${p.senEn ? `raw ${p.raw}` : 'off'}</span></div>`; }).join('');
  const valves = state.pots.filter(p => p.i < t.nServos).map(p => `<div class="tb-valve"><div class="stack"><strong>${esc(potName(p.i))}</strong><span class="faint" style="font-size:14px">${p.valEn ? valveText(p) : 'switched off'}</span></div>
    <div class="btn-row">${[['o', 'Open'], ['c', 'Close'], ['x', 'Limp']].map(([s, l]) => `<button class="btn sm" data-action="cmd" data-cmd="v" data-ch="${p.i}" data-st="${s}" data-label="Valve ${p.i + 1} ${l.toLowerCase()}">${l}</button>`).join('')}<button class="btn sm" data-action="cmd" data-cmd="vtest" data-ch="${p.i}" data-label="Valve test ${p.i + 1}">Test</button></div></div>`).join('');
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
      <button class="btn block" data-action="cmd" data-cmd="vall" data-st="c" data-label="Close all valves">Close all, then limp</button>
      <div class="faint" style="font-size:14px">An open valve holds ~0.25 A — open ONE at a time and close it again. Test = open 1 s, close, limp. Limp cuts the signal; the cam keeps a closed valve shut.</div>
    </div>
    <div class="card section">
      <h2>Pump</h2>
      <div class="row"><div class="stack"><span>Pump enabled</span><span class="faint" style="font-size:14px">${t.pumpEn ? 'on — the pump may run' : 'off — every dose and test is a dry run'}</span></div><button class="switch" role="switch" aria-checked="${t.pumpEn}" data-action="en" data-what="pump" data-on="${!t.pumpEn}"></button></div>
      <div class="inline"><div class="field"><label>Run for</label><select id="tb-sec">${[1, 2, 3, 5, 10, 15, 20, 30].map(s => `<option value="${s}" ${s === TB.lastSec ? 'selected' : ''}>${s} s</option>`).join('')}</select></div><button class="btn primary tb-big" style="flex:2" data-action="tb-pump">Run pump</button></div>
      <button class="btn danger block tb-big" data-action="cmd" data-cmd="pstop" data-label="Pump stop">STOP</button>
      ${t.pumpRunning ? `<div>${chip('open', 'pump running')}</div>` : ''}
      ${flowNote}
    </div>
    <div class="card section">
      <div class="row"><h2>Hardware check</h2><button class="btn sm" data-action="cmd" data-cmd="hwcheck" data-label="Hardware check">Run check</button></div>
      <div class="list">
        <div class="row"><span>PCA9685 (valve driver)</span><span>${d.havePCA ? '● found' : '<span class="danger-text">✕ MISSING</span>'}</span></div>
        <div class="row"><span>Temperature probe</span><span>${!t.tempEn ? '— off' : t.tempOK ? '● answers' : '<span class="danger-text">✕ no answer</span>'}</span></div>
        <div class="row"><span>Sensors plausible</span><span>${nPlaus} of ${plaus.length}${plaus.length - nPlaus ? ` — <span class="danger-text">${plaus.filter(p => p.sState !== S_STATE.OK).map(p => p.i + 1).join(', ')}</span>` : ''}</span></div>
        <div class="row"><span>Pump gate</span><span>${t.pumpRunning ? '<span class="tag open">● ON</span>' : '— low (off)'}</span></div>
      </div>
      ${hwText ? `<pre class="mono" style="white-space:pre-wrap;margin:0;background:var(--surface-2);padding:10px;border-radius:8px">${esc(hwText)}</pre>` : `<div class="faint" style="font-size:14px">${backend.lan ? 'On the home WiFi the full checklist prints on the controller’s serial console; the rows above come from its live state.' : 'The rows above come from the last telemetry; "Run check" asks the controller for its own checklist.'}</div>`}
    </div>
    <div class="card section">
      <div class="row"><div class="stack"><span>Status LED</span><span class="faint" style="font-size:14px">not fitted on Rev A4 — the firmware still has the switch</span></div><button class="switch" role="switch" aria-checked="${t.ledEn}" data-action="en" data-what="led" data-on="${!t.ledEn}"></button></div>
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
    <div class="inline"><div class="field"><label>Flow (mL/s)</label><input type="number" id="flow" step="0.1" min="0.1" value="${t.mlPerSec}"><span class="hint">30 = free-flow bench value; measure it on the Test bench (Control)</span></div><button class="btn" data-action="flow-set">Apply</button></div>
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
    $('#sheet-live', el).innerHTML = potLive(state.pots[sheet.i]);
    $('#sheet-hist', el).innerHTML = potHist(state.pots[sheet.i]);
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
function potHist(p) {
  potHistEnsure(p.i);
  const c = HIST.pot[p.i] || {};
  const body = c.data ? (c.data.moisture.length > 1 ? moistureChart(c.data, p.thrPct) : `<div class="faint" style="font-size:14px">${c.data.doses.length ? `${c.data.doses.length} dose${c.data.doses.length > 1 ? 's' : ''} in 14 days, ` : ''}no moisture history yet${c.data.note ? ' — ' + esc(c.data.note) : ''}</div>`)
    : c.err ? `<div class="faint" style="font-size:14px">History could not be loaded: ${esc(c.err)}</div>` : '<div class="faint" style="font-size:14px">loading history…</div>';
  return `<h2>History</h2>${body}`;
}
function potForm(p) {
  return `<div class="section">
    <div class="inline"><div class="field"><label>Water below (%)</label><input type="number" min="1" max="99" value="${p.thrPct}" data-change="thr" data-arg="${p.i}"></div>
      <div class="field"><label>Dose (mL)</label><select data-change="dose" data-arg="${p.i}"><option value="250" ${p.doseML === 250 ? 'selected' : ''}>250 · small pot</option><option value="900" ${p.doseML === 900 ? 'selected' : ''}>900 · large pot</option>${[250, 900].includes(p.doseML) ? '' : `<option value="${p.doseML}" selected>${p.doseML}</option>`}</select></div></div>
    <div class="faint" style="font-size:14px">A value set here is this pot's own; the watering plan's defaults leave it alone.</div>
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
    case 'wx-loc-set': { const lat = +$('#wx-lat').value, lon = +$('#wx-lon').value; if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || !lat) { toast('Latitude −90…90, longitude −180…180'); break; } backend.setHousehold({ weatherLoc: { lat: +lat.toFixed(3), lon: +lon.toFixed(3), label: `${lat.toFixed(2)}, ${lon.toFixed(2)}` } }).then(() => toast('Location saved')); break; }
    case 'wx-loc-geo':
      if (!navigator.geolocation) { toast('This browser cannot tell its location'); break; }
      toast('Asking the phone for its location…');
      navigator.geolocation.getCurrentPosition(pos => backend.setHousehold({ weatherLoc: { lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3), label: 'my location' } }).then(() => toast('Location saved')),
        err => toast(`No location: ${err.message}`, 4000), { timeout: 15000, maximumAge: 600e3 });
      break;
    case 'wx-loc-default': backend.setHousehold({ weatherLoc: null }).then(() => toast('Back to Oldenburg (default)')); break;
    case 'hist-days': HIST.days = +arg; render(); break;
    case 'tb-pump': { const sec = +$('#tb-sec').value; TB.lastSec = sec; cmd('p', { sec }, `Pump ${sec} s`); break; }
    case 'tb-flow': { const ml = +$('#tb-ml').value; if (!(ml > 0) || !TB.lastSec) { toast('Type the measured millilitres first'); break; } const f = +(ml / TB.lastSec).toFixed(1); cmd('flow', { mlPerSec: f }, `Flow ${f} mL/s`); break; }
    case 'tb-live': { if (!isCloud()) break; TB.prevIntervalS = state.device.intervalS; TB.liveUntil = Date.now() + 5 * 60e3; cmd('interval', { s: 60 }, 'Live readings for 5 minutes'); render(); break; }
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
  const q = new URLSearchParams(location.search), qs = q.get('screen'); if (SCREENS.includes(qs)) screen = qs;
  const qp = q.get('pot'); if (qp !== null && state.pots[+qp]) sheet = { type: 'pot', i: +qp };
  backend.subscribe(s => {
    const top = s.events[0] && s.events[0].id; if (top !== HIST.topEvent) { HIST.topEvent = top; histInvalidate(); }   // a new event = the history changed
    state = s; render();
  });
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.screen)));
  $('#scrim').addEventListener('click', () => { sheet = null; render(); });
  window.addEventListener('pagehide', benchLiveStop);
  setInterval(render, 15000);            // relative times + freshness
  render();
}
main().catch(e => { document.body.innerHTML = `<pre style="padding:16px">${esc(e.stack || e)}</pre>`; });
