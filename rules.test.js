// rules.test.js — run with:  node app/web/rules.test.js
// rules v3 (firmware 0.6.0 contract): validate · normalize/compile/hash · v2 upgrade · plan + pot helpers · triggers · decide() in
// min / max / range (hysteresis), sensorless pots watered blind, cap trim, tank, frost · preview().
'use strict';
const R = require('./rules.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
}

// the contract's example document: plans = when, pot[] = moisture + amount per pot (pot 7 = ch 6 on Herbs: range, 250 mL)
const PA = { mode: 'min', thr: 49, min: 35, max: 60, ml: 900 }, PB = { mode: 'range', thr: 49, min: 35, max: 60, ml: 250 };
const DOC = { v: 3, plans: [
  { id: 'a', name: 'Default', on: true, times: ['07:00', '19:00'] },
  { id: 'b', name: 'Herbs', on: false, times: ['08:30'] }],
  default: 'a', pots: { 6: 'b', 10: 'off' }, pot: Array.from({ length: 16 }, (_, ch) => ({ ...(ch === 6 ? PB : PA) })) };
// the same document in the v2 form (firmware ≤ 0.5.1): moisture + dose on the plans
const DOC2 = { v: 2, plans: [{ ...DOC.plans[0], mode: 'min', thr: 49, min: 35, max: 60, dose: 900 }, { ...DOC.plans[1], mode: 'range', thr: 49, min: 35, max: 60, dose: 250 }],
  default: 'a', pots: { 6: 'b', 10: 'off' } };
const bad = (patch) => { const o = JSON.parse(JSON.stringify(DOC)); patch(o); return R.validate(o); };

// ---- validate
eq('valid', R.validate(DOC), null);
eq('empty() valid', R.validate(R.empty()), null);
eq('v1 rejected', bad(o => { o.v = 1; }), 'v1');
eq('v2 not valid as such', bad(o => { o.v = 2; }), 'v');
eq('v other', bad(o => { o.v = 4; }), 'v');
eq('no plans', bad(o => { o.plans = []; }), 'plans');
eq('5 plans', bad(o => { o.plans = 'abcda'.split('').map((id, i) => ({ ...o.plans[0], id: 'abcd'[i % 4] })); }), 'plans');
eq('dup id', bad(o => { o.plans[1].id = 'a'; }), 'plans[1].id');
eq('id e', bad(o => { o.plans[1].id = 'e'; }), 'plans[1].id');
eq('name empty', bad(o => { o.plans[0].name = ' '; }), 'plans[0].name');
eq('name 17', bad(o => { o.plans[0].name = 'x'.repeat(17); }), 'plans[0].name');
eq('on string', bad(o => { o.plans[0].on = 'yes'; }), 'plans[0].on');
eq('times 4', bad(o => { o.plans[0].times = ['01:00', '02:00', '03:00', '04:00']; }), 'plans[0].times');
eq('times 3 ok', bad(o => { o.plans[0].times = ['01:00', '02:00', '03:00']; }), null);
eq('times empty ok (Run now only)', bad(o => { o.plans[0].times = []; }), null);
eq('time 24:00', bad(o => { o.plans[0].times = ['24:00']; }), 'plans[0].times');
eq('everyMin gone', bad(o => { delete o.plans[0].times; o.plans[0].everyMin = 720; }), 'plans[0].times');
eq('plan with mode refused', bad(o => { o.plans[0].mode = 'min'; }), 'plans[0]');
eq('plan with dose refused', bad(o => { o.plans[0].dose = 900; }), 'plans[0]');
eq('pot absent ok (defaults)', bad(o => { delete o.pot; }), null);
eq('pot 17 entries', bad(o => { o.pot.push({ ...PA }); }), 'pot');
eq('pot mode dry', bad(o => { o.pot[0].mode = 'dry'; }), 'pot[0].mode');
eq('pot thr 100', bad(o => { o.pot[0].thr = 100; }), 'pot[0].thr');
eq('pot thr 0', bad(o => { o.pot[0].thr = 0; }), 'pot[0].thr');
eq('pot max 100 ok', bad(o => { o.pot[6].max = 100; }), null);
eq('pot range min ≥ max', bad(o => { o.pot[6].min = 60; }), 'pot[6].min');
eq('pot ml 5', bad(o => { o.pot[0].ml = 5; }), 'pot[0].ml');
eq('pot ml 5000 ok (board trims)', bad(o => { o.pot[0].ml = 5000; }), null);
eq('dailyML optional bad', bad(o => { o.plans[0].dailyML = -1; }), 'plans[0].dailyML');
eq('default missing', bad(o => { o.default = 'c'; }), 'default');
eq('pots ch 16', bad(o => { o.pots[16] = 'a'; }), 'pots.16');
eq('pots unknown plan', bad(o => { o.pots[3] = 'c'; }), 'pots.3');

// ---- normalize / compile / fromJSON / hash
{
  const n = R.normalize({ ...DOC, plans: [{ ...DOC.plans[0], times: ['19:00', '07:00', '07:00'], on: undefined, dailyML: 6000 }], pots: { 10: 'off', 2: 'a' }, pot: [{ ml: 500, mode: 'max', thr: 85 }] });
  const P0 = '{"mode":"max","thr":85,"min":35,"max":60,"ml":500}', PD = '{"mode":"min","thr":35,"min":35,"max":60,"ml":250}';
  eq('normalize order + defaults filled', JSON.stringify(n), `{"v":3,"plans":[{"id":"a","name":"Default","on":true,"times":["07:00","19:00"],"dailyML":6000}],"default":"a","pots":{"10":"off"},"pot":[${[P0].concat(Array(15).fill(PD)).join(',')}]}`);
  eq('compile = normalize', R.compile(DOC), JSON.stringify(R.normalize(DOC)));
  eq('fromJSON string', R.fromJSON(JSON.stringify(DOC)).ok, true);
  eq('fromJSON v1', R.fromJSON({ v: 1, schedule: [] }).error, 'v1');
  eq('fromJSON bad json', R.fromJSON('{').error, 'json');
  eq('hash known', R.hash('abc'), '1a47e90b');
  eq('hash stable', R.hash(R.compile(DOC)), R.hash(R.compile(JSON.parse(JSON.stringify(DOC)))));
}

// ---- v2 → v3 (the board does the same at boot)
eq('upgrade v2 = DOC', R.compile(R.upgrade(DOC2)), R.compile(DOC));
eq('upgrade: off pot takes the default plan', R.upgrade(DOC2).pot[10], { mode: 'min', thr: 49, min: 35, max: 60, ml: 900 });
eq('fromJSON v2 upgrades', R.fromJSON(DOC2).rules.v, 3);
eq('upgrade leaves v3', R.upgrade(DOC), DOC);

// ---- helpers
eq('potPlanId default', R.potPlanId(DOC, 0), 'a');
eq('potPlanId b', R.potPlanId(DOC, 6), 'b');
eq('planOf off', R.planOf(DOC, 10), null);
eq('nextId', R.nextId(DOC), 'c');
eq('thrOf min', R.thrOf(R.potSet(DOC, 0)), 49);
eq('thrOf range', R.thrOf(R.potSet(DOC, 6)), 35);
eq('potSet default when absent', R.potSet({ v: 3 }, 3), R.POT_DEFAULT);
eq('setPotSet patches one pot', R.setPotSet(DOC, 2, { ml: 300 }).map(p => p.ml).slice(0, 4), [900, 900, 300, 900]);
eq('setPotSet keeps the document', DOC.pot[2].ml, 900);
eq('togglePot default → b', R.togglePot(DOC, 0, 'b'), { 0: 'b', 6: 'b', 10: 'off' });
eq('togglePot b → off', R.togglePot(DOC, 6, 'b'), { 6: 'off', 10: 'off' });
eq('togglePot off → default', R.togglePot(DOC, 10, 'a'), { 6: 'b' });
eq('togglePot default → off', R.togglePot(DOC, 0, 'a'), { 0: 'off', 6: 'b', 10: 'off' });
eq('setPot off', R.setPot(DOC, 1, 'off'), { 1: 'off', 6: 'b', 10: 'off' });
eq('setPot default', R.setPot(DOC, 6, 'a'), { 10: 'off' });

// ---- triggers (local time)
{
  const day = new Date(2026, 9, 11).getTime(), at = (h, m) => day + (h * 60 + (m || 0)) * 60e3;
  const t = R.triggersBetween(DOC, at(6), at(20));
  eq('triggers only ON plans', t.map(x => [x.plan.id, new Date(x.t).getHours()]), [['a', 7], ['a', 19]]);
  eq('trigger at exact end included', R.triggersBetween(DOC, at(6), at(7)).length, 1);
  eq('trigger at start excluded', R.triggersBetween(DOC, at(7), at(8)).length, 0);
  eq('nextTrigger rolls to tomorrow', new Date(R.nextTrigger(DOC, at(20)).t).getDate(), 12);
  const off = JSON.parse(JSON.stringify(DOC)); off.plans[0].on = false;
  eq('all off → none', R.nextTrigger(off, at(1)), null);
}

// ---- decide
const C = (o) => Object.assign({ senEn: true, valEn: true, sState: 0, pct: 40, filling: false }, o);
const X = { maxDoseML: 2700, tankLeft: 15000, tankReserve: 500, frost: false };
const min = PA, max = { ...PA, mode: 'max', thr: 70 }, range = PB;
eq('min dry → water', R.decide(min, C({ pct: 40 }), X), { action: 'water', why: 'watered', ml: 900, filling: false });
eq('min at thr → wet', R.decide(min, C({ pct: 49 }), X).why, 'wet');
eq('max below → water', R.decide(max, C({ pct: 69 }), X).action, 'water');
eq('max at thr → water', R.decide(max, C({ pct: 70 }), X).action, 'water');
eq('max above → wet', R.decide(max, C({ pct: 71 }), X).why, 'wet');
eq('range above min, not filling → wet', R.decide(range, C({ pct: 40 }), X), { action: 'skip', why: 'wet', filling: false });
eq('range below min → start filling', R.decide(range, C({ pct: 30 }), X), { action: 'water', why: 'watered', ml: 250, filling: true });
eq('range filling between → keep watering', R.decide(range, C({ pct: 50, filling: true }), X), { action: 'water', why: 'watered', ml: 250, filling: true });
eq('range filling reaches max → stop', R.decide(range, C({ pct: 60, filling: true }), X), { action: 'skip', why: 'wet', filling: false });
eq('valve not fitted', R.decide(min, C({ valEn: false }), X).why, 'off');
// no working sensor → the plan's dose every round, no moisture check (2026-10-13)
eq('sensor not fitted → water', R.decide(min, C({ senEn: false, pct: 80 }), X), { action: 'water', why: 'watered', ml: 900, filling: false });
eq('sensor swims → water', R.decide(max, C({ sState: 1, pct: -1 }), X).action, 'water');
eq('implausible → water', R.decide(max, C({ sState: 2, pct: 99 }), X).action, 'water');
eq('uncalibrated → water', R.decide(max, C({ sState: 3 }), X).action, 'water');
eq('no sensor still stops on frost', R.decide(min, C({ senEn: false }), { ...X, frost: true }).why, 'frost');
eq('no sensor still keeps the tank reserve', R.decide(min, C({ senEn: false }), { ...X, tankLeft: 1300 }).why, 'tank');
eq('no sensor keeps filling flag', R.decide(range, C({ sState: 1, filling: true }), X).filling, true);
eq('cap trim', R.decide({ ...min, ml: 3000 }, C(), X), { action: 'water', why: 'cap_trim', ml: 2700, filling: false });
eq('tank reserve', R.decide(min, C(), { ...X, tankLeft: 1300 }).why, 'tank');
eq('frost', R.decide(min, C(), { ...X, frost: true }).why, 'frost');
eq('frost does not hide wet', R.decide(min, C({ pct: 80 }), { ...X, frost: true }).why, 'wet');

// ---- preview: the plan's pots with a fitted valve, tank counted down
{
  const chs = []; for (let i = 0; i < 16; i++) chs.push(C({ pct: [30, 60, 20][i] ?? 50, valEn: i < 7, senEn: i !== 5 }));
  const pv = R.preview(DOC, 'a', chs, { ...X, tankLeft: 2000 });
  eq('preview a', pv.map(x => [x.ch, x.action, x.why]), [[0, 'water', 'watered'], [1, 'skip', 'wet'], [2, 'skip', 'tank'], [3, 'skip', 'wet'], [4, 'skip', 'wet'], [5, 'skip', 'tank']]);   // pot 6 has no sensor: it would be watered, but the tank is at its reserve
  eq('preview b (off plan still previews)', R.preview(DOC, 'b', chs, X).map(x => x.ch), [6]);
  eq('preview unknown', R.preview(DOC, 'z', chs, X), []);
}

// ---- rain skip (firmware 0.8.0): rainMM 1-50 + pot rain:false; serialized only when set; decide/preview skip pots rain reaches
{
  const base = R.normalize(DOC);
  eq('rain: no keys = same text', R.compile({ ...base }), R.compile(base));
  const r = { ...base, rainMM: 5, pot: base.pot.map((p, i) => (i === 1 ? { ...p, rain: false } : p)) };
  eq('rain: valid', R.validate(r), null);
  eq('rain: rainMM 0 refused', R.validate({ ...r, rainMM: 0 }), 'rainMM');
  eq('rain: rainMM 51 refused', R.validate({ ...r, rainMM: 51 }), 'rainMM');
  eq('rain: pot rain must be boolean', R.validate({ ...r, pot: r.pot.map((p, i) => (i ? p : { ...p, rain: 1 })) }), 'pot[0].rain');
  const t = R.compile(r);
  eq('rain: rainMM last', t.endsWith(',"rainMM":5}'), true);
  eq('rain: only rain:false written', (t.match(/"rain":false/g) || []).length, 1);
  eq('rain: rain:true dropped', R.compile({ ...r, pot: r.pot.map(p => ({ ...p, rain: true })) }).includes('"rain":'), false);
  eq('rain: hash = board (host test)', R.hash(R.compile({ v: 3, plans: [{ id: 'a', name: 'Default', on: true, times: ['07:00', '19:00'] }], default: 'a', pots: {},
    rainMM: 5, pot: Array.from({ length: 16 }, (_, i) => ({ mode: 'min', thr: 35, min: 35, max: 60, ml: 250, ...(i === 2 || i === 9 ? { rain: false } : {}) })) })), '8f9dfad0');
  const ctx = { maxDoseML: 1620, tankLeft: 15000, tankReserve: 500, frost: false };
  const dry = { valEn: true, senEn: true, sState: 0, pct: 10 };
  eq('rain: skips a pot rain reaches', R.decide(R.potSet(r, 0), dry, { ...ctx, rain: true }).why, 'rain');
  eq('rain: waters a pot under a roof', R.decide(R.potSet(r, 1), dry, { ...ctx, rain: true }).action, 'water');
  eq('rain: rainSkips at the limit', R.rainSkips(r, 5), true);
  eq('rain: rainSkips below / unknown / off', [R.rainSkips(r, 4.9), R.rainSkips(r, null), R.rainSkips(base, 30)], [false, false, false]);
  const pv = R.preview(r, 'a', Array.from({ length: 16 }, () => dry), { ...ctx, rainTodayMM: 8 });
  eq('rain: preview', pv.filter(x => x.why === 'rain').length, pv.filter(x => x.ch !== 1).length);
  eq('rain: preview without rain', R.preview(r, 'a', Array.from({ length: 16 }, () => dry), { ...ctx, rainTodayMM: 2 }).some(x => x.why === 'rain'), false);
}

// ---- plan defaults (app side): stored defaults win; else the first pot without own values; withDefaults spares own/off pots
{
  const base = R.normalize(DOC), none = () => false;
  const firstA = [...Array(16).keys()].find(ch => R.potPlanId(base, ch) === 'a');
  eq('planDefault: derived from the first pot', R.planDefault(base, null, none, 'a'), (({ mode, thr, min, max, ml }) => ({ mode, thr, min, max, ml }))(R.potSet(base, firstA)));
  eq('planDefault: stored wins', R.planDefault(base, { mode: 'max', thr: 70, min: 30, max: 80, ml: 400 }, none, 'a'), { mode: 'max', thr: 70, min: 30, max: 80, ml: 400 });
  eq('planDefault: bad stored ignored', R.planDefault(base, { mode: 'max', thr: 0, ml: 400 }, none, 'a').thr, R.potSet(base, firstA).thr);
  eq('planDefault: empty plan → POT_DEFAULT', R.planDefault({ ...base, pots: {} }, null, () => true, 'a'), (({ mode, thr, min, max, ml }) => ({ mode, thr, min, max, ml }))(R.POT_DEFAULT));
  const def = { mode: 'max', thr: 75, min: 19, max: 85, ml: 300 }, own = (ch) => ch === firstA;
  const r = { ...base, pot: base.pot.map((p, i) => (i === 0 ? { ...p, rain: false } : p)) };
  const out = R.withDefaults(r, (id) => (id === 'a' ? def : R.planDefault(r, null, own, id)), own);
  const onA = [...Array(16).keys()].filter(ch => R.potPlanId(r, ch) === 'a' && !own(ch));
  eq('withDefaults: plan pots get the defaults', onA.every(ch => out[ch].thr === 75 && out[ch].ml === 300 && out[ch].mode === 'max'), true);
  eq('withDefaults: own pot unchanged', out[firstA], R.potSet(r, firstA));
  eq('withDefaults: off pot unchanged', out[10], R.potSet(r, 10));
  eq('withDefaults: rain flag kept', out[0].rain === false || R.potPlanId(r, 0) !== 'a', true);
  eq('withDefaults: result valid', R.validate({ ...r, pot: out }), null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
