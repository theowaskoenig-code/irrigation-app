// app.js — the Balcony UI: two tabs (Home · Pots) and four sheets (pot · tank · plans · run). No prose: labels, numbers, icons.
// Talks only to the backend object from backend.js (mock / lan / supabase). Pictures follow app/design/redraft-round2.html.
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let backend, state, tab = 'home', sheet = null, chartOff = 0;
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
const planOfCh = (ch) => (state.rules ? Rules.planOf(state.rules, ch) : null);
const fitted = (c) => c.valEn || c.senEn;
const firstValve = () => Math.max(0, state.ch.findIndex(c => c.valEn));
const ctx = () => ({ maxDoseML: state.t.maxDoseML || 0, tankLeft: state.t.tankLeft, tankReserve: state.t.tankReserve, frost: frostBlocks(state.t) });
// What a pot looks like now: run · nos (no sensor) · bad (implausible) · uncal · dry · ok
function look(ch) {
  const c = state.ch[ch], r = state.t.running;
  if (r && r.ch === ch) return 'run';
  const w = Rules.sensorWhy(c);
  if (w) return w === 'nosensor' ? 'nos' : w === 'implausible' ? 'bad' : 'uncal';
  const thr = Rules.thrOf(planOfCh(ch));
  return thr !== null && c.pct < thr ? 'dry' : 'ok';
}
const LOOK = { run: ['run', 'watering'], nos: ['nos', 'no sensor'], bad: ['bad', '✕ sensor'], uncal: ['nos', '? uncal'], dry: ['dry', '▲ dry'], ok: ['wet', '● ok'] };
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
const sendRules = (doc) => cmd('rules', Rules.normalize(doc), 'rules', 'Plan');

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
function potSvg(ch) {
  const c = state.ch[ch], k = look(ch), top = 10, bot = 50, thr = Rules.thrOf(planOfCh(ch));
  const fill = k === 'run' ? 'var(--accent)' : k === 'dry' ? 'var(--amber)' : 'var(--wet)';
  let inner = '<text x="28" y="36" text-anchor="middle" font-size="14" fill="var(--text-3)">—</text>';
  if (!Rules.sensorWhy(c)) {
    const y = bot - (bot - top) * c.pct / 100;
    inner = `<clipPath id="pc${ch}"><path d="M8 ${top}h40l-5 ${bot - top}H13z"/></clipPath><rect x="0" y="${y.toFixed(1)}" width="56" height="${(bot - y).toFixed(1)}" fill="${fill}" opacity=".85" clip-path="url(#pc${ch})"/>`;
    if (thr !== null) { const ty = bot - (bot - top) * thr / 100; inner += `<line x1="4" x2="52" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="3 2"/>`; }
  }
  return `<svg width="56" height="54" viewBox="0 0 56 54" aria-hidden="true">${inner}<path d="M8 ${top}h40l-5 ${bot - top}H13z" fill="none" stroke="var(--border)" stroke-width="2"/><rect x="5" y="5" width="46" height="6" rx="1" fill="var(--surface-2)" stroke="var(--border)" stroke-width="2"/></svg>`;
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
  return `<svg viewBox="0 0 ${CW} ${P1 + 2}" width="100%" role="img" aria-label="litres watered per day, rain, day and night temperature">${s}</svg>`;
}

// ---------------------------------------------------------------- Home: plan banner + spider + buttons
function bannerPlan() {
  const r = state.rules, t = state.t; if (!r) return null;
  let p = t.planNextId ? Rules.planById(r, t.planNextId) : null, at = p ? t.planNext : null;
  if (!p) { const nt = Rules.nextTrigger(r, Date.now()); if (nt) { p = nt.plan; at = nt.t; } }
  return { plan: p || Rules.planById(r, r.default), at };
}
function banner() {
  const b = bannerPlan(), frost = frostBlocks(state.t) ? '<span class="frost" aria-label="frost">❄</span>' : '';
  if (!b) return `<button class="banner" data-a="plans"><b>Plan</b><span class="chip nos">none</span>${frost}<span class="sp"></span><span>+</span></button>`;
  const on = Rules.isOn(b.plan);
  return `<button class="banner" data-a="plans"><b>${esc(b.plan.name)}</b><span class="chip ${on ? 'ok' : 'nos'}">${on ? 'on' : 'off'}</span>${b.at ? `<span>next ${whenLabel(b.at)}</span>` : ''}${frost}<span class="sp"></span><span aria-hidden="true">›</span></button>`;
}
function spiderSvg() {
  const C = 170, R0 = 44, R1 = 116, RN = 134, t = state.t;
  const COL = { dry: 'var(--amber)', ok: 'var(--wet)', nos: 'var(--text-3)', bad: 'var(--red)', uncal: 'var(--text-3)' };
  const SOFT = { dry: 'var(--amber-soft)', ok: 'var(--wet-soft)', bad: 'var(--red-soft)' };
  let s = '';
  for (let ch = 0; ch < 16; ch++) {
    const c = state.ch[ch], a = -Math.PI / 2 + ch * Math.PI / 8, cx = Math.cos(a), cy = Math.sin(a), k = look(ch);
    const st = !c.valEn ? 'nf' : k === 'run' || (c.vState === 2 && t.pumpRunning) ? 'act' : t.queue.includes(ch) ? 'queue' : c.vState === 2 ? 'open' : 'idle';
    const line = st === 'act' || st === 'queue' || st === 'open' ? 'var(--accent)' : 'var(--border-2)';
    const w = st === 'act' ? 5 : st === 'idle' || st === 'nf' ? 2 : 3, dash = st === 'queue' ? 'stroke-dasharray="5 4"' : st === 'nf' ? 'stroke-dasharray="2 4"' : '';
    const P = (r) => [(C + cx * r).toFixed(1), (C + cy * r).toFixed(1)], [x0, y0] = P(R0), [x1, y1] = P(R1), [xn, yn] = P(RN), [xl, yl] = P(RN + 25);
    s += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${line}" stroke-width="${w}" ${dash} ${st === 'act' ? 'class="flowline"' : ''}/>`;
    const stroke = st === 'nf' ? 'var(--border-2)' : st === 'act' || st === 'queue' ? 'var(--accent)' : COL[k] || 'var(--border)';
    const fill = st === 'act' ? 'var(--accent)' : st === 'queue' ? 'var(--accent-soft)' : st === 'nf' ? 'var(--bg)' : SOFT[k] || 'var(--bg)';
    const lab = st === 'act' && t.running ? t.running.ml : c.lastML > 0 ? c.lastML : '';
    s += `<g class="node" data-a="pot" data-ch="${ch}" role="button" aria-label="pot ${ch + 1}"><circle cx="${xn}" cy="${yn}" r="17" fill="${fill}" stroke="${stroke}" stroke-width="2.5" ${st === 'nf' ? 'stroke-dasharray="3 3"' : ''}/>
      <text x="${xn}" y="${(+yn + 4.5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${st === 'act' ? 'var(--accent-ink)' : st === 'nf' ? 'var(--text-3)' : 'var(--text)'}">${ch + 1}</text>
      ${lab !== '' ? `<text x="${xl}" y="${(+yl + 4).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${st === 'act' ? 'var(--accent)' : 'var(--text-2)'}">${lab}</text>` : ''}</g>`;
  }
  const full = state.t.tankFullML || 1, f = Math.max(0, Math.min(1, state.t.tankLeft / full)), yTop = C + R0 - 2 * R0 * f, low = state.t.tankLeft <= state.t.tankReserve;
  s += `<g class="node" data-a="tank" role="button" aria-label="tank"><clipPath id="tkc"><circle cx="${C}" cy="${C}" r="${R0 - 2}"/></clipPath><circle cx="${C}" cy="${C}" r="${R0}" fill="var(--bg)" stroke="${t.pumpRunning ? 'var(--accent)' : 'var(--border)'}" stroke-width="2.5"/>
    <rect x="${C - R0}" y="${yTop.toFixed(1)}" width="${2 * R0}" height="${(C + R0 - yTop).toFixed(1)}" fill="${low ? 'var(--red)' : 'var(--wet)'}" opacity=".45" clip-path="url(#tkc)"/>
    <text x="${C}" y="${C + 2}" text-anchor="middle" font-size="17" font-weight="700" fill="var(--text)">${litres(state.t.tankLeft)}</text><text x="${C}" y="${C + 17}" text-anchor="middle" font-size="11" fill="var(--text-2)">L${t.pumpRunning ? ' · ▶' : ''}</text></g>`;
  return `<svg class="spider" viewBox="0 -20 340 380" width="100%" role="img" aria-label="tank and 16 branches">${s}</svg>`;
}
function stationCard() {
  const t = state.t, r = t.running, act = active(), b = bannerPlan();
  const run = r ? `<div class="row"><b>${potLabel(r.ch)}</b><span class="sp"></span><span>${r.ml} / ${r.target} mL</span></div><div class="mbar"><i style="width:${r.target ? Math.min(100, 100 * r.ml / r.target) : 0}%;background:var(--accent)"></i></div>` : '';
  return `<div class="card${act ? ' running' : ''}">${banner()}${run}${spiderSvg()}
  <div class="btns"><button class="btn primary" data-a="run-ask" ${!b || busy.has('run') || t.running ? 'disabled' : ''}>▶ Run now</button>${act ? '<button class="btn stop" data-a="stop">■ STOP</button>' : ''}</div>
  <div class="btns"><button class="btn sm" data-a="vall" data-v="1"${dis('valves_all')}>Open all</button><button class="btn sm" data-a="vall" data-v="0"${dis('valves_all')}>Close all</button>${t.pumpRunning ? `<button class="btn sm on" data-a="pump" data-v="0"${dis('pumpoff')}>Pump off</button>` : `<button class="btn sm" data-a="pump" data-v="1"${dis('pump')}>Pump on</button>`}</div>
  <div class="legend"><span><span class="sw" style="background:var(--amber-soft);border:2px solid var(--amber)"></span>dry</span><span><span class="sw" style="background:var(--wet-soft);border:2px solid var(--wet)"></span>ok</span><span><span class="sw" style="border:2px solid var(--text-3)"></span>no sensor</span><span><span class="sw" style="border:2px dashed var(--border-2)"></span>not fitted</span><span><span class="sw" style="border:2px dashed var(--accent)"></span>queued</span></div></div>`;
}

// ---------------------------------------------------------------- Pots tab
function potsGrid() {
  const fit = [], unf = [];
  state.ch.forEach((c, ch) => (fitted(c) ? fit : unf).push(ch));
  const tiles = fit.map(ch => {
    const c = state.ch[ch], k = look(ch);
    return `<button class="pot ${k === 'run' ? 'run' : k === 'dry' ? 'dry' : ''}" data-a="pot" data-ch="${ch}"><span class="nm">${potLabel(ch)}</span>${potSvg(ch)}<span class="pc">${Rules.sensorWhy(c) ? '—' : c.pct + '%'}</span><span class="row" style="gap:4px">${c.valEn ? valveSvg(c.vState, 22) : ''}${chip(k)}</span></button>`;
  }).join('');
  const fold = unf.length ? `<button class="pot off" data-a="unfitted"><span class="nm">${unf.length === 1 ? unf[0] + 1 : `${unf[0] + 1} – ${unf[unf.length - 1] + 1}`}</span><span style="font-size:28px;line-height:54px">${unf.length}</span><span class="chip nos">not fitted</span></button>` : '';
  return `<div class="potgrid">${tiles}${fold}</div>`;
}

// ---------------------------------------------------------------- sheets
const head = (cap) => `<div class="head"><span class="cap">${cap}</span><button class="btn sm" data-a="close" aria-label="close">✕</button></div>`;
function potGraph(ch) {
  const ph = hist(`pot:${ch}`, () => backend.potHistory(ch, 14)), thr = Rules.sensorWhy(state.ch[ch]) ? null : Rules.thrOf(planOfCh(ch));
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
  const ch = sheet.ch, c = state.ch[ch], k = look(ch), r = state.rules, plan = planOfCh(ch), max = state.t.maxDoseML;
  const ml = sheet.ml || Math.min(plan ? plan.dose : 250, max || Infinity);
  const pid = r ? Rules.potPlanId(r, ch) : '';
  const vBusy = busy.has(`valve:${ch}`), vWord = vBusy ? '…' : c.vState === 2 ? 'open' : c.vState === 1 ? 'closed' : '?';
  return `${head(`Pot ${ch + 1}`)}
  <div class="row"><input class="inline-edit name" data-f="name" value="${esc(state.potNames[ch] || '')}" placeholder="Pot ${ch + 1}" aria-label="name">${fitted(c) ? chip(k) : ''}<span class="sp"></span>${Rules.sensorWhy(c) ? '' : `<span class="big">${c.pct}<small> %</small></span>`}</div>
  <div class="setrow"><span class="lab">Sensor</span>${sensorChip(c)}<span class="sp"></span><span class="faint">${c.raw} ±${c.sd}</span></div>
  <div class="setrow"><span class="lab">Valve</span>${valveSvg(c.vState, 28)}<b>${vWord}</b><span class="sp"></span><button class="switch" role="switch" aria-checked="${c.vState === 2}" data-a="valve" aria-label="valve"${vBusy ? ' disabled' : ''}></button></div>
  ${potGraph(ch)}
  <div class="row wrap"><input class="num" id="wml" type="number" inputmode="numeric" step="10" min="10" ${max ? `max="${max}"` : ''} value="${ml}" aria-label="mL"><span>mL</span><button class="btn primary sp" data-a="water"${dis(`water:${ch}`)}>💧 Water · <span id="wmlb">${ml}</span> mL</button></div>
  <div class="setrow"><span class="lab">Plan</span>${r ? `<select class="num" data-f="plan" aria-label="plan">${r.plans.map(p => `<option value="${p.id}" ${pid === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="off" ${pid === 'off' ? 'selected' : ''}>off</option></select>${pid !== 'off' && Rules.sensorWhy(c) ? '<span class="chip dry" title="no sensor">⚠</span>' : ''}` : '<span class="faint">—</span>'}</div>
  <div class="setrow"><span class="lab">Fitted</span><span>Sensor</span><button class="switch" role="switch" aria-checked="${c.senEn}" data-a="en" data-k="s" aria-label="sensor fitted"${dis(`en:s${ch}`)}></button><span>Valve</span><button class="switch" role="switch" aria-checked="${c.valEn}" data-a="en" data-k="v" aria-label="valve fitted"${dis(`en:v${ch}`)}></button></div>
  <div class="setrow"><span class="lab">Calibrate</span><button class="btn sm ${sheet.cal && sheet.cal.kind === 'air' ? 'on' : ''}" data-a="cal-open" data-k="air">Air & water</button><button class="btn sm ${sheet.cal && sheet.cal.kind === 'soil' ? 'on' : ''}" data-a="cal-open" data-k="soil">Dry & wet soil</button></div>
  ${sheet.cal ? calGuide(ch) : ''}
  <div class="setrow"><span class="lab">Valve µs</span></div>
  <div class="btns"><label class="row">open<input class="num" id="vo" type="number" inputmode="numeric" step="10" value="${c.vOpenUs ?? ''}" style="width:100%" aria-label="open µs"></label><label class="row">closed<input class="num" id="vc" type="number" inputmode="numeric" step="10" value="${c.vClosedUs ?? ''}" style="width:100%" aria-label="closed µs"></label></div>
  <div class="btns"><button class="btn sm" data-a="servo-test"${dis(`valve:${ch}`)}>Test</button><button class="btn sm" data-a="servo-ask">Apply</button></div>
  ${sheet.ask === 'servo' ? `<div class="btns"><button class="btn primary sm" data-a="servo-apply" data-v="0"${dis('servo')}>This valve</button><button class="btn sm" data-a="servo-apply" data-v="1"${dis('servo')}>All valves</button></div>` : ''}`;
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
const dryText = (p) => (p.mode === 'range' ? `${p.min}–${p.max} %` : p.mode === 'max' ? `max ${p.thr} %` : `min ${p.thr} %`);
function plansSheet() {
  if (sheet.edit) return planEditor();
  const r = state.rules;
  const rows = r ? r.plans.map(p => `<div class="planrow ${Rules.isOn(p) ? '' : 'off'}"><button class="open" data-a="plan-edit" data-id="${p.id}"><b>${r.default === p.id ? '★ ' : ''}${esc(p.name)}</b><span class="faint">${p.times.join(' · ') || '▶'} · ${dryText(p)} · ${p.dose} mL · ${potsOn(r, p.id).join(' ') || '—'}</span></button><button class="switch" role="switch" aria-checked="${Rules.isOn(p)}" data-a="plan-on" data-id="${p.id}" aria-label="on"${dis('rules')}></button></div>`).join('') : '';
  return `${head('Plans')}${rows}${!r || Rules.nextId(r) ? '<button class="btn" data-a="plan-new">+ Plan</button>' : ''}`;
}
function dayLine(times) {
  const w = 320; let s = `<rect x="0" y="18" width="${w}" height="10" rx="5" fill="var(--track)"/>`;
  [0, 6, 12, 18, 24].forEach(h => { s += `<text x="${Math.min(w - 8, Math.max(8, h / 24 * w))}" y="46" text-anchor="middle" font-size="10" fill="var(--text-3)">${pad(h)}</text>`; });
  times.forEach(tm => { const X = (+tm.slice(0, 2) + +tm.slice(3) / 60) / 24 * w; s += `<g data-a="t-del" data-t="${tm}" role="button" aria-label="remove ${tm}"><circle cx="${X}" cy="23" r="13" fill="transparent"/><circle cx="${X}" cy="23" r="8" fill="var(--accent)"/><text x="${X}" y="11" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text)">${tm}</text></g>`; });
  return `<svg class="dayline" data-a="t-add" viewBox="-10 0 ${w + 20} 50" width="100%" role="img" aria-label="times">${s}</svg>`;
}
function bandSvg(p) {
  const W = 320, X = (v) => 4 + v / 100 * (W - 8), r = (a, b, f, o) => `<rect x="${X(a)}" y="8" width="${Math.max(0, X(b) - X(a))}" height="16" fill="${f}" ${o ? `opacity="${o}"` : ''}/>`;
  let s = p.mode === 'min' ? r(0, p.thr, 'var(--accent)', '.85') + r(p.thr, 100, 'var(--track)') : p.mode === 'max' ? r(0, p.thr, 'var(--accent)', '.85') + r(p.thr, 100, 'var(--red-soft)')
    : r(0, p.min, 'var(--accent)') + r(p.min, p.max, 'var(--accent)', '.35') + r(p.max, 100, 'var(--red-soft)');
  [0, 50, 100].forEach(v => { s += `<text x="${Math.min(W - 12, Math.max(10, X(v)))}" y="38" text-anchor="middle" font-size="10" fill="var(--text-3)">${v} %</text>`; });
  return `<svg viewBox="0 -4 ${W} 46" width="100%" role="img" aria-label="moisture">${s}<text x="4" y="4" font-size="9.5" fill="var(--text-3)">dry</text><text x="${W - 4}" y="4" text-anchor="end" font-size="9.5" fill="var(--text-3)">wet</text></svg>`;
}
const PV_ICON = { wet: '●', nosensor: '⚠', implausible: '✕', uncal: '?', tank: '▮', frost: '❄', off: '—' };
function previewRow(items) {
  if (!items.length) return '<div class="pv"><span>—</span></div>';
  return `<div class="pv">${items.map(it => `<span class="${it.action === 'water' ? 'w' : it.why === 'wet' ? '' : 'x'}" title="${esc(reasonText(it.why))}"><b>${it.ch + 1}</b>${it.action === 'water' ? `💧${it.ml}` : PV_ICON[it.why] || '·'}</span>`).join('')}</div>`;
}
function planEditor() {
  const d = sheet.draft, p = Rules.planById(d, sheet.edit), max = state.t.maxDoseML, isDef = d.default === p.id;
  const lvl = p.mode !== 'range';
  const slider = lvl ? `<div class="row"><div class="seg" style="width:150px"><button data-a="mode" data-v="min" aria-pressed="${p.mode === 'min'}">Min</button><button data-a="mode" data-v="max" aria-pressed="${p.mode === 'max'}">Max</button></div><span class="sp"></span><span class="big" id="dryv">${p.thr}<small> %</small></span></div><input type="range" id="thr" min="0" max="100" value="${p.thr}" aria-label="moisture">`
    : `<div class="row"><span class="sp"></span><span class="big" id="dryv">${p.min}–${p.max}<small> %</small></span></div><div class="dual"><input type="range" id="rmin" min="0" max="100" value="${p.min}" aria-label="min"><input type="range" id="rmax" min="0" max="100" value="${p.max}" aria-label="max"></div>`;
  const chips = state.ch.map((c, ch) => (c.valEn ? `<button data-a="tpot" data-ch="${ch}" class="${Rules.potPlanId(d, ch) === p.id ? 'on' : ''}">${ch + 1} ${esc(potName(ch))}${Rules.sensorWhy(c) ? ' <span class="warn" title="no sensor">⚠</span>' : ''}</button>` : '')).join('');
  return `<div class="head"><button class="btn sm" data-a="plan-back" aria-label="back">◀</button><span class="cap">Plan</span><button class="btn sm" data-a="close" aria-label="close">✕</button></div>
  <div class="row"><input class="inline-edit name" id="pname" value="${esc(p.name)}" maxlength="16" aria-label="name"><button class="btn sm ${isDef ? 'on' : ''}" data-a="plan-default" aria-label="default">★</button>${isDef || !Rules.planById(state.rules, p.id) ? '' : `<button class="btn sm" data-a="plan-del" aria-label="delete"${dis('rules')}>🗑</button>`}<span class="sp"></span><button class="switch" role="switch" aria-checked="${Rules.isOn(p)}" data-a="dplan-on" aria-label="on"></button></div>
  <div><b>When</b>${dayLine(p.times)}</div>
  <div class="seg"><button data-a="mode" data-v="level" aria-pressed="${lvl}">Level</button><button data-a="mode" data-v="range" aria-pressed="${!lvl}">Range</button></div>
  <div id="band">${bandSvg(p)}</div>${slider}
  <div class="row wrap"><input class="num" id="dose" type="number" inputmode="numeric" step="10" min="10" ${max ? `max="${max}"` : ''} value="${p.dose}" aria-label="mL"><span>mL</span>${[250, 500, 900].map(v => `<button class="btn sm ${p.dose === v ? 'on' : ''}" data-a="dose" data-v="${v}">${v}</button>`).join('')}</div>
  <div class="pchips">${chips}</div>
  ${sheet.test ? previewRow(sheet.test) : ''}
  <div class="btns"><button class="btn" data-a="plan-test">Test now</button><button class="btn primary" data-a="plan-apply"${dis('rules')}>Apply</button></div>`;
}
function runSheet() {
  const p = Rules.planById(state.rules, sheet.plan);
  return `${head('Run now')}<div class="row"><span class="big">${esc(p ? p.name : '—')}</span></div>${p ? previewRow(Rules.preview(state.rules, p.id, state.ch, ctx())) : ''}
  <div class="btns"><button class="btn" data-a="close">✕</button><button class="btn primary" data-a="run"${dis('run')}>▶ Run</button></div>`;
}
function unfittedSheet() {
  return `${head('Not fitted')}${state.ch.map((c, ch) => (fitted(c) ? '' : `<button class="listrow" data-a="pot" data-ch="${ch}"><b>${potLabel(ch)}</b><span class="sp"></span><span>›</span></button>`)).join('')}`;
}

// ---------------------------------------------------------------- render
const focusIn = (el) => { const a = document.activeElement; return a && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName); };
function render(force) {
  if (!state) return;
  const conn = connState(state.device, Date.now()), c = $('#conn');
  c.className = `conn ${conn}`; c.lastElementChild.textContent = ago(state.device.lastSeen);
  $('#downbar').hidden = !state.backendDown;
  const host = $(`#screen-${tab}`);
  if (force || !focusIn(host)) host.innerHTML = tab === 'home' ? chartCard() + stationCard() : potsGrid();
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${tab}`));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const sh = $('#sheet');
  sh.hidden = !sheet; document.body.style.overflow = sheet ? 'hidden' : '';
  if (sheet && (force || !focusIn(sh))) {
    const top = sh.scrollTop, fn = { pot: potSheet, tank: tankSheet, plans: plansSheet, run: runSheet, unfitted: unfittedSheet }[sheet.type];
    sh.innerHTML = `<div class="in">${fn()}</div>`; sh.scrollTop = top;
  }
}
function openSheet(s) { const same = sheet && sheet.type === s.type; sheet = s; if (!same) $('#sheet').scrollTop = 0; render(true); }

// ---------------------------------------------------------------- events
const dplan = () => Rules.planById(sheet.draft, sheet.edit);
async function onClick(e) {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, v = el.dataset.v, ch = el.dataset.ch !== undefined ? +el.dataset.ch : sheet && sheet.ch;
  switch (a) {
    case 'close': sheet = null; render(true); break;
    case 'pan': { const minOff = CH_AHEAD - CH_FWD, maxOff = CH_BACK - CH_DAYS + 1 + CH_AHEAD; chartOff = v === '0' ? 0 : Math.max(minOff, Math.min(maxOff, chartOff - (+v) * 7)); render(true); break; }
    case 'pot': openSheet({ type: 'pot', ch }); break;
    case 'tank': openSheet({ type: 'tank' }); break;
    case 'plans': openSheet({ type: 'plans' }); break;
    case 'unfitted': openSheet({ type: 'unfitted' }); break;
    case 'run-ask': { const b = bannerPlan(); if (b) openSheet({ type: 'run', plan: b.plan.id }); break; }
    case 'run': { const p = Rules.planById(state.rules, sheet.plan); sheet = null; render(true); cmd('run', { plan: p.id }, 'run', `▶ ${p.name}`); break; }
    case 'stop': cmd('stop', {}, 'stop', '■ STOP'); break;
    case 'vall': cmd('valves_all', { open: v === '1' }, 'valves_all', v === '1' ? 'Open all' : 'Close all'); break;
    case 'pump': if (v === '1') cmd('pump', { on: true }, 'pump', 'Pump'); else cmd('pump', { on: false }, 'pumpoff', 'Pump off'); break;
    // pot sheet
    case 'valve': { const open1 = state.ch[ch].vState !== 2; cmd('valve', { ch, open: open1 }, `valve:${ch}`, `Valve ${ch + 1}`); break; }
    case 'water': { const ml = intOf('#wml'), max = state.t.maxDoseML; if (!ml || (max && ml > max)) { toast(`✕ 10 – ${max || '…'} mL`); break; } sheet.ml = ml; cmd('water', { ch, ml }, `water:${ch}`, `Pot ${ch + 1}`); break; }
    case 'en': { const k = el.dataset.k, c = state.ch[ch], on = !(k === 's' ? c.senEn : c.valEn); cmd('en', { what: `${k}${ch + 1}`, on }, `en:${k}${ch}`, `${k === 's' ? 'Sensor' : 'Valve'} ${ch + 1}`); break; }
    case 'cal-open': { const k = el.dataset.k; sheet.cal = sheet.cal && sheet.cal.kind === k ? null : { kind: k, step: 0, a: null, b: null }; render(true); if (sheet.cal) cmd('refresh', {}, 'refresh', '↻', true); break; }
    case 'refresh': cmd('refresh', {}, 'refresh', '↻', true); break;
    case 'cal-rec': {
      const g = sheet.cal, soil = g.kind === 'soil', which = soil ? (g.step ? 'wet' : 'dry') : (g.step ? 'water' : 'air');
      const rec = await cmd(soil ? 'soil' : 'cal', { ch, which }, `cal:${ch}`, `Pot ${ch + 1} · ${which}`);
      if (rec && rec.status === 'acked' && sheet && sheet.cal === g) { const r = rec.result || {}; const val = soil ? (which === 'dry' ? r.soilDry : r.soilWet) : (which === 'air' ? r.air : r.water); if (g.step) g.b = val; else g.a = val; g.step++; render(true); }
      break; }
    case 'cal-again': sheet.cal = { kind: sheet.cal.kind, step: 0, a: null, b: null }; render(true); break;
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
    case 'mode': { const p = dplan(); p.mode = v === 'level' ? (sheet.lvl || 'min') : v; if (v === 'min' || v === 'max') sheet.lvl = v; sheet.test = null; render(true); break; }
    case 'dose': dplan().dose = +v; sheet.test = null; render(true); break;
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
  if (t.id === 'dose') { const v = Math.round(+t.value); if (v > 0) p.dose = v; sheet.test = null; return; }
  if (t.id === 'thr') p.thr = +t.value;
  else if (t.id === 'rmin') { p.min = Math.min(+t.value, p.max - 1); t.value = p.min; }
  else if (t.id === 'rmax') { p.max = Math.max(+t.value, p.min + 1); t.value = p.max; }
  else return;
  sheet.test = null; $('#band').innerHTML = bandSvg(p);
  $('#dryv').innerHTML = `${p.mode === 'range' ? `${p.min}–${p.max}` : p.thr}<small> %</small>`;
}
function onChange(e) {
  const t = e.target, f = t.dataset.f;
  if (f === 'name') backend.setPotName(sheet.ch, t.value.trim().slice(0, 24)).catch(err => toast(`✕ ${err.message}`));
  else if (f === 'plan') { const d = clone(state.rules); d.pots = Rules.setPot(d, sheet.ch, t.value); sendRules(d); }
  else if (f === 'tanksize') { const L = +String(t.value).replace(',', '.'); if (L > 0) cmd('tanksize', { ml: Math.round(L * 1000) }, 'tanksize', `Tank ${L} L`); }
  else if (f === 'fch') sheet.fch = +t.value;
  else if (/^(thr|rmin|rmax)$/.test(t.id)) render(true);
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
  backend.subscribe(s => { state = s; render(); });
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet) { sheet = null; render(true); return; }
    if (sheet || tab !== 'home' || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const b = document.querySelector(`[data-a="pan"][data-v="${e.key === 'ArrowLeft' ? -1 : 1}"]`); if (b && !b.disabled) b.click(); }
  });
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; sheet = null; window.scrollTo(0, 0); render(true); }));
  setInterval(() => render(), 15000);
  render(true);
}
main().catch(e => { document.body.insertAdjacentHTML('afterbegin', `<div class="downbar">✕ ${esc(e.message)}</div>`); });
