// rules.js — the watering plan document (`rules v2`, app/RULES.md) and the ONE copy of the per-pot plan decision.
// Plain script: `window.Rules` in the browser, `module.exports` in node (rules.test.js). No DOM.
//
//   { v: 2,
//     plans: [ { id: "a", name: "Default", on: true, times: ["07:00","19:00"],
//                mode: "min" | "max" | "range", thr: 49, min: 35, max: 60, dose: 900, dailyML?: 6000 } ],
//     default: "a",
//     pots: { "6": "b", "10": "off" } }        // 0-based ch → plan id or "off"; absent = the default plan
//
// mode min   = water a pot when it is drier than thr
// mode max   = water every pot unless it is wetter than thr
// mode range = start when drier than min; keep watering at each following time until it reaches max (per-pot "filling")
(function (root) {
'use strict';

const IDS = ['a', 'b', 'c', 'd'];
const N_CH = 16, MAX_TIMES = 3, NAME_LEN = 16, MAX_BYTES = 2048;

function isTime(t) { return typeof t === 'string' && /^\d\d:\d\d$/.test(t) && +t.slice(0, 2) < 24 && +t.slice(3) < 60; }
function pctOk(v) { return Number.isInteger(v) && v >= 0 && v <= 100; }
function isOn(plan) { return !!plan && plan.on !== false; }
function newPlan(id, name) { return { id, name, on: true, times: ['07:00'], mode: 'min', thr: 40, min: 35, max: 60, dose: 250 }; }
function empty() { return { v: 2, plans: [newPlan('a', 'Default')], default: 'a', pots: {} }; }

// validate(obj) → null when fine, else a short error in the board's `bad_rules` detail style ("plans[1].thr").
function validate(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  if (o.v === 1) return 'v1';
  if (o.v !== 2) return 'v';
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
    if (!['min', 'max', 'range'].includes(p.mode)) return `${at}.mode`;
    if (p.mode === 'range' ? !(pctOk(p.min) && pctOk(p.max) && p.min < p.max) : !pctOk(p.thr)) return `${at}.${p.mode === 'range' ? 'min/max' : 'thr'}`;
    if (!Number.isInteger(p.dose) || p.dose <= 0) return `${at}.dose`;
    if (p.dailyML !== undefined && !(Number.isInteger(p.dailyML) && p.dailyML > 0)) return `${at}.dailyML`;
  }
  if (!seen.has(o.default)) return 'default';
  if (!o.pots || typeof o.pots !== 'object' || Array.isArray(o.pots)) return 'pots';
  for (const k of Object.keys(o.pots)) {
    if (!/^\d+$/.test(k) || +k >= N_CH) return `pots.${k}`;
    if (o.pots[k] !== 'off' && !seen.has(o.pots[k])) return `pots.${k}`;
  }
  return null;
}
// Canonical shape and key order (deterministic JSON). Pots pointing at the default are dropped; thr/min/max are always kept
// so switching Level ⇄ Range does not lose a value; dailyML only when the board's document carries one.
function normalize(o) {
  const plans = o.plans.map(p => {
    const q = { id: p.id, name: p.name.trim(), on: p.on !== false, times: [...new Set(p.times)].sort(), mode: p.mode,
      thr: pctOk(p.thr) ? p.thr : 40, min: pctOk(p.min) ? p.min : 35, max: pctOk(p.max) ? p.max : 60, dose: p.dose };
    if (p.dailyML !== undefined) q.dailyML = p.dailyML;
    return q;
  });
  const pots = {};
  Object.keys(o.pots || {}).map(Number).sort((a, b) => a - b).forEach(ch => { const v = o.pots[ch]; if (v !== o.default) pots[ch] = v; });
  return { v: 2, plans, default: o.default, pots };
}
function compile(rules) { return JSON.stringify(normalize(rules)); }
// fromJSON(string|object) → { ok, rules, error }.
function fromJSON(src) {
  let o = src;
  if (typeof src === 'string') { try { o = JSON.parse(src); } catch (e) { return { ok: false, error: 'json' }; } }
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
// The "dry below" line of a plan, for pictures (tile soil line, spider colour): min/max → thr, range → min.
function thrOf(plan) { return !plan ? null : plan.mode === 'range' ? plan.min : plan.thr; }
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
// decide(plan, c, ctx) → { action: 'water'|'skip', why, ml?, filling }
//   c   = one channel (state.ch[i]: senEn, valEn, sState, pct, filling?)
//   ctx = { maxDoseML, tankLeft, tankReserve, frost (true while the forecast low blocks watering) }
// filling = the pot's range-mode flag AFTER this decision (the board persists it).
function decide(plan, c, ctx) {
  const was = !!c.filling, skip = (why, filling) => ({ action: 'skip', why, filling: filling === undefined ? was : filling });
  if (!c.valEn) return skip('off');
  // no working sensor → no moisture check: the plan's dose every round (Theo 2026-10-13, firmware 0.5.1)
  let filling = was;
  if (!sensorWhy(c)) {
    filling = false;
    if (plan.mode === 'min') { if (!(c.pct < plan.thr)) return skip('wet', false); }
    else if (plan.mode === 'max') { if (c.pct > plan.thr) return skip('wet', false); }
    else {
      if (was ? c.pct >= plan.max : c.pct >= plan.min) return skip('wet', false);
      filling = true;
    }
  }
  if (ctx.frost) return skip('frost');
  let ml = plan.dose, why = 'watered';
  if (ctx.maxDoseML > 0 && ml > ctx.maxDoseML) { ml = ctx.maxDoseML; why = 'cap_trim'; }
  if (ctx.tankLeft - ml < ctx.tankReserve) return skip('tank');
  return { action: 'water', why, ml, filling };
}
// preview(rules, planId, chs, ctx) → [{ ch, action, why, ml? }] for every pot with a fitted valve on that plan (tank counted down).
function preview(rules, planId, chs, ctx) {
  const plan = planById(rules, planId); if (!plan) return [];
  let tank = ctx.tankLeft; const out = [];
  chs.forEach((c, ch) => {
    if (!c.valEn || potPlanId(rules, ch) !== planId) return;
    const d = decide(plan, c, Object.assign({}, ctx, { tankLeft: tank }));
    if (d.action === 'water') tank -= d.ml;
    out.push({ ch, action: d.action, why: d.why, ml: d.ml });
  });
  return out;
}

const Rules = { IDS, N_CH, MAX_TIMES, isTime, isOn, newPlan, empty, validate, normalize, compile, fromJSON, hash,
  planById, potPlanId, planOf, nextId, thrOf, togglePot, setPot, triggersBetween, nextTrigger, sensorWhy, decide, preview };
if (typeof module !== 'undefined' && module.exports) module.exports = Rules; else root.Rules = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
