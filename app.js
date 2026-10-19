// app.js — the Balcony UI: one page (chart + pump-station spider) and four sheets (pot · tank · plans · run). No prose: labels, numbers, icons.
// Talks only to the backend object from backend.js (mock / lan / supabase). Pictures follow app/design/redraft-round2.html and merged-home-mockups.html.
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let backend, state, sheet = null, chartOff = 0;
let find = null;   // Find sensor: { step 0 | 1 | 2, a, b (refresh reads), hit } — shown under the station buttons
const busy = new Set();                       // in-flight commands, keyed per pot/command ('valve:3', 'water:3', 'run' …)
const H = {};                                 // history cache: key → { data, at, loading, err }
const CH_DAYS = 16, CH_AHEAD = 2, CH_BACK = 92, CH_FWD = 7;

// ---------------------------------------------------------------- small helpers
const pad = (n) => String(n).padStart(2, '0');
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const whenLabel = (ms) => (dayStart(ms, 0) === dayStart(Date.now(), 0) ? hm(ms) : `${WD[new Date(ms).getDay()]} ${hm(ms)}`);
const litres = (ml) => (ml / 1000).toFixed(1);
const clone = (o) => JSON.parse(JSON.stringify(o));
function ago(ts) { if (!ts) return '—'; const s = Math.max(0, (Date.now() - ts) / 1000); return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; }
const potName = (ch) => state.potNames[ch] || `Pot ${ch + 1}`;
const potLabel = (ch) => `${ch + 1} · ${esc(potName(ch))}`;
const EMOJI_DEFAULT = '🪴', WET_DEFAULT = 80;
const EMOJIS = ['🪴', '🍅', '🌶️', '🫑', '🥒', '🍓', '🫐', '🍋', '🌿', '🌱', '🥬', '🧅', '🌸', '🌻', '🌷', '🌵'];
const lookOf = (ch) => (state.potLook && state.potLook[ch]) || {};
const potEmoji = (ch) => lookOf(ch).e || EMOJI_DEFAULT;
const wetOf = (ch) => (Number.isFinite(lookOf(ch).wet) ? lookOf(ch).wet : WET_DEFAULT);
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const planOfCh = (ch) => (state.rules ? Rules.planOf(state.rules, ch) : null);
const thrOfCh = (ch) => (planOfCh(ch) ? Rules.thrOf(Rules.potSet(state.rules, ch)) : null);   // the pot's "dry below" line while it is on a plan
const nowOf = (ch) => (Number.isInteger(lookOf(ch).now) ? lookOf(ch).now : 250);              // the pot's Water now amount (household, app only)
const fitted = (c) => c.valEn || c.senEn;
const firstValve = () => Math.max(0, state.ch.findIndex(c => c.valEn));
const ctx = () => ({ maxDoseML: state.t.maxDoseML || 0, tankLeft: state.t.tankLeft, tankReserve: state.t.tankReserve, frost: frostBlocks(state.t), rainTodayMM: rainToday(state.t) });
// What a pot looks like now: run · nos (no sensor) · bad (implausible) · uncal · dry · wet (above its wet level) · ok
function look(ch) {
  const c = state.ch[ch], r = state.t.running;
  if (r && r.ch === ch) return 'run';
  const w = Rules.sensorWhy(c);
  if (w) return w === 'nosensor' ? 'nos' : w === 'implausible' ? 'bad' : 'uncal';
  const thr = thrOfCh(ch);
  if (thr !== null && c.pct < thr) return 'dry';
  return c.pct > wetOf(ch) ? 'wet' : 'ok';
}
const LOOK = { run: ['run', 'watering'], nos: ['nos', 'no sensor'], bad: ['bad', '✕ sensor'], uncal: ['nos', '? uncal'], dry: ['dry', '▲ dry'], wet: ['wet', '▼ wet'], ok: ['ok', '● ok'] };
const chip = (k) => `<span class="chip ${LOOK[k][0]}">${LOOK[k][1]}</span>`;
function sensorChip(c) {
  if (!c.senEn || c.sState === 1) return '<span class="chip nos">none</span>';
  if (c.sState === 2) return '<span class="chip bad">implausible</span>';
  if (c.sState === 3) return '<span class="chip nos">not calibrated</span>';
  return '<span class="chip ok">● steady</span>';
}
function active() { const t = state.t; return t.pumpRunning || !!t.running || t.queue.length > 0 || [...busy].some(k => /^(valve|valves_all|water|run|pump|ptest)/.test(k)); }

let toastTimer;
function toast(msg, ms) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2800); }

// ---------------------------------------------------------------- commands
async function cmd(name, args, key, label, quiet) {
  key = key || name;
  if (name !== 'stop' && busy.has(key)) return null;
  busy.add(key); render();
  const slow = setTimeout(() => toast(`${label} …`), 60000);
  try {
    const rec = await backend.sendCommand(name, args || {}), r = rec.result || {};
    if (rec.status === 'acked') { if (!quiet) toast(name === 'water' ? `${label} · ${r.ml_pumped ?? '?'} mL ✓` : name === 'run' ? `${label} ✓ · 💧 ${r.watered ?? '–'} · ● ${r.skipped ?? '–'} · ✕ ${r.refused ?? '–'}` : `${label} ✓`); }
    else if (rec.status === 'sent' || rec.status === 'queued') toast(`${label} …`);
    else toast(`${label} ✕ ${reasonText(rec.status === 'expired' ? 'expired' : r.reason)}${r.reason === 'too_much' && r.maxDoseML ? ` · max ${r.maxDoseML} mL` : ''}${r.detail ? ` · ${r.detail}` : ''}`, 4000);
    return rec;
  } catch (e) { toast(`${label} ✕ ${reasonText('transport')}`, 4000); return null; }
  finally { clearTimeout(slow); busy.delete(key); invalidate(); render(); }
}
const dis = (key) => (busy.has(key) ? ' disabled' : '');
const intOf = (sel) => { const el = $(sel), v = el && el.value.trim() !== '' ? Math.round(+el.value) : NaN; return Number.isFinite(v) && v > 0 ? v : null; };
// The board answers with the hash of what it stored: a different hash = it kept something else (fw ≤ 0.8.0 dropped pot/pots sent over the cloud).
async function sendRules(doc) {
  const rec = await cmd('rules', Rules.normalize(doc), 'rules', 'Plan', true), want = Rules.hash(Rules.compile(doc));
  if (rec && rec.status === 'acked') toast(rec.result && rec.result.rulesHash && rec.result.rulesHash !== want ? '✕ Plan · the board kept another version' : 'Plan ✓', 4000);
  return rec && rec.status === 'acked' && rec.result && rec.result.rulesHash && rec.result.rulesHash !== want ? { ...rec, status: 'failed' } : rec;
}

// ---------------------------------------------------------------- history cache
function hist(key, fn) {
  const c = H[key];
  if (!c || (!c.loading && Date.now() - c.at > 5 * 60e3)) {
    H[key] = { ...(c || {}), loading: true };
    fn().then(d => { H[key] = { data: d, at: Date.now() }; }).catch(e => { H[key] = { data: c && c.data, err: e.message, at: Date.now() }; }).finally(() => render());
  }
  return H[key].data || null;
}
function invalidate() { Object.values(H).forEach(c => { if (!c.loading) c.at = 0; }); }

// ---------------------------------------------------------------- drawings
function valveSvg(vState, w) {
  w = w || 30; const h = Math.round(w * 0.55);
  if (vState === 2) return `<svg width="${w}" height="${h}" viewBox="0 0 30 16" role="img" aria-label="open"><rect x="1" y="4" width="28" height="8" rx="4" fill="var(--wet)" stroke="var(--accent)" stroke-width="2"/><path d="M6 8h18" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round" class="flowline"/></svg>`;
  if (vState === 1) return `<svg width="${w}" height="${h}" viewBox="0 0 30 16" role="img" aria-label="closed"><path d="M2 4h10l3 4 3-4h10M2 12h10l3-4 3 4h10" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linejoin="round"/></svg>`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 30 16" role="img" aria-label="unknown"><rect x="1" y="4" width="28" height="8" rx="4" fill="none" stroke="var(--border-2)" stroke-width="2" stroke-dasharray="3 2"/><text x="15" y="11.5" text-anchor="middle" font-size="8" fill="var(--text-3)">?</text></svg>`;
}
function wxIcon(code, x, y) {
  const cloud = (dx, dy, col) => `<g fill="${col}" transform="translate(${dx} ${dy})"><circle cx="6" cy="7" r="4"/><circle cx="11" cy="5" r="5"/><circle cx="15" cy="8" r="3.5"/><rect x="5" y="7" width="12" height="4.5" rx="2"/></g>`;
  let g;
  if (code === 0) g = '<circle cx="9" cy="8" r="4.5" fill="var(--sun)"/><g stroke="var(--sun)" stroke-width="1.5" stroke-linecap="round"><path d="M9 0.5v2M9 13.5v2M1.5 8h2M14.5 8h2M3.7 2.7l1.4 1.4M12.9 11.9l1.4 1.4M3.7 13.3l1.4-1.4M12.9 4.1l1.4-1.4"/></g>';
  else if (code <= 2) g = `<circle cx="7" cy="6" r="4" fill="var(--sun)"/>${cloud(1, 3, 'var(--text-3)')}`;
  else if (code <= 48) g = cloud(0, 2, 'var(--text-3)');
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) g = `${cloud(0, 0, 'var(--text-3)')}<g fill="var(--wet)"><circle cx="7" cy="15" r="1.3"/><circle cx="11" cy="16" r="1.3"/><circle cx="15" cy="15" r="1.3"/></g>`;
  else g = `${cloud(0, 0, 'var(--text-3)')}<path d="M7 14l-1 3M11 14l-1 3M15 14l-1 3" stroke="var(--wet)" stroke-width="1.6" stroke-linecap="round"/>`;
  return `<g transform="translate(${x.toFixed(1)} ${y})">${g}</g>`;
}
const tCls = (t) => (t < 15 ? 'var(--cool)' : t <= 25 ? 'var(--mild)' : 'var(--hot)');
function weatherDays() {
  if (backend.isMock) return backend.weatherChart().days;
  Weather.ensure(state.weatherLoc, () => render());
  const w = Weather.get(state.weatherLoc); return w ? w.days : [];
}

// ---------------------------------------------------------------- Home: chart (variant C, no tank line)
const CW = 360, CL = 24, CR = 20;
function chartCard() {
  const endOff = chartOff - CH_AHEAD, h = hist(`chart:${endOff}`, () => backend.history(CH_DAYS, endOff));
  const from = dayStart(Date.now(), -(endOff + CH_DAYS - 1)), fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const minOff = CH_AHEAD - CH_FWD, maxOff = CH_BACK - CH_DAYS + 1 + CH_AHEAD;
  return `<div class="card"><div class="cpan"><button class="btn sm" data-a="pan" data-v="-1" ${chartOff >= maxOff ? 'disabled' : ''} aria-label="week back">◀</button><span class="range">${fmt(from)} – ${fmt(dayStart(from, CH_DAYS - 1))}</span><button class="btn sm" data-a="pan" data-v="0" ${chartOff === 0 ? 'disabled' : ''}>Today</button><button class="btn sm" data-a="pan" data-v="1" ${chartOff <= minOff ? 'disabled' : ''} aria-label="week ahead">▶</button></div>
  ${chartSvg(h, from)}
  <div class="legend"><span><span class="sw" style="background:var(--accent)"></span>L/day</span><span><span class="sw" style="background:var(--wet);opacity:.4"></span>rain</span><span><span class="sw" style="background:var(--cool)"></span><span class="sw" style="background:var(--mild)"></span><span class="sw" style="background:var(--hot)"></span>&lt;15 · 15–25 · &gt;25 °C</span></div></div>`;
}
function chartSvg(h, from) {
  const N = CH_DAYS, dx = (CW - CL - CR) / N, x = (i) => CL + i * dx, mid = (i) => x(i) + dx / 2, today = dayStart(Date.now(), 0);
  const P0 = 68, PH = 110, P1 = P0 + PH, wx = {}; weatherDays().forEach(d => { wx[d.day] = d; });
  const per = h ? h.perDay : [], days = []; for (let i = 0; i < N; i++) days.push(dayStart(from, i));
  const ti = days.indexOf(today);
  let s = ti >= 0 ? `<rect x="${x(ti)}" y="0" width="${dx}" height="${P1}" fill="var(--accent-soft)"/>` : '';
  for (let i = 1; i < N; i++) s += `<line x1="${x(i)}" x2="${x(i)}" y1="0" y2="${P1}" stroke="var(--border-2)" stroke-width=".5"/>`;
  days.forEach((day, i) => {
    const w = wx[day], isT = i === ti;
    s += `<text x="${mid(i)}" y="10" text-anchor="middle" font-size="9" font-weight="${isT ? 700 : 400}" fill="${isT ? 'var(--accent)' : 'var(--text-2)'}">${WD[new Date(day).getDay()]}</text>`;
    if (!w) return;
    if (w.code !== null && w.code !== undefined) s += wxIcon(w.code, mid(i) - 9, 12);
    [[w.tDay, 33], [w.tNight, 49]].forEach(([t, y]) => { if (t === null || t === undefined) return; s += `<rect x="${x(i) + 0.5}" y="${y}" width="${dx - 1}" height="15" fill="${tCls(t)}"/><text x="${mid(i)}" y="${y + 11}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--text)">${Math.round(t)}</text>`; });
    if (w.mm > 0) s += `<rect x="${mid(i) - dx * 0.3}" y="${P0}" width="${dx * 0.6}" height="${Math.min(1, w.mm / 12) * PH * 0.25}" fill="var(--wet)" opacity=".35" rx="1"/>`;
  });
  s += `<text x="${CW - CR + 3}" y="45" font-size="11">☀️</text><text x="${CW - CR + 3}" y="61" font-size="11">🌙</text>`;
  const maxL = Math.max(1, ...per.map(d => d.ml / 1000)) / 0.7, yL = (l) => P1 - l / maxL * PH, g = Math.max(1, Math.round(maxL / 2));
  s += `<line x1="${CL}" x2="${CW - CR}" y1="${yL(g)}" y2="${yL(g)}" stroke="var(--border-2)" stroke-dasharray="2 3"/><text x="${CL - 3}" y="${yL(g) + 3}" text-anchor="end" font-size="9" fill="var(--text-3)">${g} L</text>`;
  per.forEach(d => { const i = days.indexOf(d.day), l = d.ml / 1000; if (i < 0 || l <= 0) return;
    s += `<rect x="${mid(i) - dx * 0.31}" y="${yL(l).toFixed(1)}" width="${dx * 0.62}" height="${(P1 - yL(l)).toFixed(1)}" fill="var(--accent)" rx="1"/>`;
    if (i === ti) s += `<text x="${mid(i)}" y="${yL(l) - 3}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent)">${l.toFixed(1)}</text>`; });
  if (ti >= 0) s += `<rect x="${x(ti) + 1}" y="1" width="${dx - 2}" height="${P1 - 2}" fill="none" stroke="var(--accent)" stroke-width="2" rx="2"/>`;
  s += `<line x1="${CL}" x2="${CW - CR}" y1="${P1}" y2="${P1}" stroke="var(--border)"/>`;
  return `<svg viewBox="0 0 ${CW} ${P1 + 2}" width="100%" data-a="rain" role="button" aria-label="litres watered per day, rain, day and night temperature — rain setting">${s}</svg>`;
}

// ---------------------------------------------------------------- Home: plan banner + spider + buttons
function bannerPlan() {
  const r = state.rules, t = state.t; if (!r) return null;
  let p = t.planNextId ? Rules.planById(r, t.planNextId) : null, at = p ? t.planNext : null;
  if (!p) { const nt = Rules.nextTrigger(r, Date.now()); if (nt) { p = nt.plan; at = nt.t; } }
  return { plan: p || Rules.planById(r, r.default), at };
}
function banner() {
  const b = bannerPlan(), frost = (frostBlocks(state.t) ? '<span class="frost" aria-label="frost">❄</span>' : '') + (Rules.rainSkips(state.rules, rainToday(state.t)) ? '<span class="frost" aria-label="rain">☔</span>' : '');
  if (!b) return `<button class="banner" data-a="plans"><b>Plan</b><span class="chip nos">none</span>${frost}<span class="sp"></span><span>+</span></button>`;
  const on = Rules.isOn(b.plan);
  return `<button class="banner" data-a="plans"><b>${esc(b.plan.name)}</b><span class="chip ${on ? 'ok' : 'nos'}">${on ? 'on' : 'off'}</span>${b.at ? `<span>next ${whenLabel(b.at)}</span>` : ''}${frost}<span class="sp"></span><span aria-hidden="true">›</span></button>`;
}
// Last plan round: when · pots watered · litres · refused (tap → Runs sheet)
const RUN_DAYS = 30, runsHist = () => hist('runs', () => backend.runs(RUN_DAYS));
function lastRunBanner() {
  const rs = runsHist(), r = rs && rs[0];
  if (!r) return `<button class="banner last" data-a="runs"><b>Last run</b><span class="faint">—</span><span class="sp"></span><span aria-hidden="true">›</span></button>`;
  return `<button class="banner last" data-a="runs"><b>Last run</b><span>${whenLabel(r.ts)}</span><span>💧 ${r.watered}</span><span>${litres(r.ml)} L</span>${r.refused ? `<span class="chip bad">✕ ${r.refused}</span>` : ''}<span class="sp"></span><span aria-hidden="true">›</span></button>`;
}
function spiderSvg() {
  const R0 = 42, RN = 118, RL = 145, E = RL + 66, t = state.t;
  let lines = '', nodes = '';
  for (let ch = 0; ch < 16; ch++) {
    const c = state.ch[ch], a = -Math.PI / 2 + ch * Math.PI / 8, cx = Math.cos(a), cy = Math.sin(a), k = look(ch);
    const st = !c.valEn ? 'nf' : k === 'run' || (c.vState === 2 && t.pumpRunning) ? 'act' : t.queue.includes(ch) ? 'queue' : c.vState === 2 ? 'open' : 'idle';
    const line = st === 'act' || st === 'queue' || st === 'open' ? 'var(--accent)' : 'var(--border-2)';
    const w = st === 'act' ? 5 : st === 'idle' || st === 'nf' ? 2 : 3, dash = st === 'queue' ? 'stroke-dasharray="5 4"' : st === 'nf' ? 'stroke-dasharray="2 4"' : '';
    const x = (cx * RN).toFixed(1), y = cy * RN, tone = ['dry', 'ok', 'wet', 'run'].includes(k) ? k : 'nos';
    lines += `<line x1="${(cx * R0).toFixed(1)}" y1="${(cy * R0).toFixed(1)}" x2="${x}" y2="${y.toFixed(1)}" stroke="${line}" stroke-width="${w}" stroke-linecap="round" ${dash} ${st === 'act' ? 'class="flowline"' : ''}/>`;
    const anchor = Math.abs(cx) < 0.3 ? 'middle' : cx > 0 ? 'start' : 'end', dy = cy > 0.3 ? 10 : cy < -0.3 ? -2 : 4;
    nodes += `<g class="node" data-a="pot" data-ch="${ch}" role="button" aria-label="pot ${ch + 1} ${esc(potName(ch))}"${fitted(c) ? '' : ' opacity=".4"'}><circle cx="${x}" cy="${y.toFixed(1)}" r="20" fill="transparent"/>
      <text x="${x}" y="${(y + 9).toFixed(1)}" text-anchor="middle" font-size="27" filter="url(#tone-${tone})">${potEmoji(ch)}</text>
      <text x="${(cx * RL).toFixed(1)}" y="${(cy * RL + dy).toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="var(--text)"><tspan font-weight="700">${ch + 1}</tspan> ${esc(short(potName(ch), 9))}</text></g>`;
  }
  const full = t.tankFullML || 1, f = Math.max(0, Math.min(1, t.tankLeft / full)), yTop = R0 - 2 * R0 * f, low = t.tankLeft <= t.tankReserve;
  const tank = `<g class="node" data-a="tank" role="button" aria-label="tank"><clipPath id="tkc"><circle cx="0" cy="0" r="${R0 - 2}"/></clipPath><circle cx="0" cy="0" r="${R0}" fill="var(--bg)" stroke="${t.pumpRunning ? 'var(--accent)' : 'var(--border)'}" stroke-width="2.5"/>
    <rect x="${-R0}" y="${yTop.toFixed(1)}" width="${2 * R0}" height="${(R0 - yTop).toFixed(1)}" fill="${low ? 'var(--red)' : 'var(--wet)'}" opacity=".45" clip-path="url(#tkc)"/>
    <text x="0" y="2" text-anchor="middle" font-size="17" font-weight="700" fill="var(--text)">${litres(t.tankLeft)}</text><text x="0" y="17" text-anchor="middle" font-size="11" fill="var(--text-2)">L${t.pumpRunning ? ' · ▶' : ''}</text></g>`;
  return `<svg class="spider" viewBox="${-E} ${-RL - 16} ${2 * E} ${2 * RL + 34}" width="100%" role="img" aria-label="tank and 16 pots">${lines}${nodes}${tank}</svg>`;
}
function stationCard() {
  const t = state.t, r = t.running, act = active(), b = bannerPlan();
  const run = r ? `<div class="row"><b>${potLabel(r.ch)}</b><span class="sp"></span><span>${r.ml} / ${r.target} mL</span></div><div class="mbar"><i style="width:${r.target ? Math.min(100, 100 * r.ml / r.target) : 0}%;background:var(--accent)"></i></div>` : '';
  return `<div class="card${act ? ' running' : ''}">${banner()}${lastRunBanner()}${run}${spiderSvg()}
  <div class="btns"><button class="btn primary" data-a="run-ask" ${!b || busy.has('run') || t.running ? 'disabled' : ''}>▶ Run now</button>${act ? '<button class="btn stop" data-a="stop">■ STOP</button>' : ''}</div>
  <div class="btns"><button class="btn sm" data-a="vall" data-v="1"${dis('valves_all')}>Open all</button><button class="btn sm" data-a="vall" data-v="0"${dis('valves_all')}>Close all</button>${t.pumpRunning ? `<button class="btn sm on" data-a="pump" data-v="0"${dis('pumpoff')}>Pump off</button>` : `<button class="btn sm" data-a="pump" data-v="1"${dis('pump')}>Pump on</button>`}<button class="btn sm${find ? ' on' : ''}" data-a="find">Find sensor</button></div>
  ${find ? findPanel() : ''}
  <div class="legend"><span><span class="dot" style="background:var(--amber)"></span>dry</span><span><span class="dot" style="background:var(--green)"></span>ok</span><span><span class="dot" style="background:var(--wet)"></span>wet</span><span><span class="dot" style="background:var(--accent)"></span>watering</span><span><span class="dot" style="background:var(--text-3)"></span>no sensor</span></div></div>`;
}
// Find sensor: read as it is → read in water → the socket that moved, and which pot it sits in
function findPanel() {
  const x = '<button class="btn sm" data-a="find-x" aria-label="close">✕</button>', again = '<button class="btn sm" data-a="find-again" aria-label="again">↺</button>';
  if (find.step < 2) return `<div class="row find"><b>${find.step ? '② in water' : '① as it is'}</b><span class="sp"></span><button class="btn primary sm" data-a="find-read"${dis('find')}>● Read</button>${x}</div>`;
  const h = find.hit;
  if (h.k < 0) return `<div class="row find"><span class="bad">✕ ${h.moved.length ? h.moved.map(k => `S${state.ch[k].in + 1}`).join(' · ') : '—'}</span><span class="sp"></span>${again}${x}</div>`;
  const inp = state.ch[h.k].in, opts = state.ch.map((c, k) => `<option value="${k}"${k === h.k ? ' selected' : ''}>${potEmoji(k)} ${potLabel(k)}</option>`).join('');
  return `<div class="row find wrap"><b>S${inp + 1}</b><span class="faint">${find.a.raw[h.k]} → ${find.b.raw[h.k]}</span><span>in</span><select class="num" id="fpot" aria-label="pot">${opts}</select><span class="sp"></span><button class="btn primary sm" data-a="find-save"${dis('sensor_in')}>✓</button>${again}${x}</div>`;
}

// ---------------------------------------------------------------- sheets
const head = (cap) => `<div class="head"><span class="cap">${cap}</span><button class="btn sm" data-a="close" aria-label="close">✕</button></div>`;
function potGraph(ch) {
  const ph = hist(`pot:${ch}`, () => backend.potHistory(ch, 14)), thr = Rules.sensorWhy(state.ch[ch]) ? null : thrOfCh(ch);
  const W = 360, Hh = 110, L = 24, n = 14, from = dayStart(Date.now(), -(n - 1)), cw = (W - L - 6) / n, xd = (i) => L + i * cw + cw / 2;
  const xt = (ts) => L + (ts - from) / (dayStart(from, n) - from) * (W - L - 6), y = (v) => 8 + (100 - v) / 100 * (Hh - 22);
  let s = '';
  if (thr !== null) s += `<rect x="${L}" y="${y(thr)}" width="${W - L - 6}" height="${y(0) - y(thr)}" fill="var(--amber-soft)"/><line x1="${L}" x2="${W - 6}" y1="${y(thr)}" y2="${y(thr)}" stroke="var(--amber)" stroke-dasharray="3 3"/>`;
  [0, 50, 100].forEach(v => { s += `<text x="${L - 3}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="var(--text-3)">${v}</text>`; });
  if (ph) {
    const per = new Array(n).fill(0); ph.doses.forEach(d => { const i = Math.floor((dayStart(d.ts, 0) - from) / 86400e3 + 0.5); if (i >= 0 && i < n) per[i] += d.ml; });
    const mx = Math.max(1000, ...per);
    per.forEach((ml, i) => { if (ml) { const hh = ml / mx * 40; s += `<rect x="${xd(i) - cw * 0.3}" y="${y(0) - hh}" width="${cw * 0.6}" height="${hh}" fill="var(--accent)" rx="1"/><text x="${xd(i)}" y="${y(0) - hh - 3}" text-anchor="middle" font-size="8.5" fill="var(--accent)">${ml}</text>`; } });
    const pts = ph.moisture.filter(p => p.ts >= from && p.pct >= 0);
    if (pts.length > 1) s += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${xt(p.ts).toFixed(1)} ${y(p.pct).toFixed(1)}`).join('')}" fill="none" stroke="var(--wet)" stroke-width="2.2"/>`;
  }
  for (let i = 0; i < n; i += 2) s += `<text x="${xd(i)}" y="${Hh + 6}" text-anchor="middle" font-size="9" fill="var(--text-3)">${WD[new Date(dayStart(from, i)).getDay()]}</text>`;
  s += `<text x="${xd(n - 1)}" y="${Hh + 6}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent)">${WD[new Date().getDay()]}</text>`;
  return `<svg viewBox="0 0 ${W} ${Hh + 10}" width="100%" role="img" aria-label="moisture and watering, 14 days">${s}</svg>
  <div class="legend"><span><span class="sw" style="background:var(--wet)"></span>%</span><span><span class="sw" style="background:var(--accent)"></span>mL</span>${thr !== null ? `<span><span class="sw" style="background:var(--amber-soft);border:1px solid var(--amber)"></span>&lt; ${thr} %</span>` : ''}</div>`;
}
function calGuide(ch) {
  const c = state.ch[ch], g = sheet.cal, soil = g.kind === 'soil', L1 = soil ? 'Dry soil' : 'Air', L2 = soil ? 'Wet soil' : 'Water';
  if (g.step >= 2) return `<div class="card"><div class="okline">✓ ${L1} ${g.a} · ${L2} ${g.b}</div><div class="btns"><button class="btn primary" data-a="cal-copy"${dis(`cal:${ch}`)}>Apply to all sensors</button><button class="btn" data-a="cal-again">↺</button></div></div>`;
  const steady = c.senEn && c.sState !== 1;
  return `<div class="card"><div class="steps"><span class="${g.step >= 1 ? 'done' : ''}"></span><span></span></div>
  <div class="row"><b>${g.step + 1} · ${g.step ? L2 : L1}</b>${g.step ? `<span class="faint">${L1} ${g.a}</span>` : ''}</div>
  <div class="row"><span class="big">${c.raw}</span><span class="faint">±${c.sd}</span><span class="chip ${steady ? 'ok' : 'nos'}">${steady ? 'steady' : 'swims'}</span><span class="sp"></span><button class="btn sm" data-a="refresh"${dis('refresh')} aria-label="read again">↻</button><button class="btn primary sm" data-a="cal-rec"${dis(`cal:${ch}`)}>● ${g.step ? L2 : L1}</button></div></div>`;
}
function potSheet() {
  const ch = sheet.ch, c = state.ch[ch], k = look(ch), r = state.rules, max = state.t.maxDoseML;
  const ml = sheet.ml || Math.min(nowOf(ch), max || Infinity);
  const pid = r ? Rules.potPlanId(r, ch) : '';
  const vBusy = busy.has(`valve:${ch}`), vWord = vBusy ? '…' : c.vState === 2 ? 'open' : c.vState === 1 ? 'closed' : '?';
  return `${head(`Pot ${ch + 1}`)}
  <div class="row"><input class="inline-edit name" data-f="name" value="${esc(state.potNames[ch] || '')}" placeholder="Pot ${ch + 1}" aria-label="name">${fitted(c) ? chip(k) : ''}<span class="sp"></span>${Rules.sensorWhy(c) ? '' : `<span class="big">${c.pct}<small> %</small></span>`}</div>
  <div class="emo">${EMOJIS.map(e => `<button data-a="emoji" data-v="${e}" aria-pressed="${e === potEmoji(ch)}" aria-label="${e}"${dis('look')}>${e}</button>`).join('')}</div>
  <div class="setrow"><span class="lab">Sensor</span>${sensorChip(c)}<span class="sp"></span><span class="faint">S${c.in + 1} · ${c.raw} ±${c.sd}</span></div>
  <div class="setrow"><span class="lab">Valve</span>${valveSvg(c.vState, 28)}<b>${vWord}</b><span class="sp"></span><button class="switch" role="switch" aria-checked="${c.vState === 2}" data-a="valve" aria-label="valve"${vBusy ? ' disabled' : ''}></button></div>
  ${potGraph(ch)}
  <div class="setrow"><span class="lab">Now</span><input class="num" id="wml" type="number" inputmode="numeric" step="10" min="10" ${max ? `max="${max}"` : ''} value="${ml}" style="width:90px" aria-label="mL now"><span>mL</span><button class="btn primary sp" data-a="water"${dis(`water:${ch}`)}>💧 Water · <span id="wmlb">${ml}</span> mL</button></div>
  ${potPlanCard(ch)}
  <div class="setrow"><span class="lab">Fitted</span><span>Sensor</span><button class="switch" role="switch" aria-checked="${c.senEn}" data-a="en" data-k="s" aria-label="sensor fitted"${dis(`en:s${ch}`)}></button><span>Valve</span><button class="switch" role="switch" aria-checked="${c.valEn}" data-a="en" data-k="v" aria-label="valve fitted"${dis(`en:v${ch}`)}></button></div>
  <div class="setrow"><span class="lab">Calibrate</span><button class="btn sm ${sheet.cal && sheet.cal.kind === 'air' ? 'on' : ''}" data-a="cal-open" data-k="air">Air & water</button><button class="btn sm ${sheet.cal && sheet.cal.kind === 'soil' ? 'on' : ''}" data-a="cal-open" data-k="soil">Dry & wet soil</button></div>
  ${sheet.cal ? calGuide(ch) : ''}
  <div class="setrow"><span class="lab">Valve µs</span></div>
  <div class="btns"><label class="row">open<input class="num" id="vo" type="number" inputmode="numeric" step="10" value="${c.vOpenUs ?? ''}" style="width:100%" aria-label="open µs"></label><label class="row">closed<input class="num" id="vc" type="number" inputmode="numeric" step="10" value="${c.vClosedUs ?? ''}" style="width:100%" aria-label="closed µs"></label></div>
  <div class="btns"><button class="btn sm" data-a="servo-test"${dis(`valve:${ch}`)}>Test</button><button class="btn sm" data-a="servo-ask">Apply</button></div>
  ${sheet.ask === 'servo' ? `<div class="btns"><button class="btn primary sm" data-a="servo-apply" data-v="0"${dis('servo')}>This valve</button><button class="btn sm" data-a="servo-apply" data-v="1"${dis('servo')}>All valves</button></div>` : ''}`;
}
// The pot's part of the plan document: which plan, its moisture rule (knob line) and the amount a plan round gives.
// Saved at once with `rules` (sheet.ps = the setting being dragged / sent, until the board reports it back).
function potPlanCard(ch) {
  const r = state.rules, c = state.ch[ch]; if (!r) return '<div class="setrow"><span class="lab">Plan</span><span class="faint">—</span></div>';
  if (sheet.ps && !busy.has('rules') && JSON.stringify(sheet.ps) === JSON.stringify(Rules.potSet(r, ch))) sheet.ps = null;
  const pid = Rules.potPlanId(r, ch), ps = sheet.ps || Rules.potSet(r, ch), max = state.t.maxDoseML;
  const pick = `<select class="num" data-f="plan" aria-label="plan">${r.plans.map(p => `<option value="${p.id}" ${pid === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="off" ${pid === 'off' ? 'selected' : ''}>off</option></select>`;
  if (pid === 'off') return `<div class="setrow"><span class="lab">Plan</span>${pick}</div>`;
  const plan = Rules.planById(r, pid), blind = Rules.sensorWhy(c);
  return `<div class="card"><div class="row wrap"><b>Plan</b>${pick}<span class="faint">${esc(plan.times.join(' · ') || '▶')}</span></div>
    ${blind ? '<div class="row"><span class="chip dry">⚠</span><span class="faint">no sensor · every time</span></div>' : `<div id="mline">${moistLine(ps)}</div>
    <div class="row wrap">${ps.mode === 'range' ? '' : `<div class="seg" style="width:150px"><button data-a="mode" data-v="min" aria-pressed="${ps.mode === 'min'}">Min</button><button data-a="mode" data-v="max" aria-pressed="${ps.mode === 'max'}">Max</button></div>`}<span class="sp"></span><span id="mtext">${moistText(ps)}</span></div>`}
    <div class="row wrap"><input class="num" id="pml" type="number" inputmode="numeric" step="10" min="10" ${max ? `max="${max}"` : ''} value="${ps.ml}" style="width:90px" aria-label="mL plan"><span>mL</span>${[250, 500, 900].map(v => `<button class="btn sm ${ps.ml === v ? 'on' : ''}" data-a="pml" data-v="${v}">${v}</button>`).join('')}${max && ps.ml > max ? `<span class="faint">→ ${max}</span>` : ''}</div>
    ${r.rainMM ? `<div class="row"><span>☔ rain reaches this pot</span><span class="sp"></span><button class="switch" role="switch" aria-checked="${ps.rain !== false}" data-a="pot-rain" aria-label="rain reaches this pot"></button></div>` : ''}</div>`;
}
// Rain (tap the weather chart): skip the pots rain reaches while today's rain ≥ the limit (plan document rainMM, fw 0.8.0)
function rainSheet() {
  const r = state.rules, on = !!(r && r.rainMM), board = rainToday(state.t), w = weatherDays().find(d => d.day === dayStart(Date.now(), 0));
  const today = board !== null ? board : w ? w.mm : null, skips = on && Rules.rainSkips(r, board);
  return `${head('Rain')}
  <div class="setrow"><span class="lab">☔ Skip</span><span>today ≥</span><input class="num" id="rainmm" type="number" inputmode="numeric" min="1" max="50" step="1" value="${on ? r.rainMM : 5}" style="width:64px" aria-label="mm"${on ? '' : ' disabled'}><span>mm</span><span class="sp"></span><button class="switch" role="switch" aria-checked="${on}" data-a="rain-on" aria-label="rain skip"${dis('rules')}></button></div>
  <div class="row"><span class="faint">today</span><b>${today === null ? '—' : `${today} mm`}</b>${on ? `<span class="chip ${skips ? 'wet' : 'ok'}">${skips ? '☔ skip' : 'water'}</span>` : ''}${on && board === null ? '<span class="faint">board: —</span>' : ''}</div>`;
}
// Send the pot's setting (sheet.ps) with the whole plan document.
async function savePot() {
  const ps = sheet.ps, ch = sheet.ch; if (!ps || !state.rules) return;
  const doc = clone(state.rules); doc.pot = Rules.setPotSet(state.rules, ch, ps);
  const err = Rules.validate(Rules.normalize(doc)); if (err) { toast(`✕ ${err}`); sheet.ps = null; render(true); return; }
  const rec = await sendRules(doc);                       // kept on screen until the board's document shows it (no flicker back)
  if (sheet && sheet.ps === ps && !(rec && rec.status === 'acked')) sheet.ps = null;
  render(true);
}
function tankSheet() {
  const t = state.t, full = t.tankFullML || 0, h = hist('tank30', () => backend.history(30, 0));
  let days = '';
  if (h) { const w = h.perDay.slice(-7), avg = w.reduce((a, d) => a + d.ml, 0) / w.length; if (avg > 0) days = `≈ ${Math.max(0, Math.floor((t.tankLeft - t.tankReserve) / avg))} d`; }
  const fchs = state.ch.map((c, ch) => (c.valEn ? ch : -1)).filter(ch => ch >= 0), fch = sheet.fch ?? fchs[0] ?? 0, f = sheet.flow || {};
  const ask = sheet.ask ? `<div class="card"><div class="row wrap"><span>▼ ${litres(sheet.ask.booked)} L</span><span>·</span><span>✓ ${litres(sheet.ask.real)} L</span><span class="sp"></span><b>${sheet.ask.flow} mL/s</b><span class="faint">(${t.mlPerSec})</span></div>
    <div class="btns"><button class="btn" data-a="level-only">Level</button><button class="btn primary" data-a="level-flow">Level + flow</button></div></div>` : '';
  return `${head('Tank')}
  <div class="row"><span class="big">${litres(t.tankLeft)}<small> of <input class="inline-edit" data-f="tanksize" value="${full ? +(full / 1000).toFixed(1) : ''}" inputmode="decimal" aria-label="tank size L"> L</small></span><span class="sp"></span><span>${days}</span></div>
  <div class="mbar"><i style="width:${full ? Math.min(100, 100 * t.tankLeft / full) : 0}%"></i><b style="left:${full ? 100 * t.tankReserve / full : 0}%"></b></div>
  ${levelGraph(h, full)}
  <div class="legend"><span>▲ refilled</span><span>△ level set</span><span><span class="sw" style="background:var(--red)"></span>${litres(t.tankReserve)} L</span></div>
  <div class="row wrap"><button class="btn primary" data-a="refill"${dis('tank')}>▲ Refilled</button><span class="sp"></span><input class="num" id="lvl" type="number" inputmode="decimal" step="0.1" min="0" value="${litres(t.tankLeft)}" style="width:90px" aria-label="level L"><span>L</span><button class="btn" data-a="level"${dis('tank')}>△ Set</button></div>
  ${ask}
  <div class="card"><div class="row"><b>Flow</b><span class="sp"></span><span class="big" style="font-size:22px">${t.mlPerSec ?? '—'}<small> mL/s</small></span></div>
    <div class="row wrap"><select class="num" data-f="fch" aria-label="pot">${fchs.map(ch => `<option value="${ch}" ${ch === fch ? 'selected' : ''}>${potLabel(ch)}</option>`).join('')}</select><button class="btn primary sp" data-a="ptest"${dis('ptest')}>▶ Pump 10 s</button></div>
    ${f.ran ? `<div class="row wrap"><span>${(f.ran / 1000).toFixed(1)} s</span><input class="num" id="fml" type="number" inputmode="numeric" step="10" min="1" aria-label="mL pumped" placeholder="mL"><span>mL</span><button class="btn primary sp" data-a="flow-save"${dis('flow')}>✓ Flow</button></div>` : ''}</div>
  <div class="foot"><span>fw ${esc(state.device.fw || '—')}</span>${state.device.ip ? `<a href="http://${esc(state.device.ip)}/update" target="_blank" rel="noopener">Update…</a>` : ''}</div>`;
}
function levelGraph(h, full) {
  const W = 360, Hh = 110, L = 28, now = Date.now(), from = dayStart(now, -29), x = (ts) => L + (ts - from) / (now - from) * (W - L - 6), y = (ml) => 8 + (1 - ml / (full || 1)) * (Hh - 20);
  let s = `<line x1="${L}" x2="${W - 6}" y1="${y(state.t.tankReserve)}" y2="${y(state.t.tankReserve)}" stroke="var(--red)" stroke-dasharray="3 3"/>`;
  [0, full].forEach(v => { s += `<text x="${L - 3}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="var(--text-3)">${+(v / 1000).toFixed(1)}</text>`; });
  if (h && full) {
    const pts = h.tank.concat([{ ts: now, ml: state.t.tankLeft }]).filter(p => p.ts >= from);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.ml).toFixed(1)}`).join('');
    if (pts.length > 1) s += `<path d="${d}L${x(now)} ${y(0)}L${x(pts[0].ts)} ${y(0)}Z" fill="var(--wet-soft)"/><path d="${d}" fill="none" stroke="var(--wet)" stroke-width="2"/>`;
    h.refills.forEach(ts => { s += `<path d="M${x(ts) - 5} 2h10l-5 7z" fill="var(--accent)"/>`; });
    h.levels.forEach(ts => { s += `<path d="M${x(ts) - 4} 2h8l-4 6z" fill="none" stroke="var(--text-3)" stroke-width="1.5"/>`; });
  }
  s += `<circle cx="${x(now)}" cy="${y(state.t.tankLeft)}" r="3.5" fill="var(--wet)"/><text x="${L}" y="${Hh + 6}" font-size="9" fill="var(--text-3)">${new Date(from).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</text><text x="${W - 6}" y="${Hh + 6}" text-anchor="end" font-size="9" fill="var(--accent)">${WD[new Date().getDay()]}</text>`;
  return `<svg viewBox="0 0 ${W} ${Hh + 10}" width="100%" role="img" aria-label="tank level, 30 days">${s}</svg>`;
}

// ---- plans: list + editor (the draft lives only while the editor is open)
const potsOn = (doc, id) => state.ch.map((c, ch) => (c.valEn && Rules.potPlanId(doc, ch) === id ? ch + 1 : 0)).filter(Boolean);
function plansSheet() {
  if (sheet.edit) return planEditor();
  const r = state.rules;
  const rows = r ? r.plans.map(p => `<div class="planrow ${Rules.isOn(p) ? '' : 'off'}"><button class="open" data-a="plan-edit" data-id="${p.id}"><b>${r.default === p.id ? '★ ' : ''}${esc(p.name)}</b><span class="faint">${p.times.join(' · ') || '▶'} · ${potsOn(r, p.id).join(' ') || '—'}</span></button><button class="switch" role="switch" aria-checked="${Rules.isOn(p)}" data-a="plan-on" data-id="${p.id}" aria-label="on"${dis('rules')}></button></div>`).join('') : '';
  return `${head('Plans')}${rows}${!r || Rules.nextId(r) ? '<button class="btn" data-a="plan-new">+ Plan</button>' : ''}`;
}
function dayLine(times) {
  const w = 320; let s = `<rect x="0" y="18" width="${w}" height="10" rx="5" fill="var(--track)"/>`;
  [0, 6, 12, 18, 24].forEach(h => { s += `<text x="${Math.min(w - 8, Math.max(8, h / 24 * w))}" y="46" text-anchor="middle" font-size="10" fill="var(--text-3)">${pad(h)}</text>`; });
  times.forEach(tm => { const X = (+tm.slice(0, 2) + +tm.slice(3) / 60) / 24 * w; s += `<g data-a="t-del" data-t="${tm}" role="button" aria-label="remove ${tm}"><circle cx="${X}" cy="23" r="13" fill="transparent"/><circle cx="${X}" cy="23" r="8" fill="var(--accent)"/><text x="${X}" y="11" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text)">${tm}</text></g>`; });
  return `<svg class="dayline" data-a="t-add" viewBox="-10 0 ${w + 20} 50" width="100%" role="img" aria-label="times">${s}</svg>`;
}
// Moisture line of a pot (pot sheet), drawn like the day line: one knob = Min/Max level, two knobs = Range. Drag a knob; tap the
// line to add the second knob (→ Range) or, in Range, to move the nearest one there; tap a Range knob to remove it (→ Min/Max).
// The board's ranges: thr and min 1–99, max up to 100.
const MW = 320, mX = (v) => v / 100 * MW;
function moistLine(p) {
  const rng = p.mode === 'range', bar = (a, b, o) => `<rect x="${mX(a)}" y="18" width="${Math.max(0, mX(b) - mX(a))}" height="10" rx="5" fill="var(--accent)" opacity="${o}"/>`;
  let s = `<rect x="0" y="18" width="${MW}" height="10" rx="5" fill="var(--track)"/>` + (rng ? bar(0, p.max, '.35') + bar(0, p.min, '.85') : bar(0, p.thr, '.85'));
  [0, 25, 50, 75, 100].forEach(v => { s += `<text x="${Math.min(MW - 8, Math.max(8, mX(v)))}" y="46" text-anchor="middle" font-size="10" fill="var(--text-3)">${v}</text>`; });
  const close = rng && p.max - p.min < 16, knob = (k, v, anchor) => `<g data-a="m-knob" data-k="${k}" role="button" aria-label="${k} ${v} %"><circle cx="${mX(v)}" cy="23" r="16" fill="transparent"/><circle cx="${mX(v)}" cy="23" r="8" fill="var(--accent)"/><text x="${Math.min(MW + 6, Math.max(-6, mX(v) + (anchor === 'end' ? 4 : anchor === 'start' ? -4 : 0)))}" y="11" text-anchor="${anchor}" font-size="10.5" font-weight="700" fill="var(--text)">${v} %</text></g>`;
  s += rng ? knob('min', p.min, close ? 'end' : 'middle') + knob('max', p.max, close ? 'start' : 'middle') : knob('thr', p.thr, 'middle');
  return `<svg class="mline" data-a="m-add" viewBox="-10 0 ${MW + 20} 50" width="100%" role="img" aria-label="moisture">${s}</svg>`;
}
// What the setting does, in a few words
const mVal = (e) => { const r = $('#mline svg').getBoundingClientRect(); return Math.round(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width * (MW + 20) - 10) / MW * 100))); };
const clampThr = (v) => Math.max(1, Math.min(99, v));
function drawMoist(p) { $('#mline').innerHTML = moistLine(p); const t = $('#mtext'); if (t) t.textContent = moistText(p); }
const moistText = (p) => (p.mode === 'min' ? `💧 if drier than ${p.thr} %` : p.mode === 'max' ? `💧 unless wetter than ${p.thr} %` : `💧 from below ${p.min} % up to ${p.max} %`);
const PV_ICON = { wet: '●', nosensor: '⚠', implausible: '✕', uncal: '?', tank: '▮', frost: '❄', rain: '☔', off: '—' };
function previewRow(items) {
  if (!items.length) return '<div class="pv"><span>—</span></div>';
  return `<div class="pv">${items.map(it => `<span class="${it.action === 'water' ? 'w' : it.why === 'wet' ? '' : 'x'}" title="${esc(reasonText(it.why))}"><b>${it.ch + 1}</b>${it.action === 'water' ? `💧${it.ml}` : PV_ICON[it.why] || '·'}</span>`).join('')}</div>`;
}
function planEditor() {
  const d = sheet.draft, p = Rules.planById(d, sheet.edit), isDef = d.default === p.id;
  const chips = state.ch.map((c, ch) => (c.valEn ? `<button data-a="tpot" data-ch="${ch}" class="${Rules.potPlanId(d, ch) === p.id ? 'on' : ''}">${ch + 1} ${esc(potName(ch))}${Rules.sensorWhy(c) ? ' <span class="warn" title="no sensor">⚠</span>' : ''}</button>` : '')).join('');
  return `<div class="head"><button class="btn sm" data-a="plan-back" aria-label="back">◀</button><span class="cap">Plan</span><button class="btn sm" data-a="close" aria-label="close">✕</button></div>
  <div class="row"><input class="inline-edit name" id="pname" value="${esc(p.name)}" maxlength="16" aria-label="name"><button class="btn sm ${isDef ? 'on' : ''}" data-a="plan-default" aria-label="default">★</button>${isDef || !Rules.planById(state.rules, p.id) ? '' : `<button class="btn sm" data-a="plan-del" aria-label="delete"${dis('rules')}>🗑</button>`}<span class="sp"></span><button class="switch" role="switch" aria-checked="${Rules.isOn(p)}" data-a="dplan-on" aria-label="on"></button></div>
  <div><b>When</b>${dayLine(p.times)}</div>
  <div class="pchips">${chips}</div>
  ${sheet.test ? previewRow(sheet.test) : ''}
  <div class="btns"><button class="btn" data-a="plan-test">Test now</button><button class="btn primary" data-a="plan-apply"${dis('rules')}>Apply</button></div>`;
}
function runSheet() {
  const p = Rules.planById(state.rules, sheet.plan);
  return `${head('Run now')}<div class="row"><span class="big">${esc(p ? p.name : '—')}</span></div>${p ? previewRow(Rules.preview(state.rules, p.id, state.ch, ctx())) : ''}
  <div class="btns"><button class="btn" data-a="close">✕</button><button class="btn primary" data-a="run"${dis('run')}>▶ Run</button></div>`;
}

// Runs: the chosen round's pots on top, every round of RUN_DAYS below (tap a row to show it)
const dateLabel = (ms) => { const d = new Date(ms); return `${WD[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}. ${hm(ms)}`; };
const planLabel = (id) => { const p = state.rules && id && Rules.planById(state.rules, id); return p ? p.name : id || '—'; };
function runsSheet() {
  const rs = runsHist();
  if (!rs || !rs.length) return `${head('Runs')}<div class="faint">${rs ? '—' : '…'}</div>`;
  const i = Math.min(sheet.sel || 0, rs.length - 1), r = rs[i];
  const pots = r.pots.map(p => { const ok = p.why === 'ok' || p.why === 'cap_trim';
    return `<tr class="${ok ? '' : 'x'}"><td>${potEmoji(p.ch)} ${potLabel(p.ch)}</td><td class="n">${p.pct === null ? '—' : `${p.pct} %`}</td><td class="n">${ok ? p.ml : '—'}</td><td>${ok ? (p.why === 'cap_trim' ? `✓ ${reasonText(p.why)}` : '✓') : `✕ ${esc(reasonText(p.why))}`}</td></tr>`; }).join('');
  const rows = rs.map((x, k) => `<tr class="pick${k === i ? ' on' : ''}" data-a="run-sel" data-v="${k}"><td>${dateLabel(x.ts)}</td><td>${x.trigger === 'plan' ? '⏱' : '▶'} ${esc(short(planLabel(x.plan), 10))}</td><td class="n">${x.watered}</td><td class="n">${litres(x.ml)}</td><td class="n">${x.skipped || ''}</td><td class="n">${x.refused ? `<b class="bad">${x.refused}</b>` : ''}</td><td class="n">${x.tankLeft === null ? '—' : litres(x.tankLeft)}</td></tr>`).join('');
  return `${head('Runs')}
  <div class="card"><div class="row wrap"><b>${dateLabel(r.ts)}</b><span>${r.trigger === 'plan' ? '⏱' : '▶'} ${esc(planLabel(r.plan))}</span><span class="sp"></span><span class="big">${litres(r.ml)}<small> L</small></span></div>
    <div class="row wrap"><span>💧 ${r.watered}</span>${r.skipped ? `<span class="faint">⏭ ${r.skipped} skipped</span>` : ''}${r.refused ? `<span class="chip bad">✕ ${r.refused}</span>` : ''}<span class="sp"></span>${r.tankLeft === null ? '' : `<span class="faint">tank ${litres(r.tankLeft)} L</span>`}</div>
    ${pots ? `<table class="tbl"><thead><tr><th>Pot</th><th class="n">before</th><th class="n">mL</th><th></th></tr></thead><tbody>${pots}</tbody></table>` : ''}</div>
  <table class="tbl"><thead><tr><th>When</th><th>Plan</th><th class="n">💧</th><th class="n">L</th><th class="n">⏭</th><th class="n">✕</th><th class="n">tank</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="legend"><span>⏱ timed</span><span>▶ Run now</span><span>💧 watered</span><span>⏭ skipped</span><span>✕ refused</span></div>`;
}

// Picture + wet level live in the household (not on the board): merge a change into every pot in chs and save the whole map.
async function setLook(chs, patch, label) {
  const map = clone(state.potLook || {});
  chs.forEach(ch => { map[ch] = { ...(map[ch] || {}), ...patch }; });
  busy.add('look'); render(true);
  try { await backend.setPotLook(map); if (label) toast(`${label} ✓`); }
  catch (err) { toast(`✕ ${err.message}`); }
  finally { busy.delete('look'); render(true); }
}

// ---------------------------------------------------------------- render
const focusIn = (el) => { const a = document.activeElement; return a && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName); };
// A redraw between finger-down and finger-up replaces the button under the finger and the tap is lost (the pot sheet's ✕
// did not close on the phone: live updates redraw the sheet). So no redraw while pressed — it runs right after the tap.
let pressed = 0, deferred = null;
function render(force) {
  if (!state) return;
  if (pressed && Date.now() - pressed < 3000) { deferred = { force: !!force || !!(deferred && deferred.force) }; return; }
  const conn = connState(state.device, Date.now()), c = $('#conn');
  c.className = `conn ${conn}`; c.lastElementChild.textContent = ago(state.device.lastSeen);
  $('#fw').textContent = state.device.fw ? `fw ${state.device.fw}` : '';
  $('#downbar').hidden = !state.backendDown;
  const host = $('#screen-home');
  if (force || !focusIn(host)) host.innerHTML = chartCard() + stationCard();
  const sh = $('#sheet');
  sh.hidden = !sheet; document.body.style.overflow = sheet ? 'hidden' : '';
  if (sheet && (force || !focusIn(sh))) {
    const top = sh.scrollTop, fn = { pot: potSheet, tank: tankSheet, plans: plansSheet, run: runSheet, runs: runsSheet, rain: rainSheet }[sheet.type];
    sh.innerHTML = `<div class="in">${fn()}</div>`; sh.scrollTop = top;
  }
}
function openSheet(s) { const same = sheet && sheet.type === s.type; sheet = s; if (!same) $('#sheet').scrollTop = 0; render(true); }

// ---------------------------------------------------------------- events
const dplan = () => Rules.planById(sheet.draft, sheet.edit);
// The pot setting being edited in the pot sheet (moisture knobs, Min/Max, plan mL); saved by savePot()
const mEdit = () => (sheet && sheet.type === 'pot' && state.rules ? (sheet.ps = sheet.ps || Rules.potSet(state.rules, sheet.ch)) : null);
// Dragging a moisture knob (pointer events; a drag of > 4 px is not a tap); saved on release
let mDrag = { k: null, moved: false };
function onPointer(e) {
  if (e.type === 'pointerdown') pressed = Date.now();
  else if (e.type !== 'pointermove' && pressed) { pressed = 0; if (deferred) { const f = deferred.force; deferred = null; setTimeout(() => render(f), 0); } }
  if (e.type === 'pointerdown') { const k = e.target.closest('[data-a="m-knob"]'); mDrag = { k: k && mEdit() ? k.dataset.k : null, x0: e.clientX, moved: false }; return; }
  if (!mDrag.k) return;
  if (e.type !== 'pointermove') { mDrag.k = null; if (mDrag.moved) savePot(); return; }
  if (Math.abs(e.clientX - mDrag.x0) > 4) mDrag.moved = true;
  if (!mDrag.moved) return;
  const p = mEdit(), x = mVal(e);
  if (mDrag.k === 'thr') p.thr = clampThr(x); else if (mDrag.k === 'min') p.min = clampThr(Math.min(x, p.max - 1)); else p.max = Math.min(100, Math.max(x, p.min + 1));
  drawMoist(p);
}
async function onClick(e) {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, v = el.dataset.v, ch = el.dataset.ch !== undefined ? +el.dataset.ch : sheet && sheet.ch;
  switch (a) {
    case 'close': sheet = null; render(true); break;
    case 'pan': { const minOff = CH_AHEAD - CH_FWD, maxOff = CH_BACK - CH_DAYS + 1 + CH_AHEAD; chartOff = v === '0' ? 0 : Math.max(minOff, Math.min(maxOff, chartOff - (+v) * 7)); render(true); break; }
    case 'pot': openSheet({ type: 'pot', ch }); break;
    case 'tank': openSheet({ type: 'tank' }); break;
    case 'plans': openSheet({ type: 'plans' }); break;
    case 'runs': openSheet({ type: 'runs', sel: 0 }); break;
    case 'run-sel': sheet.sel = +v; $('#sheet').scrollTop = 0; render(true); break;
    case 'run-ask': { const b = bannerPlan(); if (b) openSheet({ type: 'run', plan: b.plan.id }); break; }
    case 'run': { const p = Rules.planById(state.rules, sheet.plan); sheet = null; render(true); cmd('run', { plan: p.id }, 'run', `▶ ${p.name}`); break; }
    case 'stop': cmd('stop', {}, 'stop', '■ STOP'); break;
    case 'find': find = find ? null : { step: 0 }; render(true); break;
    case 'find-x': find = null; render(true); break;
    case 'find-again': find = { step: 0 }; render(true); break;
    case 'find-read': {
      const f = find, rec = await cmd('refresh', {}, 'find', '🔎', true), r = rec && rec.status === 'acked' ? rec.result || {} : null;
      if (!r || find !== f) break;
      if (!Array.isArray(r.raw) || !Array.isArray(r.sd)) { toast('✕ fw 0.7.0'); break; }
      if (f.step === 0) { f.a = r; f.step = 1; } else { f.b = r; f.hit = findSensor(f.a, f.b); f.step = 2; }
      render(true); break; }
    case 'find-save': {
      const p = +$('#fpot').value, inp = state.ch[find.hit.k].in;
      if (state.ch[p].in === inp) { toast(`Pot ${p + 1} · S${inp + 1} ✓`); find = null; render(true); break; }
      const rec = await cmd('sensor_in', { ch: p, input: inp }, 'sensor_in', `Pot ${p + 1} ← S${inp + 1}`);
      if (rec && rec.status === 'acked') { find = null; render(true); } break; }
    case 'rain': openSheet({ type: 'rain' }); break;
    case 'rain-on': { if (!state.rules) break; const d = clone(state.rules); if (d.rainMM) delete d.rainMM; else d.rainMM = 5; sendRules(d); break; }
    case 'pot-rain': { const p = mEdit(); if (!p) break; p.rain = p.rain === false; savePot(); break; }
    case 'vall': cmd('valves_all', { open: v === '1' }, 'valves_all', v === '1' ? 'Open all' : 'Close all'); break;
    case 'pump': if (v === '1') cmd('pump', { on: true }, 'pump', 'Pump'); else cmd('pump', { on: false }, 'pumpoff', 'Pump off'); break;
    // pot sheet
    case 'valve': { const open1 = state.ch[ch].vState !== 2; cmd('valve', { ch, open: open1 }, `valve:${ch}`, `Valve ${ch + 1}`); break; }
    case 'water': { const ml = intOf('#wml'), max = state.t.maxDoseML; if (!ml || (max && ml > max)) { toast(`✕ 10 – ${max || '…'} mL`); break; } sheet.ml = ml; if (ml !== nowOf(ch)) setLook([ch], { now: ml }, null); cmd('water', { ch, ml }, `water:${ch}`, `Pot ${ch + 1}`); break; }
    case 'en': { const k = el.dataset.k, c = state.ch[ch], on = !(k === 's' ? c.senEn : c.valEn); cmd('en', { what: `${k}${ch + 1}`, on }, `en:${k}${ch}`, `${k === 's' ? 'Sensor' : 'Valve'} ${ch + 1}`); break; }
    case 'cal-open': { const k = el.dataset.k; sheet.cal = sheet.cal && sheet.cal.kind === k ? null : { kind: k, step: 0, a: null, b: null }; render(true); if (sheet.cal) cmd('refresh', {}, 'refresh', '↻', true); break; }
    case 'refresh': cmd('refresh', {}, 'refresh', '↻', true); break;
    case 'cal-rec': {
      const g = sheet.cal, soil = g.kind === 'soil', which = soil ? (g.step ? 'wet' : 'dry') : (g.step ? 'water' : 'air');
      const rec = await cmd(soil ? 'soil' : 'cal', { ch, which }, `cal:${ch}`, `Pot ${ch + 1} · ${which}`);
      if (rec && rec.status === 'acked' && sheet && sheet.cal === g) { const r = rec.result || {}; const val = soil ? (which === 'dry' ? r.soilDry : r.soilWet) : (which === 'air' ? r.air : r.water); if (g.step) g.b = val; else g.a = val; g.step++; render(true); }
      break; }
    case 'cal-again': sheet.cal = { kind: sheet.cal.kind, step: 0, a: null, b: null }; render(true); break;
    case 'emoji': setLook([ch], { e: v }, null); break;
    case 'cal-copy': cmd('cal_copy', { ch, kind: sheet.cal.kind === 'soil' ? 'soil' : 'air' }, `cal:${ch}`, 'All sensors'); break;
    case 'servo-test': { const o = intOf('#vo'), c = intOf('#vc'); if (!o || !c) break;
      const r1 = await cmd('servo', { ch, openUs: o, closedUs: c, all: false }, 'servo', `Valve ${ch + 1} µs`, true);
      if (r1 && r1.status === 'acked') { await cmd('valve', { ch, open: true }, `valve:${ch}`, `Valve ${ch + 1}`, true); await cmd('valve', { ch, open: false }, `valve:${ch}`, `Valve ${ch + 1} ✓`); }
      break; }
    case 'servo-ask': sheet.ask = sheet.ask === 'servo' ? null : 'servo'; render(true); break;
    case 'servo-apply': { const o = intOf('#vo'), c = intOf('#vc'); if (!o || !c) break; sheet.ask = null; cmd('servo', { ch, openUs: o, closedUs: c, all: v === '1' }, 'servo', v === '1' ? 'All valves µs' : `Valve ${ch + 1} µs`); break; }
    // tank sheet
    case 'refill': cmd('tank', { full: true }, 'tank', '▲ Tank'); break;
    case 'level': {
      const L = +$('#lvl').value; if (!(L >= 0)) break; const ml = Math.round(L * 1000), t = state.t, m = state.mark;
      const booked = m ? m.tankLeft - t.tankLeft : NaN, real = m ? m.tankLeft - ml : NaN;   // what the counter subtracted vs what the tank really lost since the last refill / level set
      if (booked >= 500 && real > 0 && Math.abs(real - booked) >= 0.05 * booked && t.mlPerSec) { sheet.ask = { ml, booked, real, flow: +(t.mlPerSec * real / booked).toFixed(1) }; render(true); break; }
      cmd('tank', { ml }, 'tank', '△ Tank'); break; }
    case 'level-only': { const q = sheet.ask; sheet.ask = null; cmd('tank', { ml: q.ml }, 'tank', '△ Tank'); break; }
    case 'level-flow': { const q = sheet.ask; sheet.ask = null; cmd('flow', { mlPerSec: q.flow }, 'flow', 'Flow'); cmd('tank', { ml: q.ml }, 'tank', '△ Tank'); break; }
    case 'ptest': { const c = sheet.fch ?? firstValve(); sheet.flow = null;
      const rec = await cmd('pump_test', { ch: c, sec: 10 }, 'ptest', `▶ Pot ${c + 1}`);
      if (rec && rec.status === 'acked' && sheet && sheet.type === 'tank') { sheet.flow = { ran: rec.result.ran_ms || 10000 }; render(true); } break; }
    case 'flow-save': { const ml = intOf('#fml'); if (!ml || !sheet.flow) break; const f = +(ml / (sheet.flow.ran / 1000)).toFixed(1); const rec = await cmd('flow', { mlPerSec: f }, 'flow', `Flow ${f} mL/s`); if (rec && rec.status === 'acked' && sheet) { sheet.flow = null; render(true); } break; }
    // plans
    case 'plan-on': { const d = clone(state.rules), p = Rules.planById(d, el.dataset.id); p.on = !Rules.isOn(p); sendRules(d); break; }
    case 'plan-edit': sheet.draft = clone(state.rules); sheet.edit = el.dataset.id; sheet.test = null; render(true); break;
    case 'plan-new': { const d = state.rules ? clone(state.rules) : null;
      if (!d) { sheet.draft = Rules.empty(); sheet.edit = 'a'; }
      else { const id = Rules.nextId(d); d.plans.push(Rules.newPlan(id, `Plan ${id.toUpperCase()}`)); sheet.draft = d; sheet.edit = id; }
      sheet.test = null; render(true); break; }
    case 'plan-back': sheet.edit = null; sheet.draft = null; render(true); break;
    case 'plan-default': sheet.draft.default = sheet.edit; render(true); break;
    case 'plan-del': { const d = clone(state.rules), id = sheet.edit; d.plans = d.plans.filter(p => p.id !== id); Object.keys(d.pots).forEach(k => { if (d.pots[k] === id) delete d.pots[k]; });
      const rec = await sendRules(d); if (rec && rec.status === 'acked' && sheet) { sheet.edit = null; sheet.draft = null; render(true); } break; }
    case 'dplan-on': dplan().on = !Rules.isOn(dplan()); render(true); break;
    case 't-del': dplan().times = dplan().times.filter(t => t !== el.dataset.t); sheet.test = null; render(true); break;
    case 't-add': {
      const p = dplan(); if (p.times.length >= Rules.MAX_TIMES) { toast(`max ${Rules.MAX_TIMES}`); break; }
      const r = el.getBoundingClientRect(), X = (e.clientX - r.left) / r.width * 340 - 10, mins = Math.round(Math.max(0, Math.min(1439, X / 320 * 1440)) / 15) * 15 % 1440;
      const tm = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; if (!p.times.includes(tm)) p.times = [...p.times, tm].sort(); sheet.test = null; render(true); break; }
    case 'mode': { const p = mEdit(); if (!p || p.mode === v) break; p.mode = v; savePot(); break; }
    case 'm-knob': { if (mDrag.moved) break; const p = mEdit(); if (!p || p.mode !== 'range') break;
      p.thr = clampThr(el.dataset.k === 'min' ? p.max : p.min); p.mode = sheet.lvl || 'min'; savePot(); break; }
    case 'm-add': { if (mDrag.moved) break; const p = mEdit(), x = mVal(e); if (!p) break;
      if (p.mode === 'range') { if (Math.abs(x - p.min) <= Math.abs(x - p.max)) p.min = clampThr(Math.min(x, p.max - 1)); else p.max = Math.min(100, Math.max(x, p.min + 1)); }
      else { const lo = clampThr(Math.min(x, p.thr)), hi = Math.min(100, Math.max(x, p.thr)); if (lo >= hi) break; sheet.lvl = p.mode; p.min = lo; p.max = hi; p.mode = 'range'; }
      savePot(); break; }
    case 'pml': { const p = mEdit(); if (!p) break; p.ml = +v; savePot(); break; }
    case 'tpot': sheet.draft.pots = Rules.togglePot(sheet.draft, ch, sheet.edit); sheet.test = null; render(true); break;
    case 'plan-test': sheet.test = Rules.preview(sheet.draft, sheet.edit, state.ch, ctx()); render(true); break;
    case 'plan-apply': {
      const err = Rules.validate(sheet.draft); if (err) { toast(`✕ ${err}`); break; }
      const rec = await sendRules(sheet.draft); if (rec && rec.status === 'acked' && sheet && sheet.type === 'plans') { sheet.edit = null; sheet.draft = null; render(true); } break; }
  }
}
function onInput(e) {
  const t = e.target;
  if (t.id === 'wml') { const b = $('#wmlb'); if (b) b.textContent = t.value || '—'; return; }
  if (!sheet || !sheet.edit) return;
  const p = dplan();
  if (t.id === 'pname') { p.name = t.value; return; }
}
function onChange(e) {
  const t = e.target, f = t.dataset.f;
  if (f === 'name') backend.setPotName(sheet.ch, t.value.trim().slice(0, 24)).catch(err => toast(`✕ ${err.message}`));
  else if (f === 'plan') { const d = clone(state.rules); d.pots = Rules.setPot(d, sheet.ch, t.value); sendRules(d); }
  else if (f === 'tanksize') { const L = +String(t.value).replace(',', '.'); if (L > 0) cmd('tanksize', { ml: Math.round(L * 1000) }, 'tanksize', `Tank ${L} L`); }
  else if (f === 'fch') sheet.fch = +t.value;
  else if (t.id === 'rainmm') { const v = Math.round(+t.value); if (!(v >= 1 && v <= 50)) { toast('✕ 1 – 50 mm'); render(true); return; } const d = clone(state.rules); d.rainMM = v; sendRules(d); }
  else if (t.id === 'pml') { const v = Math.round(+t.value), p = mEdit(); if (!p) return; if (!(v >= 10)) { toast('✕ ≥ 10 mL'); render(true); return; } p.ml = v; savePot(); }
}

// ---------------------------------------------------------------- start
function showLogin() {
  const box = $('#login'), form = $('#login-form'), err = $('#login-err');
  box.hidden = false;
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) { err.innerHTML = '<a href="?backend=mock">demo</a>'; form.querySelector('button').disabled = true; }
  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = ''; const btn = form.querySelector('button'); btn.disabled = true;
      try { await backend.login($('#login-email').value.trim(), $('#login-pw').value, $('#login-stay').checked); box.hidden = true; resolve(); }
      catch (ex) { err.textContent = ex.message; }
      btn.disabled = false;
    });
    $('#login-email').focus();
  });
}
async function main() {
  backend = await createBackend();
  await backend.init();
  if (!backend.session()) { await showLogin(); await backend.init(); }
  state = backend.getState();
  // a round ends with its event a few seconds after the last dose → reload the history once the station goes idle
  let wasRunning = false;
  backend.subscribe(s => { state = s; const r = !!(s.t.running || s.t.queue.length); if (wasRunning && !r) setTimeout(() => { invalidate(); render(); }, 8000); wasRunning = r; render(); });
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, onPointer));
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet) { sheet = null; render(true); return; }
    if (sheet || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const b = document.querySelector(`[data-a="pan"][data-v="${e.key === 'ArrowLeft' ? -1 : 1}"]`); if (b && !b.disabled) b.click(); }
  });
  setInterval(() => render(), 15000);
  render(true);
}
main().catch(e => { document.body.insertAdjacentHTML('afterbegin', `<div class="downbar">✕ ${esc(e.message)}</div>`); });
