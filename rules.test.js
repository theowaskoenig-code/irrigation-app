// rules.test.js — run with:  node app/web/rules.test.js
// Covers rules v2: validate() with every field, normalize()/compile() canonical form and hash(), migrate() v1 → v2,
// the plan helpers, triggersBetween() per plan, decide() in both modes, preview() and simulate().
'use strict';
const R = require('./rules.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } }

// ---- the example document from RULES.md §1
const DOC = { v: 2,
  plans: [
    { id: 'a', name: 'Default', when: { times: ['07:00', '19:00'] }, mode: 'dry', thr: 35, dose: 250, dailyML: 6000 },
    { id: 'b', name: 'Thirsty', when: { everyMin: 720 }, mode: 'always', thr: 70, dose: 900, dailyML: 8000 }],
  default: 'a',
  pots: { 2: 'b', 11: 'off' } };

// ---- validate
eq('validate good', R.validate(DOC), null);
eq('validate empty()', R.validate(R.empty()), null);
const bad = (patch) => { const o = JSON.parse(JSON.stringify(DOC)); patch(o); return R.validate(o); };
eq('v', bad(o => o.v = 1), 'v: must be 2');
eq('not object', R.validate([]), 'not an object');
eq('no plans', bad(o => o.plans = []), 'plans: 1–4 plans');
ok('too many plans', /plans: more than 4/.test(bad(o => o.plans = ['a', 'b', 'c', 'd', 'a'].map(id => ({ ...o.plans[0], id })))));
eq('plan id', bad(o => o.plans[1].id = 'e'), 'plans[1].id: a–d');
eq('plan id dup', bad(o => o.plans[1].id = 'a'), 'plans[1].id: duplicate');
eq('plan name long', bad(o => o.plans[0].name = 'x'.repeat(17)), 'plans[0].name: 1–16 characters');
eq('plan name empty', bad(o => o.plans[0].name = ' '), 'plans[0].name: 1–16 characters');
eq('when missing', bad(o => delete o.plans[0].when), 'plans[0].when: times or everyMin');
eq('when times 5', bad(o => o.plans[0].when.times = ['01:00', '02:00', '03:00', '04:00', '05:00']), 'plans[0].when.times: 1–4 times HH:MM');
eq('when times bad', bad(o => o.plans[0].when.times = ['24:00']), 'plans[0].when.times: 1–4 times HH:MM');
eq('when times empty', bad(o => o.plans[0].when.times = []), 'plans[0].when.times: 1–4 times HH:MM');
eq('everyMin 90', bad(o => o.plans[1].when.everyMin = 90), 'plans[1].when.everyMin: 60–10080, whole hours');
eq('everyMin big', bad(o => o.plans[1].when.everyMin = 10140), 'plans[1].when.everyMin: 60–10080, whole hours');
eq('mode', bad(o => o.plans[0].mode = 'wet'), 'plans[0].mode: dry or always');
eq('thr', bad(o => o.plans[0].thr = 0), 'plans[0].thr: 1–99');
eq('thr 100', bad(o => o.plans[0].thr = 100), 'plans[0].thr: 1–99');
eq('dose', bad(o => o.plans[1].dose = 2001), 'plans[1].dose: 10–2000');
eq('dailyML low', bad(o => o.plans[0].dailyML = 400), 'plans[0].dailyML: 500–20000');
eq('dailyML high', bad(o => o.plans[0].dailyML = 20001), 'plans[0].dailyML: 500–20000');
eq('default unknown', bad(o => o.default = 'c'), 'default: must be a plan id');
eq('pots array', bad(o => o.pots = []), 'pots: must be an object');
eq('pots ch', bad(o => o.pots[16] = 'a'), 'pots.16: ch 0–15');
eq('pots value', bad(o => o.pots[3] = 'c'), 'pots.3: plan id or "off"');
eq('pots off ok', bad(o => o.pots[3] = 'off'), null);

// ---- normalize · compile · hash
{
  const j = R.compile(DOC);
  eq('canonical json', j, '{"v":2,"plans":[{"id":"a","name":"Default","when":{"times":["07:00","19:00"]},"mode":"dry","thr":35,"dose":250,"dailyML":6000},{"id":"b","name":"Thirsty","when":{"everyMin":720},"mode":"always","thr":70,"dose":900,"dailyML":8000}],"default":"a","pots":{"2":"b","11":"off"}}');
  ok('≤ 2 kB', j.length <= 2048);
  ok('hash is 8 hex', /^[0-9a-f]{8}$/.test(R.hash(j)));
  eq('hash stable', R.hash(j), R.hash(R.compile(JSON.parse(j))));
  ok('hash differs', R.hash(j) !== R.hash(j + ' '));
  eq('fnv-1a known value', R.hash('a'), 'e40c292c');
  eq('fromJSON(compile) == rules', R.fromJSON(j), { ok: true, rules: JSON.parse(j) });
  eq('normalize sorts times and pots, drops default pots', R.normalize({ v: 2, plans: [{ id: 'a', name: '  Def  ', when: { times: ['19:00', '07:00', '07:00'] }, mode: 'x', thr: 35, dose: 250, dailyML: 6000 }], default: 'a', pots: { 5: 'a', 3: 'off', 1: 'off' } }),
    { v: 2, plans: [{ id: 'a', name: 'Def', when: { times: ['07:00', '19:00'] }, mode: 'dry', thr: 35, dose: 250, dailyML: 6000 }], default: 'a', pots: { 1: 'off', 3: 'off' } });
  eq('doseKind', [R.doseKind(250), R.doseKind(900), R.doseKind(300), R.doseKind(10)], ['small', 'large', 'custom', 'custom']);
  // `on`: absent or true = on; only `on:false` survives normalize (canonical JSON, after dailyML)
  const offDoc = { v: 2, plans: [Object.assign({}, DOC.plans[0], { on: true }), Object.assign({}, DOC.plans[1], { on: false })], default: 'a', pots: {} };
  eq('validate on: bool ok', R.validate(offDoc), null);
  eq('validate on: not bool', R.validate({ v: 2, plans: [Object.assign({}, DOC.plans[0], { on: 1 })], default: 'a', pots: {} }), 'plans[0].on: true or false');
  eq('isOn', [R.isOn(offDoc.plans[0]), R.isOn(offDoc.plans[1]), R.isOn(DOC.plans[0])], [true, false, true]);
  ok('compile omits on:true, keeps on:false last', R.compile(offDoc).includes('"dailyML":8000,"on":false}') && !R.compile(offDoc).includes('"on":true'));
  ok('fromJSON bad json', !R.fromJSON('{').ok);
  ok('fromJSON not object', !R.fromJSON('[]').ok);
  eq('fromJSON error text', R.fromJSON({ v: 2, plans: [{ id: 'a', name: 'A', when: { times: ['07:00'] }, mode: 'dry', thr: 35, dose: 250, dailyML: 6000 }], default: 'b', pots: {} }).error, 'default: must be a plan id');
}
// worst case: 4 plans with 4 times, 16-char names, all 16 pots assigned
{
  const o = { v: 2, plans: R.IDS.map(id => ({ id, name: 'x'.repeat(16), when: { times: ['06:15', '12:30', '18:45', '23:59'] }, mode: 'always', thr: 99, dose: 2000, dailyML: 20000 })), default: 'd', pots: {} };
  for (let i = 0; i < 16; i++) o.pots[i] = i % 2 ? 'off' : 'a';
  eq('big validates', R.validate(o), null);
  ok(`big ≤ 2 kB (${R.compile(o).length})`, R.compile(o).length <= 2048);
}

// ---- migrate v1 → v2
{
  const v1 = { v: 1, schedule: [{ days: 'all', at: ['06:30', '20:00'], pots: 'dry' }], pots: { 0: { thr: 40, dose: 900 }, 1: { thr: 40, dose: 900 }, 2: { thr: 50, dose: 250, max: 1 }, 11: { on: false } },
    modifiers: [{ if: { k: 'rain', op: '>', v: 60, h: 12 }, then: { skip: true } }], limits: { dailyML: 4000 } };
  const m = R.fromJSON(v1);
  ok('v1 migrates', m.ok);
  eq('v1 → one Default plan', m.rules.plans, [{ id: 'a', name: 'Default', when: { times: ['06:30', '20:00'] }, mode: 'dry', thr: 40, dose: 900, dailyML: 4000 }]);
  eq('v1 → off pots', m.rules.pots, { 11: 'off' });
  eq('v1 default', m.rules.default, 'a');
  const iv = R.fromJSON({ v: 1, schedule: [{ everyMin: 360, pots: 'dry' }], pots: {}, modifiers: [], limits: { dailyML: 10000 } });
  eq('v1 interval', iv.rules.plans[0].when, { everyMin: 360 });
  eq('v1 no pots → defaults', [iv.rules.plans[0].thr, iv.rules.plans[0].dose, iv.rules.plans[0].dailyML], [35, 250, 10000]);
  const none = R.fromJSON({ v: 1, schedule: [], pots: {}, modifiers: [], limits: {} });
  eq('v1 no schedule → 07:00/19:00, 6 L', [none.rules.plans[0].when, none.rules.plans[0].dailyML], [{ times: ['07:00', '19:00'] }, 6000]);
  eq('v1 dailyML below 500 is clamped', R.fromJSON({ v: 1, schedule: [], pots: {}, modifiers: [], limits: { dailyML: 100 } }).rules.plans[0].dailyML, 500);
}

// ---- plan helpers
eq('planById', R.planById(DOC, 'b').name, 'Thirsty');
eq('planById missing', R.planById(DOC, 'c'), null);
eq('potPlanId', [R.potPlanId(DOC, 0), R.potPlanId(DOC, 2), R.potPlanId(DOC, 11)], ['a', 'b', 'off']);
eq('planOf off', R.planOf(DOC, 11), null);
eq('planOf default', R.planOf(DOC, 5).id, 'a');
eq('potsOf a', R.potsOf(DOC, 'a', 16), [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
eq('potsOf b clipped to fitted', R.potsOf(DOC, 'b', 2), []);
eq('potsOf off', R.potsOf(DOC, 'off', 16), [11]);
// togglePot: pure, and a pot belongs to exactly one plan
eq('toggle: default pot onto b', R.togglePot(DOC, 5, 'b'), { 2: 'b', 5: 'b', 11: 'off' });
eq('toggle: b pot tapped on b → back to the default', R.togglePot(DOC, 2, 'b'), { 11: 'off' });
eq('toggle: b pot tapped on a (default) → moves, entry omitted', R.togglePot(DOC, 2, 'a'), { 11: 'off' });
eq('toggle: default pot tapped on the default → stays', R.togglePot(DOC, 5, 'a'), { 2: 'b', 11: 'off' });
eq('toggle: off pot re-enabled into b', R.togglePot(DOC, 11, 'b'), { 2: 'b', 11: 'b' });
eq('toggle: off pot re-enabled into the default', R.togglePot(DOC, 11, 'a'), { 2: 'b' });
eq('toggle: does not touch the input', DOC.pots, { 2: 'b', 11: 'off' });
eq('nextId', R.nextId(DOC), 'c');
eq('nextId full', R.nextId({ plans: R.IDS.map(id => ({ id })) }), null);
eq('defaultPlan', R.defaultPlan('c', 'Herbs'), { id: 'c', name: 'Herbs', when: { times: ['07:00', '19:00'] }, mode: 'dry', thr: 35, dose: 250, dailyML: 6000 });

// ---- triggersBetween (per plan)
{
  const base = new Date(2026, 8, 3, 12, 0, 0).getTime();          // Thu 2026-09-03 12:00 local
  const tr = R.triggersBetween(DOC, base, base + 24 * 3600e3, base - 3600e3);
  eq('triggers in order with their plan', tr.map(x => [new Date(x.t).getHours(), x.plan.id]), [[19, 'a'], [23, 'b'], [7, 'a'], [11, 'b']]);
  eq('interval, no last round', R.triggersBetween({ plans: [DOC.plans[1]] }, base, base + 24 * 3600e3, null).map(x => (x.t - base) / 3600e3), [12, 24]);
  eq('exclusive from, inclusive to', R.triggersBetween({ plans: [DOC.plans[0]] }, new Date(2026, 8, 3, 7, 0).getTime(), new Date(2026, 8, 3, 19, 0).getTime(), null).map(x => new Date(x.t).getHours()), [19]);
  eq('no plans', R.triggersBetween({ plans: [] }, base, base + 86400e3, null), []);
  eq('nextTrigger of one plan', R.nextTrigger(DOC, 'a', base, null), new Date(2026, 8, 3, 19, 0).getTime());
  eq('nextTrigger any plan', R.nextTrigger(DOC, null, base, base - 11 * 3600e3), base + 3600e3);
  eq('nextTrigger unknown plan', R.nextTrigger(DOC, 'c', base, null), null);
}

// ---- decide · preview · simulate
function world(over) {
  const pots = [];
  for (let i = 0; i < 16; i++) pots.push({ i, name: `Pot ${i + 1}`, pct: 60, sState: 1, todayML: 0, senEn: true, valEn: true, ratePctPerH: 0 });
  pots[2].pct = 22; pots[6].pct = 30; pots[9].pct = 33; pots[11].sState = 2; pots[12].sState = 3; pots[13].senEn = false; pots[14].valEn = false;
  return Object.assign({ pots, nFitted: 16, tempC: 19.6, tankLeft: 15250, tankFull: 25000, reserve: 500, minTempC: 3, mlPerSec: 30, maxPumpMs: 90000, havePCA: true, lastRoundMs: null }, over || {});
}
const T0 = new Date(2026, 8, 3, 12, 0).getTime();
const dry = { id: 'a', name: 'Default', when: { times: ['19:00'] }, mode: 'dry', thr: 35, dose: 250, dailyML: 6000 };
const always = { id: 'b', name: 'Every time', when: { times: ['19:00'] }, mode: 'always', thr: 35, dose: 250, dailyML: 6000 };
{
  const w = world(), pot = (i, over) => Object.assign({}, w.pots[i], over || {});
  eq('dry: below thr waters', R.decide(dry, pot(2), w, 0), { action: 'water', why: 'dry', ml: 250 });
  eq('dry: at thr skips', R.decide(dry, pot(2, { pct: 35 }), w, 0), { action: 'skip', why: 'wet' });
  eq('always: above thr skips', R.decide(always, pot(0), w, 0), { action: 'skip', why: 'wet' });
  eq('always: at thr waters', R.decide(always, pot(0, { pct: 35 }), w, 0), { action: 'water', why: 'always', ml: 250 });
  eq('always: dry waters', R.decide(always, pot(2), w, 0), { action: 'water', why: 'always', ml: 250 });
  eq('off', R.decide(dry, pot(13), w, 0).why, 'off');
  eq('nopca', R.decide(dry, pot(2), Object.assign({}, w, { havePCA: false }), 0).why, 'nopca');
  eq('uncal', R.decide(dry, pot(12), w, 0).why, 'uncal');
  eq('implausible', R.decide(dry, pot(11), w, 0).why, 'implausible');
  eq('cold', R.decide(dry, pot(2), Object.assign({}, w, { tempC: 1 }), 0).why, 'cold');
  eq('no temperature = no frost check', R.decide(dry, pot(2), Object.assign({}, w, { tempC: null }), 0).action, 'water');
  eq('tank reserve', R.decide(dry, pot(2), Object.assign({}, w, { tankLeft: 700 }), 0).why, 'tank');
  eq('per-pot budget 2 × dose', R.decide(dry, pot(2, { todayML: 500 }), w, 0).why, 'budget');
  eq('per-pot budget one left', R.decide(dry, pot(2, { todayML: 250 }), w, 0).action, 'water');
  eq('plan daily cap', R.decide(dry, pot(2), w, 5800).why, 'budget');
  eq('90 s cap trims the dose', R.decide(Object.assign({}, dry, { dose: 2000 }), pot(2), Object.assign({}, w, { mlPerSec: 15 }), 0).ml, 1350);
}
{
  const rules = { v: 2, plans: [dry, always], default: 'a', pots: { 0: 'b', 1: 'b', 2: 'b', 11: 'off' } };
  const pa = R.preview(rules, 'a', Object.assign(world(), { nowMs: T0 }));
  eq('preview a: plan id', pa.plan, 'a');
  eq('preview a: waters the dry pots on plan a (0-based, with ml)', pa.would.filter(x => x.action === 'water').map(x => [x.n, x.ml]), [[6, 250], [9, 250]]);
  eq('preview a: skip reasons', pa.would.filter(x => x.action === 'skip').map(x => [x.n, x.why]), [[3, 'wet'], [4, 'wet'], [5, 'wet'], [7, 'wet'], [8, 'wet'], [10, 'wet'], [11, 'off'], [12, 'uncal'], [13, 'off'], [14, 'off'], [15, 'wet']]);
  ok('preview a: pots on plan b are not listed', !pa.would.some(x => x.n <= 2));
  eq('preview a: nextAt', pa.nextAt, new Date(2026, 8, 3, 19, 0).getTime());
  {
    const offRules = { v: 2, plans: [dry, Object.assign({}, always, { on: false })], default: 'a', pots: { 0: 'b', 1: 'b', 2: 'b', 11: 'off' } };
    eq('off plan: no triggers', R.triggersBetween(offRules, T0, T0 + 86400e3, null).map(x => x.plan.id), ['a']);
    eq('off plan: nextTrigger null', R.nextTrigger(offRules, 'b', T0, null), null);
    eq('off plan: preview says off', R.preview(offRules, 'b', Object.assign(world(), { nowMs: T0 })), { plan: 'b', would: [], nextAt: null, off: true });
    const sim = R.simulate(offRules, world(), T0, 24);
    eq('off plan: simulate notes it and runs only a', [sim.notes[0], sim.rounds.map(x => x.plan)], ['Plan Every time is off.', ['a']]);
  }
  const pb = R.preview(rules, 'b', Object.assign(world(), { nowMs: T0 }));
  eq('preview b: always waters dry, skips wet, lists the off pot', pb.would, [{ n: 0, action: 'skip', why: 'wet' }, { n: 1, action: 'skip', why: 'wet' }, { n: 2, action: 'water', why: 'always', ml: 250 }, { n: 11, action: 'skip', why: 'off' }]);
  eq('preview unknown plan', R.preview(rules, 'c', world()), null);
  const cap = R.preview({ v: 2, plans: [Object.assign({}, dry, { dailyML: 500 })], default: 'a', pots: {} }, 'a', world());
  eq('preview: plan cap counts within the list', cap.would.filter(x => x.action === 'water').map(x => x.n).concat(cap.would.filter(x => x.why === 'budget').map(x => x.n)), [2, 6, 9]);
}
{
  const rules = { v: 2, plans: [dry, Object.assign({}, always, { when: { everyMin: 360 }, dose: 900 })], default: 'a', pots: { 2: 'b', 11: 'off' } };
  const s = R.simulate(rules, world({ lastRoundMs: T0 - 3600e3 }), T0, 24);
  eq('sim rounds and plans', s.rounds.map(r => [new Date(r.t).getHours(), r.plan]), [[17, 'b'], [19, 'a'], [23, 'b'], [5, 'b'], [11, 'b']]);
  eq('sim round b waters pot 3 with 900', s.rounds[0].watered.map(w => [w.i, w.ml]), [[2, 900]]);
  eq('sim round a waters the dry pots on a', s.rounds[1].watered.map(w => w.i), [6, 9]);
  eq('sim round a skipped reasons', s.rounds[1].skipped.filter(x => x.reason !== 'wet').map(x => [x.i, x.reason]), [[12, 'uncal'], [13, 'off'], [14, 'off']]);
  eq('sim tank after two rounds', s.rounds[1].tankLeft, 15250 - 900 - 500);
  eq('sim second b round: pot 3 is wet now (always mode, 67 % > 35 %)', s.rounds[2].skipped.map(x => [x.i, x.reason]), [[2, 'wet']]);
  eq('sim next', s.nextT, T0 + 5 * 3600e3);
  eq('sim notes', s.notes, []);
  const w2 = world(); w2.pots.forEach(p => p.ratePctPerH = 3);
  const s2 = R.simulate({ v: 2, plans: [Object.assign({}, dry, { when: { everyMin: 360 } })], default: 'a', pots: {} }, w2, T0, 24);
  ok('sim drying makes more pots dry later', s2.rounds[1].watered.length > s2.rounds[0].watered.length);
  eq('sim no rounds note', R.simulate({ v: 2, plans: [Object.assign({}, dry, { when: { everyMin: 4800 } })], default: 'a', pots: {} }, world(), T0, 24).notes.length, 1);
}
{ // worldFrom(state)
  const st = { telemetry: { nSensors: 16, nServos: 15, tempEn: true, tempOK: true, tempC: 12.5, tankLeft: 9000, mlPerSec: 25 }, config: { tankFull: 25000, tankReserve: 500, minTempC: 3, maxPumpMs: 90000 }, device: { havePCA: true },
    household: { potNames: { 0: 'Basil' } }, lastRound: { ts: 123 }, pots: [{ i: 0, pct: 40, sState: 1, todayML: 250, senEn: true, valEn: true }] };
  const w = R.worldFrom(st, T0);
  eq('worldFrom', [w.nFitted, w.tempC, w.tankLeft, w.mlPerSec, w.lastRoundMs, w.nowMs, w.pots[0].name, w.pots[0].todayML], [15, 12.5, 9000, 25, 123, T0, '1 Basil', 250]);
  eq('worldFrom no temperature', R.worldFrom(Object.assign({}, st, { telemetry: Object.assign({}, st.telemetry, { tempOK: false }) })).tempC, null);
}
{ // planStatus — the "controller uses this plan" chip compares the BOARD's hash (of the string it received) with the one it acked
  const L = R.hash(R.compile(DOC)), B = 'b0a7d1e2';                        // L = our canonical hash, B = what the board computed (jsonb key order)
  const applied = { appliedHash: B, localHash: L };
  eq('chip: firmware without plans', R.planStatus(undefined, applied, L).cls, 'uncal');
  eq('chip: uses this plan (board hash ≠ canonical, = acked)', R.planStatus(B, applied, L).label, 'controller uses this plan');
  eq('chip: edited since apply', R.planStatus(B, applied, 'ffffffff').label, 'changes not applied yet');
  eq('chip: no plan on the controller', R.planStatus('', null, L).label, 'controller has no plan');
  eq('chip: never applied from this phone, board has a plan', R.planStatus(B, null, L).label, 'controller runs a different plan — Apply to overwrite');
  eq('chip: applied from another phone', R.planStatus('12345678', applied, L).label, 'controller runs a different plan — Apply to overwrite');
  eq('chip: edited and the controller has no plan', R.planStatus('', applied, 'ffffffff').cls, 'warn');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
