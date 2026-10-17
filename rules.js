// rules.js — the watering plan document (`rules v3`, app/RULES.md) and the ONE copy of the per-pot plan decision.
// Plain script: `window.Rules` in the browser, `module.exports` in node (rules.test.js). No DOM.
//
//   { v: 3,
//     plans: [ { id: "a", name: "Default", on: true, times: ["07:00","19:00"], dailyML?: 6000 } ],   // a plan = WHEN only
//     default: "a",
//     pots: { "6": "b", "10": "off" },        // 0-based ch → plan id or "off"; absent = the default plan
//     pot: [ { mode: "min" | "max" | "range", thr: 49, min: 35, max: 60, ml: 250 } × 16 ] }   // per pot (index = ch): moisture + plan amount
//
// v2 (firmware ≤ 0.5.1) carried mode/thr/min/max/dose on each plan; upgrade() hands them to the plan's pots, as the board does at boot.
// mode min   = water a pot when it is drier than thr
// mode max   = water every pot unless it is wetter than thr
// mode range = start when drier than min; keep watering at each following time until it reaches max (per-pot "filling")
(function (root) {
'use strict';

const IDS = ['a', 'b', 'c', 'd'];
const N_CH = 16, MAX_TIMES = 3, NAME_LEN = 16, MAX_BYTES = 2048;

function isTime(t) { return typeof t === 'string' && /^\d\d:\d\d$/.test(t) && +t.slice(0, 2) < 24 && +t.slice(3) < 60; }
function pctIn(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }   // the board's ranges: thr/min 1-99, max 1-100
function isOn(plan) { return !!plan && plan.on !== false; }
const POT_DEFAULT = { mode: 'min', thr: 35, min: 35, max: 60, ml: 250 };   // = the board's potSetInit()
function newPlan(id, name) { return { id, name, on: true, times: ['07:00'] }; }
function empty() { return { v: 3, plans: [newPlan('a', 'Default')], default: 'a', pots: {}, pot: Array.from({ length: N_CH }, () => Object.assign({}, POT_DEFAULT)) }; }
function potSet(rules, ch) { return Object.assign({}, POT_DEFAULT, rules && Array.isArray(rules.pot) && rules.pot[ch] || {}); }
// The pot array with pot ch's setting patched (the pot view saves this with `rules`).
function setPotSet(rules, ch, patch) { const a = []; for (let i = 0; i < N_CH; i++) a.push(potSet(rules, i)); Object.assign(a[ch], patch); return a; }
// v2 → v3: each pot takes its plan's (an off pot: the default plan's) mode/thr/min/max/dose. v3 passes through.
function upgrade(o) {
  if (!o || o.v !== 2 || !Array.isArray(o.plans)) return o;
  const byId = {}; o.plans.forEach(p => { byId[p.id] = p; });
  const pot = [];
  for (let ch = 0; ch < N_CH; ch++) {
    const id = o.pots && o.pots[ch] !== undefined ? o.pots[ch] : o.default, p = byId[id] || byId[o.default] || {};
    pot.push({ mode: p.mode, thr: p.thr, min: p.min, max: p.max, ml: p.dose });
  }
  return { v: 3, plans: o.plans.map(p => { const q = { id: p.id, name: p.name, on: p.on, times: p.times }; if (p.dailyML !== undefined) q.dailyML = p.dailyML; return q; }),
    default: o.default, pots: o.pots || {}, pot };
}

// validate(obj) → null when fine, else a short error in the board's `bad_rules` detail style ("plans[1].thr").
function validate(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  if (o.v === 1) return 'v1';
  if (o.v !== 3) return 'v';
  if (!Array.isArray(o.plans) || !o.plans.length || o.plans.length > IDS.length) return 'plans';
  const seen = new Set();
  for (let i = 0; i < o.plans.length; i++) {
    const p = o.plans[i], at = `plans[${i}]`;
    if (!p || typeof p !== 'object') return at;
    if (!IDS.includes(p.id) || seen.has(p.id)) return `${at}.id`;
    seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > NAME_LEN) return `${at}.name`;
    if (p.on !== undefined && typeof p.on !== 'boolean') return `${at}.on`;
    if (!Array.isArray(p.times) || p.times.length > MAX_TIMES || !p.times.every(isTime)) return `${at}.times`;
    if (['mode', 'thr', 'min', 'max', 'dose'].some(k => p[k] !== undefined)) return at;   // per pot since v3
    if (p.dailyML !== undefined && !(Number.isInteger(p.dailyML) && p.dailyML > 0)) return `${at}.dailyML`;
  }
  if (!seen.has(o.default)) return 'default';
  if (!o.pots || typeof o.pots !== 'object' || Array.isArray(o.pots)) return 'pots';
  for (const k of Object.keys(o.pots)) {
    if (!/^\d+$/.test(k) || +k >= N_CH) return `pots.${k}`;
    if (o.pots[k] !== 'off' && !seen.has(o.pots[k])) return `pots.${k}`;
  }
  if (o.pot !== undefined && (!Array.isArray(o.pot) || o.pot.length > N_CH)) return 'pot';
  for (let i = 0; i < (o.pot || []).length; i++) {
    const q = Object.assign({}, POT_DEFAULT, o.pot[i]), at = `pot[${i}]`;
    if (!o.pot[i] || typeof o.pot[i] !== 'object') return at;
    if (!['min', 'max', 'range'].includes(q.mode)) return `${at}.mode`;
    if (!pctIn(q.thr, 1, 99)) return `${at}.thr`;
    if (!pctIn(q.min, 1, 99)) return `${at}.min`;
    if (!pctIn(q.max, 1, 100)) return `${at}.max`;
    if (q.mode === 'range' && q.min >= q.max) return `${at}.min`;
    if (!Number.isInteger(q.ml) || q.ml < 10 || q.ml > 100000) return `${at}.ml`;
  }
  return null;
}
// Canonical shape and key order = the board's rulesSerialize() byte for byte (same rulesHash). Pots pointing at the default are
// dropped from pots{}; pot[] always has all 16 with thr/min/max (switching Min/Max ⇄ Range keeps a value); dailyML only when set.
function normalize(o) {
  o = upgrade(o);
  const plans = o.plans.map(p => {
    const q = { id: p.id, name: p.name.trim(), on: p.on !== false, times: [...new Set(p.times)].sort() };
    if (p.dailyML) q.dailyML = p.dailyML;
    return q;
  });
  const pots = {};
  Object.keys(o.pots || {}).map(Number).sort((a, b) => a - b).forEach(ch => { const v = o.pots[ch]; if (v !== o.default) pots[ch] = v; });
  const pot = [];
  for (let ch = 0; ch < N_CH; ch++) { const q = potSet(o, ch); pot.push({ mode: q.mode, thr: q.thr, min: q.min, max: q.max, ml: q.ml }); }
  return { v: 3, plans, default: o.default, pots, pot };
}
function compile(rules) { return JSON.stringify(normalize(rules)); }
// fromJSON(string|object) → { ok, rules, error }.
function fromJSON(src) {
  let o = src;
  if (typeof src === 'string') { try { o = JSON.parse(src); } catch (e) { return { ok: false, error: 'json' }; } }
  o = upgrade(o);
  const err = validate(o);
  if (err) return { ok: false, error: err };
  const rules = normalize(o);
  return compile(rules).length > MAX_BYTES ? { ok: false, error: 'size' } : { ok: true, rules };
}
// FNV-1a 32-bit over the string's bytes → 8 hex digits (the board's rulesHash).
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

function planById(rules, id) { return (rules && rules.plans || []).find(p => p.id === id) || null; }
function potPlanId(rules, ch) { const v = rules.pots ? rules.pots[ch] : undefined; return v === undefined ? rules.default : v; }
function planOf(rules, ch) { const id = potPlanId(rules, ch); return id === 'off' ? null : planById(rules, id); }
function nextId(rules) { return IDS.find(id => !planById(rules, id)) || null; }
// The "dry below" line of a pot's setting, for pictures (graph line, spider colour): min/max → thr, range → min.
function thrOf(ps) { return !ps ? null : ps.mode === 'range' ? ps.min : ps.thr; }
// pots{} after a tap on pot ch in plan id's chips: on another plan / off → here; on this plan → back to the default.
function togglePot(rules, ch, id) {
  const pots = Object.assign({}, rules.pots || {}), cur = potPlanId(rules, ch);
  if (cur === id && id === rules.default) return pots;
  if (cur === id || id === rules.default) delete pots[ch]; else pots[ch] = id;
  return pots;
}
// Assign pot ch to a plan id or 'off' (the pot view's picker).
function setPot(rules, ch, id) { const pots = Object.assign({}, rules.pots || {}); if (id === rules.default) delete pots[ch]; else pots[ch] = id; return pots; }

// Every ON plan's times in (fromMs, toMs]: [{ t, plan }] in time order.
function triggersBetween(rules, fromMs, toMs) {
  const out = [];
  (rules && rules.plans || []).forEach(plan => {
    if (!isOn(plan)) return;
    const d0 = new Date(fromMs);
    for (let k = 0; ; k++) {
      const day = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + k);
      if (day.getTime() > toMs) break;
      plan.times.forEach(hm => { const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), +hm.slice(0, 2), +hm.slice(3)).getTime(); if (t > fromMs && t <= toMs) out.push({ t, plan }); });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}
function nextTrigger(rules, nowMs) { const t = triggersBetween(rules, nowMs, nowMs + 2 * 86400e3); return t.length ? t[0] : null; }

// ---------------------------------------------------------------- the per-pot decision (firmware 0.5.0 order)
// sensorWhy(c) → null when the sensor gives a working reading, else why it does not (a plan then waters the pot blind).
function sensorWhy(c) {
  if (!c.senEn) return 'nosensor';
  if (c.sState === 1) return 'nosensor';
  if (c.sState === 2) return 'implausible';
  if (c.sState === 3) return 'uncal';
  return null;
}
// decide(ps, c, ctx) → { action: 'water'|'skip', why, ml?, filling }
//   ps  = the pot's setting (potSet: mode, thr, min, max, ml)
//   c   = one channel (state.ch[i]: senEn, valEn, sState, pct, filling?)
//   ctx = { maxDoseML, tankLeft, tankReserve, frost (true while the forecast low blocks watering) }
// filling = the pot's range-mode flag AFTER this decision (the board persists it).
function decide(ps, c, ctx) {
  const was = !!c.filling, skip = (why, filling) => ({ action: 'skip', why, filling: filling === undefined ? was : filling });
  if (!c.valEn) return skip('off');
  // no working sensor → no moisture check: the plan's dose every round (Theo 2026-10-13, firmware 0.5.1)
  let filling = was;
  if (!sensorWhy(c)) {
    filling = false;
    if (ps.mode === 'min') { if (!(c.pct < ps.thr)) return skip('wet', false); }
    else if (ps.mode === 'max') { if (c.pct > ps.thr) return skip('wet', false); }
    else {
      if (was ? c.pct >= ps.max : c.pct >= ps.min) return skip('wet', false);
      filling = true;
    }
  }
  if (ctx.frost) return skip('frost');
  let ml = ps.ml, why = 'watered';
  if (ctx.maxDoseML > 0 && ml > ctx.maxDoseML) { ml = ctx.maxDoseML; why = 'cap_trim'; }
  if (ctx.tankLeft - ml < ctx.tankReserve) return skip('tank');
  return { action: 'water', why, ml, filling };
}
// preview(rules, planId, chs, ctx) → [{ ch, action, why, ml? }] for every pot with a fitted valve on that plan (tank counted down).
function preview(rules, planId, chs, ctx) {
  if (!planById(rules, planId)) return [];
  let tank = ctx.tankLeft; const out = [];
  chs.forEach((c, ch) => {
    if (!c.valEn || potPlanId(rules, ch) !== planId) return;
    const d = decide(potSet(rules, ch), c, Object.assign({}, ctx, { tankLeft: tank }));
    if (d.action === 'water') tank -= d.ml;
    out.push({ ch, action: d.action, why: d.why, ml: d.ml });
  });
  return out;
}

const Rules = { IDS, N_CH, MAX_TIMES, POT_DEFAULT, isTime, isOn, newPlan, empty, potSet, setPotSet, upgrade, validate, normalize, compile, fromJSON, hash,
  planById, potPlanId, planOf, nextId, thrOf, togglePot, setPot, triggersBetween, nextTrigger, sensorWhy, decide, preview };
if (typeof module !== 'undefined' && module.exports) module.exports = Rules; else root.Rules = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
