// rules.js — the watering plan (app/RULES.md): `rules v2` = up to four NAMED PLANS, one of them the default,
// and each pot picks a plan (or "off"). Validation, canonical JSON, the FNV hash the board reports, the v1 → v2
// migration, the per-plan trigger list, the per-pot decision shared by the mock and the Preview, and a 24 h
// simulation. Plain script: `window.Rules` in the browser, `module.exports` in node (rules.test.js). No DOM.
//
//   { v: 2,
//     plans: [ { id: "a", name: "Default", when: { times: ["07:00","19:00"] } | { everyMin: 720 },
//                mode: "dry" | "always", thr: 35, dose: 250, dailyML: 6000 } ],
//     default: "a",
//     pots: { "2": "b", "11": "off" } }            // 0-based ch → plan id or "off"; absent = the default plan
(function (root) {
'use strict';

const LIM = { thr: [1, 99], dose: [10, 2000], dailyML: [500, 20000], everyMin: [60, 10080], nTimes: 4, nPlans: 4, nameLen: 16, bytes: 2048 };
const IDS = ['a', 'b', 'c', 'd'];
const DOSE_WORD = { small: 250, large: 900 };
// The "How much" chip a dose belongs to: 250 → small, 900 → large, anything else → custom (shown with its value).
function doseKind(ml) { return ml === DOSE_WORD.small ? 'small' : ml === DOSE_WORD.large ? 'large' : 'custom'; }
// on(plan): a plan is on unless it carries `on: false` (rules v2, firmware 0.4.2). Off = its schedule never fires; its pots are not watered by schedule.
function isOn(plan) { return !!plan && plan.on !== false; }
const N_CH = 16;
const POT_BUDGET_DOSES = 2;          // interlock: a pot gets at most 2 × its plan's dose per day (firmware maxDoses)

function inRange(v, r) { return Number.isInteger(v) && v >= r[0] && v <= r[1]; }
function isTime(t) { return typeof t === 'string' && /^\d\d:\d\d$/.test(t) && +t.slice(0, 2) < 24 && +t.slice(3) < 60; }
function defaultPlan(id, name) { return { id, name, when: { times: ['07:00', '19:00'] }, mode: 'dry', thr: 35, dose: 250, dailyML: 6000 }; }
function empty() { return { v: 2, plans: [defaultPlan('a', 'Default')], default: 'a', pots: {} }; }

// ---------------------------------------------------------------- validate · normalize · compile · hash
// validate(obj) → null when fine, else an error string in the board's `detail` style ("plans[1].thr: 1–99").
function validate(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  if (o.v !== 2) return 'v: must be 2';
  if (!Array.isArray(o.plans) || !o.plans.length) return 'plans: 1–4 plans';
  if (o.plans.length > LIM.nPlans) return `plans: more than ${LIM.nPlans}`;
  const seen = new Set();
  for (let i = 0; i < o.plans.length; i++) {
    const p = o.plans[i], at = `plans[${i}]`;
    if (!p || typeof p !== 'object') return `${at}: must be an object`;
    if (!IDS.includes(p.id)) return `${at}.id: a–d`;
    if (seen.has(p.id)) return `${at}.id: duplicate`;
    seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim().length || p.name.length > LIM.nameLen) return `${at}.name: 1–${LIM.nameLen} characters`;
    if (!p.when || typeof p.when !== 'object') return `${at}.when: times or everyMin`;
    if (p.when.everyMin !== undefined) { if (!inRange(p.when.everyMin, LIM.everyMin) || p.when.everyMin % 60) return `${at}.when.everyMin: ${LIM.everyMin[0]}–${LIM.everyMin[1]}, whole hours`; }
    else if (!Array.isArray(p.when.times) || !p.when.times.length || p.when.times.length > LIM.nTimes || !p.when.times.every(isTime)) return `${at}.when.times: 1–${LIM.nTimes} times HH:MM`;
    if (p.mode !== 'dry' && p.mode !== 'always') return `${at}.mode: dry or always`;
    if (!inRange(p.thr, LIM.thr)) return `${at}.thr: ${LIM.thr[0]}–${LIM.thr[1]}`;
    if (!inRange(p.dose, LIM.dose)) return `${at}.dose: ${LIM.dose[0]}–${LIM.dose[1]}`;
    if (!inRange(p.dailyML, LIM.dailyML)) return `${at}.dailyML: ${LIM.dailyML[0]}–${LIM.dailyML[1]}`;
    if (p.on !== undefined && typeof p.on !== 'boolean') return `${at}.on: true or false`;
  }
  if (!seen.has(o.default)) return 'default: must be a plan id';
  if (!o.pots || typeof o.pots !== 'object' || Array.isArray(o.pots)) return 'pots: must be an object';
  for (const k of Object.keys(o.pots)) {
    if (!/^\d+$/.test(k) || !inRange(+k, [0, N_CH - 1])) return `pots.${k}: ch 0–15`;
    if (o.pots[k] !== 'off' && !seen.has(o.pots[k])) return `pots.${k}: plan id or "off"`;
  }
  return null;
}
// A fresh object in canonical shape and key order (deterministic JSON). Pots pointing at the default are dropped; `on` appears only when false.
function normalize(o) {
  const plans = (o.plans || []).map(p => {
    const q = {
      id: p.id, name: String(p.name || '').trim().slice(0, LIM.nameLen) || 'Plan',
      when: p.when && p.when.everyMin !== undefined ? { everyMin: p.when.everyMin } : { times: [...new Set((p.when && p.when.times) || [])].sort() },
      mode: p.mode === 'always' ? 'always' : 'dry', thr: p.thr, dose: p.dose, dailyML: p.dailyML,
    };
    if (p.on === false) q.on = false;
    return q;
  });
  const pots = {};
  Object.keys(o.pots || {}).map(Number).sort((a, b) => a - b).forEach(ch => { const v = o.pots[ch]; if (v !== undefined && v !== o.default) pots[ch] = v; });
  return { v: 2, plans, default: o.default, pots };
}
function compile(rules) { return JSON.stringify(normalize(rules)); }
// FNV-1a 32-bit over the string's bytes (the canonical JSON is ASCII) → 8 hex digits. The board hashes the same string.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
// The most common value in a list (ties → first seen), or `d` for an empty list.
function mode(list, d) { const c = {}; let best = d, n = 0; list.forEach(v => { c[v] = (c[v] || 0) + 1; if (c[v] > n) { n = c[v]; best = v; } }); return best; }
// migrate(v1) → v2: one plan "Default" (mode dry) from schedule[0] and the majority thr/dose in pots{}; `on:false` pots → "off".
// v1 drafts existed only on 2026-09-03 (the text-rules screen, replaced the same day) — delete migrate() and the v1 branch in fromJSON() after 2026-10-01.
// Per-pot thr/dose exceptions and the temp/rain/tank modifiers have no v2 equivalent and are dropped.
function migrate(v1) {
  const s = (v1.schedule || [])[0], pots = v1.pots || {};
  const when = s ? (s.everyMin ? { everyMin: s.everyMin } : { times: (s.at || []).slice(0, LIM.nTimes) }) : { times: ['07:00', '19:00'] };
  const vals = (f) => Object.keys(pots).map(k => pots[k][f]).filter(v => v !== undefined);
  const daily = v1.limits && v1.limits.dailyML !== undefined ? v1.limits.dailyML : 6000;
  const out = { v: 2, plans: [{ id: 'a', name: 'Default', when, mode: 'dry', thr: mode(vals('thr'), 35), dose: mode(vals('dose'), 250), dailyML: Math.max(LIM.dailyML[0], Math.min(LIM.dailyML[1], daily)) }], default: 'a', pots: {} };
  Object.keys(pots).forEach(k => { if (pots[k].on === false) out.pots[k] = 'off'; });
  return out;
}
// fromJSON(string|object) → { ok, rules, error }. A v1 document is migrated first.
function fromJSON(src) {
  let o = src;
  if (typeof src === 'string') { try { o = JSON.parse(src); } catch (e) { return { ok: false, error: 'not JSON: ' + e.message }; } }
  if (o && o.v === 1) o = migrate(o);
  const err = validate(o);
  return err ? { ok: false, error: err } : { ok: true, rules: normalize(o) };
}

// ---------------------------------------------------------------- plan helpers
function planById(rules, id) { return (rules.plans || []).find(p => p.id === id) || null; }
function potPlanId(rules, ch) { const v = rules.pots ? rules.pots[ch] : undefined; return v === undefined ? rules.default : v; }
function planOf(rules, ch) { const id = potPlanId(rules, ch); return id === 'off' ? null : planById(rules, id); }
function potsOf(rules, id, nFitted) { const out = []; for (let i = 0; i < nFitted; i++) if (potPlanId(rules, i) === id) out.push(i); return out; }
function nextId(rules) { return IDS.find(id => !planById(rules, id)) || null; }

// ---------------------------------------------------------------- triggers
// Every ON plan's rounds in (fromMs, toMs]: [{ t, plan }] in time order. lastRoundMs feeds the interval form. Off plans never fire.
function triggersBetween(rules, fromMs, toMs, lastRoundMs) {
  const out = [];
  (rules && rules.plans ? rules.plans : []).forEach(plan => {
    if (!isOn(plan)) return;
    const w = plan.when || {};
    if (w.everyMin) {
      let t = (lastRoundMs || fromMs) + w.everyMin * 60e3;
      while (t <= toMs) { if (t > fromMs) out.push({ t, plan }); t += w.everyMin * 60e3; }
      return;
    }
    const d0 = new Date(fromMs); d0.setHours(0, 0, 0, 0);
    for (let day = d0.getTime(); day <= toMs; day += 86400e3) {
      const dt = new Date(day);
      (w.times || []).forEach(hm => { const t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), +hm.slice(0, 2), +hm.slice(3)).getTime(); if (t > fromMs && t <= toMs) out.push({ t, plan }); });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}
function nextTrigger(rules, planId, nowMs, lastRoundMs) {
  const r = { plans: planId ? [planById(rules, planId)].filter(Boolean) : rules.plans };
  const t = triggersBetween(r, nowMs, nowMs + 8 * 86400e3, lastRoundMs);
  return t.length ? t[0].t : null;
}

// ---------------------------------------------------------------- the per-pot decision (the firmware's waterPot() order)
// world = { pots:[{ i, name, pct, sState(1 ok,2 implausible,3 uncal), todayML, senEn, valEn, ratePctPerH }], nFitted,
//           tempC|null, tankLeft, tankFull, reserve, minTempC, mlPerSec, maxPumpMs, havePCA, lastRoundMs }
// decide(plan, pot, world, planTodayML) → { action: 'water'|'skip', why, ml? }
//   dry:    water a pot BELOW thr, skip the rest as wet · always: water every pot, skip the ones ABOVE thr as wet
function decide(plan, p, world, planTodayML) {
  const skip = (why) => ({ action: 'skip', why });
  if (!p.valEn || !p.senEn) return skip('off');
  if (!world.havePCA) return skip('nopca');
  if (p.sState === 3) return skip('uncal');
  if (p.sState === 2) return skip('implausible');
  if (plan.mode === 'dry' ? p.pct >= plan.thr : p.pct > plan.thr) return skip('wet');
  if (world.tempC !== null && world.tempC !== undefined && world.tempC < world.minTempC) return skip('cold');
  let ml = plan.dose; const maxMs = world.maxPumpMs || 90000;
  if (1000 * ml / world.mlPerSec > maxMs) ml = Math.floor(maxMs / 1000 * world.mlPerSec / 10) * 10;
  if (world.tankLeft - ml < world.reserve) return skip('tank');
  if ((p.todayML || 0) + ml > POT_BUDGET_DOSES * plan.dose) return skip('budget');
  if ((planTodayML || 0) + ml > plan.dailyML) return skip('budget');
  return { action: 'water', why: plan.mode === 'dry' ? 'dry' : 'always', ml };
}
// preview(rules, planId, world) → { plan, would:[{ n (0-based ch), action, why, ml (water items) }], nextAt } | null when the plan
// does not exist. Lists the plan's own pots plus every pot set "off" (so the household sees where the water is NOT going).
function preview(rules, planId, world) {
  const plan = planById(rules, planId); if (!plan) return null;
  if (!isOn(plan)) return { plan: planId, would: [], nextAt: null, off: true };   // an off plan waters nothing: "plan X is off"
  const would = []; let planToday = 0;
  world.pots.forEach(p => { if (p.i < world.nFitted && potPlanId(rules, p.i) === planId) planToday += p.todayML || 0; });
  for (let i = 0; i < world.nFitted; i++) {
    const id = potPlanId(rules, i), p = world.pots[i];
    if (id === 'off') { would.push({ n: i, action: 'skip', why: 'off' }); continue; }
    if (id !== planId) continue;
    const d = decide(plan, p, world, planToday);
    if (d.action === 'water') { planToday += d.ml; would.push({ n: i, action: 'water', why: d.why, ml: d.ml }); }
    else would.push({ n: i, action: 'skip', why: d.why });
  }
  return { plan: planId, would, nextAt: nextTrigger(rules, planId, world.nowMs || Date.now(), world.lastRoundMs) };
}
// simulate(rules, world, fromMs, hours) → { rounds:[{ t, plan, watered:[{i,name,ml}], skipped:[{i,name,reason}], tankLeft }], notes, nextT }
function simulate(rules, world, fromMs, hours) {
  const toMs = fromMs + (hours || 24) * 3600e3;
  const pots = world.pots.map(p => Object.assign({}, p));
  let tank = world.tankLeft;
  const planToday = {}; pots.forEach(p => { if (p.i < world.nFitted) { const id = potPlanId(rules, p.i); planToday[id] = (planToday[id] || 0) + (p.todayML || 0); } });
  const trig = triggersBetween(rules, fromMs, toMs, world.lastRoundMs);
  const notes = [];
  (rules.plans || []).forEach(p => { if (!isOn(p)) notes.push(`Plan ${p.name} is off.`); });
  if (!trig.length) notes.push('No round falls in the next 24 h.');
  const rounds = []; let lastT = fromMs; let dayMark = new Date(fromMs).getDate();
  for (const tr of trig) {
    const hoursPassed = (tr.t - lastT) / 3600e3; lastT = tr.t;
    pots.forEach(p => { p.pct = Math.max(0, p.pct - (p.ratePctPerH || 0) * hoursPassed); });
    if (new Date(tr.t).getDate() !== dayMark) { dayMark = new Date(tr.t).getDate(); pots.forEach(p => p.todayML = 0); Object.keys(planToday).forEach(k => planToday[k] = 0); }
    const round = { t: tr.t, plan: tr.plan.id, watered: [], skipped: [], tankLeft: tank };
    rounds.push(round);
    const w = Object.assign({}, world, { tankLeft: tank });
    for (const i of potsOf(rules, tr.plan.id, world.nFitted)) {
      const p = pots[i], name = p.name || `Pot ${i + 1}`;
      const d = decide(tr.plan, p, w, planToday[tr.plan.id]);
      if (d.action === 'skip') { round.skipped.push({ i, name, reason: d.why }); continue; }
      tank -= d.ml; w.tankLeft = tank; p.todayML = (p.todayML || 0) + d.ml; planToday[tr.plan.id] = (planToday[tr.plan.id] || 0) + d.ml; p.pct = Math.min(95, p.pct + 45);
      round.watered.push({ i, name, ml: d.ml, sec: +(d.ml / world.mlPerSec).toFixed(1) });
    }
    round.tankLeft = tank;
  }
  return { rounds, notes, nextT: trig.length ? trig[0].t : null };
}
// planStatus(ctlHash, applied, currentHash) — the "controller uses this plan" chip. ctlHash = telemetry.rulesHash (the board
// hashes the exact string it RECEIVED; on the cloud path Postgres jsonb reorders the keys, so it need not equal the app's
// canonical hash). applied = { appliedHash, localHash } kept from the last acked `rules` command (null = never applied
// from this phone); currentHash = hash(compile(draft)) now.
function planStatus(ctlHash, applied, currentHash) {
  if (ctlHash === undefined) return { cls: 'uncal', label: 'controller cannot take a plan yet' };     // firmware before the watering plan
  if (applied && currentHash !== applied.localHash) return { cls: 'warn', label: 'changes not applied yet' };
  if (ctlHash && applied && ctlHash === applied.appliedHash) return { cls: 'info', label: 'controller uses this plan' };
  if (!ctlHash) return { cls: 'off', label: 'controller has no plan' };
  return { cls: 'warn', label: 'controller runs a different plan — Apply to overwrite' };
}
// worldFrom(state) — the simulation world from the app's State (backend.js shape); names from household.potNames.
function worldFrom(state, nowMs) {
  const t = state.telemetry, c = state.config, names = (state.household && state.household.potNames) || {};
  return { pots: state.pots.map(p => ({ i: p.i, name: names[p.i] ? `${p.i + 1} ${names[p.i]}` : `Pot ${p.i + 1}`, pct: p.pct, sState: p.sState, todayML: p.todayML, senEn: p.senEn, valEn: p.valEn, ratePctPerH: 0 })),
    nFitted: Math.min(t.nSensors, t.nServos), tempC: t.tempEn && t.tempOK ? t.tempC : null, tankLeft: t.tankLeft, tankFull: c.tankFull, reserve: c.tankReserve,
    minTempC: c.minTempC, mlPerSec: t.mlPerSec || 30, maxPumpMs: c.maxPumpMs, havePCA: state.device.havePCA !== false, lastRoundMs: state.lastRound ? state.lastRound.ts : null, nowMs: nowMs || Date.now() };
}

const Rules = { LIM, IDS, DOSE_WORD, POT_BUDGET_DOSES, doseKind, isOn, empty, defaultPlan, validate, normalize, compile, hash, migrate, fromJSON,
  planById, potPlanId, planOf, potsOf, nextId, triggersBetween, nextTrigger, decide, preview, simulate, worldFrom, planStatus };
if (typeof module !== 'undefined' && module.exports) module.exports = Rules; else root.Rules = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
