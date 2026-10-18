// backend.js — the ONE interface the UI talks to, and the shared helpers.
//
// createBackend() → mock.js (the fake 0.5.0 controller) · lan.js (the board on the home WiFi) · supabase.js (the cloud).
// Every backend offers (Promises unless noted):
//   init()                      load the first state, start polling / realtime
//   getState()                  current State (sync) · subscribe(fn) → unsubscribe
//   sendCommand(cmd, args)      → { status: 'acked'|'failed'|'expired'|'sent', result }  (app/SPEC.md Part 2 = the contract)
//   setPotName(ch, name)        household pot names
//   setPotLook(look)            household picture + wet level per pot, the whole map {ch: {e, wet}}
//   history(days, endOffsetDays) → { days, from, perDay:[{day, ml, n}], tank:[{ts, ml}], refills:[ts], levels:[ts] }
//   potHistory(ch, days)        → { moisture:[{ts, pct}], doses:[{ts, ml}] }
//   runs(days)                  → plan rounds, newest first: [{ts, plan, trigger, watered, skipped, refused, ml, tankLeft, pots:[{ch, ml, pct, why}]}]
//   login(email, pw, stay) / logout() / session()
//
// State: { device: {id, fw, ip, rssi, up, lastSeen, intervalS}, t: <top-level board state, mapPayload>, ch: [16 channels],
//          rules: <the plan document the board holds> | null, potNames: {ch: name}, potLook: {ch: {e: emoji, wet: %}}, mark: {ts, tankLeft} | null
//          (the last refill or level set), backendDown? }

const CONFIG = {
  backend: 'supabase',           // 'mock' · 'lan' · 'supabase'; the address bar overrides: index.html?backend=mock|lan|supabase
  lanHost: 'irrigation.local',  // LAN mode: the controller's name or IP (or index.html?host=192.168.1.42)
  supabaseUrl: 'https://aghudpkgpyptlkkazxgs.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnaHVkcGtncHlwdGxra2F6eGdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MzYzMDIsImV4cCI6MjEwNDAxMjMwMn0.xuugLFhQ-qc_GFqKGrC0SBkNrEcsIJg4MrrhxmcCFrs',
  deviceId: 'balcony-1',
};
// ?backend=lan only works from a page NOT served over https (a browser refuses http://irrigation.local from https).

async function createBackend() {
  let which = CONFIG.backend;
  try { const q = new URLSearchParams(location.search).get('backend'); if (q === 'mock' || q === 'supabase' || q === 'lan') which = q; } catch (e) { /* ignore */ }
  if (which === 'supabase') return createSupabaseBackend(CONFIG);
  if (which === 'lan') return createLanBackend(CONFIG);
  return createMockBackend(CONFIG);
}

const N_CH = 16;
const FROST_C = 3, FROST_FRESH_S = 6 * 3600;

// The board's state (cloud telemetry payload = LAN /api/state, same names — contract) → the app's { t, ch }.
function mapPayload(p) {
  p = p || {};
  const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d), s = (v) => (typeof v === 'string' ? v : '');
  const t = {
    fw: s(p.fw), up: n(p.up, 0), mlPerSec: n(p.mlPerSec, null), maxDoseML: n(p.maxDoseML, null), maxPumpMs: n(p.maxPumpMs, null),
    tankLeft: n(p.tankLeft, 0), tankFullML: n(p.tankFullML, null), tankReserve: n(p.tankReserve, 0),
    pumpRunning: p.pumpRunning === true, pumpEn: p.pumpEn !== false, rulesHash: s(p.rulesHash),
    planNext: n(p.planNext, 0) > 0 ? p.planNext * 1000 : null, planNextId: s(p.planNextId),
    running: p.running && typeof p.running === 'object' && Number.isInteger(p.running.ch)
      ? { plan: s(p.running.plan), ch: p.running.ch, ml: n(p.running.ml, 0), target: n(p.running.target, 0) } : null,
    queue: Array.isArray(p.queue) ? p.queue.filter(Number.isInteger) : [],
    frostMinC: n(p.frostMinC, null), frostAgeS: n(p.frostAgeS, null), rainTodayMM: n(p.rainTodayMM, null), rainAgeS: n(p.rainAgeS, null),
  };
  const src = Array.isArray(p.ch) ? p.ch : [], ch = [];
  for (let i = 0; i < N_CH; i++) {
    const c = src.find(x => x && x.i === i) || src[i] || {};
    ch.push({ i, in: n(c.in, i), senEn: c.senEn === true, valEn: c.valEn === true, raw: n(c.raw, 0), pct: n(c.pct, -1), sd: n(c.sd, 0), sState: n(c.sState, 1),
      air: n(c.air, -1), water: n(c.water, -1), soilDry: n(c.soilDry, -1), soilWet: n(c.soilWet, -1),
      vState: n(c.vState, 0), vOpenUs: n(c.vOpenUs, null), vClosedUs: n(c.vClosedUs, null),
      todayML: n(c.todayML, 0), lastML: n(c.lastML, 0), lastTs: n(c.lastTs, 0) > 0 ? c.lastTs * 1000 : null, lastWhy: s(c.lastWhy),
      filling: c.filling === true });
  }
  return { t, ch };
}
// True while the forecast low blocks every dose (Addendum 1: fresh < 6 h and below 3 °C).
function frostBlocks(t) { return t.frostMinC !== null && t.frostAgeS !== null && t.frostAgeS < FROST_FRESH_S && t.frostMinC < FROST_C; }
// Today's rain sum the board holds (fw 0.8.0, pushed hourly by the cloud), or null when unknown or stale (> 6 h) — as the board decides.
function rainToday(t) { return t.rainTodayMM !== null && t.rainTodayMM !== undefined && t.rainAgeS !== null && t.rainAgeS < FROST_FRESH_S ? t.rainTodayMM : null; }

// Reason codes → a short label (toasts, preview chips). One table for every backend.
const REASON_TEXT = {
  wet: 'wet', nosensor: 'no sensor', implausible: 'sensor fault', uncal: 'not calibrated', tank: 'tank reserve', cap_trim: 'trimmed to max',
  off: 'not fitted', nopca: 'no valve driver', too_much: 'over max', frost: 'frost', rain: 'rain', bad_rules: 'plan refused', no_plan: 'no plan',
  budget: 'daily limit', estop: 'stopped', pump_disabled: 'pump off', badargs: 'bad value', not_recorded: 'not recorded', refused: 'refused',
  expired: 'expired', busy: 'busy', timeout: 'no answer', transport: 'unreachable', unknown_cmd: 'unknown command', aborted: 'stopped',
};
function reasonText(r) { return REASON_TEXT[r] || (r ? String(r) : '—'); }

// Local midnight of the day containing ms, shifted by k days (DST-safe: never "midnight + k × 24 h").
function dayStart(ms, k) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (k || 0)).getTime(); }

// Controller freshness from lastSeen and the telemetry interval.
function connState(device, now) {
  if (!device.lastSeen) return 'offline';
  const age = (now - device.lastSeen) / 1000;
  if (age > 3 * device.intervalS) return 'offline';
  if (age > 2 * device.intervalS) return 'stale';
  return 'online';
}

// History from what a backend holds in memory: readings [{ts, tankLeft}] + events [{ts, kind, ml, tankLeft}] (mock, LAN, cloud fallback).
function historyFromLocal(readings, events, days, now, endOffsetDays) {
  const from = dayStart(now, -((endOffsetDays || 0) + days - 1)), to = dayStart(from, days), inWin = (ts) => ts >= from && ts < to;
  const perDay = []; for (let i = 0; i < days; i++) perDay.push({ day: dayStart(from, i), ml: 0, n: 0 });
  events.forEach(e => {
    if (e.kind !== 'dose' || !inWin(e.ts)) return;
    let i = days - 1; while (i > 0 && e.ts < perDay[i].day) i--;
    perDay[i].ml += e.ml || 0; perDay[i].n++;
  });
  const hours = new Map();
  readings.forEach(r => { if (!inWin(r.ts)) return; const h = Math.floor(r.ts / 3600e3); const b = hours.get(h) || { s: 0, n: 0 }; b.s += r.tankLeft; b.n++; hours.set(h, b); });
  const tank = [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, b]) => ({ ts: h * 3600e3, ml: Math.round(b.s / b.n) }));
  const at = (kind) => events.filter(e => e.kind === kind && inWin(e.ts)).map(e => e.ts).sort((a, b) => a - b);
  return { days, from, perDay, tank, refills: at('refill'), levels: at('level') };
}

// Plan rounds from events [{ts, kind, ch, ml, pct, reason, plan, trigger, watered, skipped, refused, tankLeft}] (any order).
// The board posts one `round` event at the END of a round; its pots are the plan doses (dose with a plan) and the
// refused events since the previous round, at most RUN_WIN before it. Skipped pots (wet, not fitted, no sensor, frost) carry no event → count only.
const RUN_WIN = 15 * 60e3;
function runsFromEvents(events, from) {
  const ev = events.filter(e => e && e.ts).sort((a, b) => a.ts - b.ts), runs = [];
  let prev = -Infinity;
  ev.forEach(e => {
    if (e.kind !== 'round') return;
    const lo = Math.max(prev, e.ts - RUN_WIN), win = ev.filter(x => x.ts > lo && x.ts <= e.ts);
    const doses = win.filter(x => x.kind === 'dose' && x.plan).map(x => ({ ch: x.ch, ml: x.ml || 0, pct: Number.isFinite(x.pct) ? x.pct : null, why: x.trimmed ? 'cap_trim' : 'ok' }));
    const nRef = e.refused || 0, refs = (nRef ? win.filter(x => x.kind === 'refused' && Number.isInteger(x.ch)).slice(-nRef) : [])
      .map(x => ({ ch: x.ch, ml: 0, pct: Number.isFinite(x.pct) && x.pct >= 0 ? x.pct : null, why: x.reason || 'refused' }));
    prev = e.ts;
    if (e.ts < (from || 0)) return;
    runs.push({ ts: e.ts, plan: e.plan || '', trigger: e.trigger || '', watered: e.watered || 0, skipped: e.skipped || 0, refused: e.refused || 0,
      ml: doses.reduce((a, d) => a + d.ml, 0), tankLeft: Number.isFinite(e.tankLeft) ? e.tankLeft : null, pots: doses.concat(refs).sort((a, b) => a.ch - b.ch) });
  });
  return runs.reverse();
}

// Find sensor: two reads (raw[16] + sd[16] per pot, from refresh) — before, and with the sensor in water. The one steady input
// (sd ≤ the board's 60, raw 100–4000, in both reads) that moved ≥ 300 counts, clearly more than any other, is the sensor.
// → { k: pot index whose input moved } | { k: -1, moved: [pot indexes] } (none, or several close together)
const FIND_MIN = 300;
function findSensor(a, b) {
  const ok = (r, i) => r.sd[i] <= 60 && r.raw[i] >= 100 && r.raw[i] <= 4000;
  const m = a.raw.map((x, i) => ({ i, d: ok(a, i) && ok(b, i) ? Math.abs(x - b.raw[i]) : 0 })).filter(x => x.d >= FIND_MIN).sort((x, y) => y.d - x.d);
  return m.length && (m.length === 1 || m[1].d < m[0].d / 2) ? { k: m[0].i, d: m[0].d } : { k: -1, moved: m.map(x => x.i) };
}
if (typeof module !== 'undefined') module.exports = { mapPayload, frostBlocks, rainToday, connState, historyFromLocal, runsFromEvents, reasonText, dayStart, findSensor };   // backend.test.js
