// rules.test.js — run with:  node app/web/rules.test.js
// Covers: every grammar rule, round-trips text → JSON → text, the RULES.md examples,
// the error cases with their hints, validate(), hash(), roundPlan(), triggersBetween(), simulate().
'use strict';
const R = require('./rules.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } }
function parsesTo(text, want) { const r = R.parse(text); eq(`parse: ${text}`, r.errors, []); eq(`json: ${text}`, JSON.parse(R.compile(r.rules)), Object.assign(R.empty(), want)); }
function errorIs(text, msgPart, hintPart) {
  const r = R.parse(text); ok(`error expected: ${text}`, !r.ok && r.errors.length === 1);
  if (r.errors[0]) { ok(`msg "${msgPart}" in "${r.errors[0].msg}"`, r.errors[0].msg.includes(msgPart)); if (hintPart) ok(`hint "${hintPart}" in "${r.errors[0].hint}"`, (r.errors[0].hint || '').includes(hintPart)); }
}
function roundTrip(text) { const a = R.parse(text); ok(`rt parse ${text}`, a.ok); const t2 = R.toText(a.rules); const b = R.parse(t2); ok(`rt reparse ${t2}`, b.ok); eq(`rt ${text}`, R.compile(b.rules), R.compile(a.rules)); ok(`rt stable ${text}`, R.toText(b.rules) === t2); }

// ---- schedule
parsesTo('every day at 07:00 and 19:00: water pots that are dry', { schedule: [{ days: 'all', at: ['07:00', '19:00'], pots: 'dry' }] });
parsesTo('Every Day At 7:00: Water Pots That Are Dry', { schedule: [{ days: 'all', at: ['07:00'], pots: 'dry' }] });
parsesTo('every mon, wed and fri at 06:30: water pots 1, 2 and 5', { schedule: [{ days: [1, 3, 5], at: ['06:30'], pots: [0, 1, 4] }] });
parsesTo('every monday and thursday at 6:30, 20:15: water pot 3 that are dry', { schedule: [{ days: [1, 4], at: ['06:30', '20:15'], pots: [2] }] });
parsesTo('every weekdays at 07:00: water pots that are dry', { schedule: [{ days: [1, 2, 3, 4, 5], at: ['07:00'], pots: 'dry' }] });
parsesTo('every weekends at 09:00: water pots 4 and 4', { schedule: [{ days: [0, 6], at: ['09:00'], pots: [3] }] });
parsesTo('every sun, mon, tue, wed, thu, fri and sat at 12:00: water pots that are dry', { schedule: [{ days: 'all', at: ['12:00'], pots: 'dry' }] });
parsesTo('every 12 h: water pots that are dry', { schedule: [{ everyMin: 720, pots: 'dry' }] });
parsesTo('every 6 hours: water pots 1 and 2', { schedule: [{ everyMin: 360, pots: [0, 1] }] });
parsesTo('every day at 19:00 and 07:00: water pots that are dry   # sorted', { schedule: [{ days: 'all', at: ['07:00', '19:00'], pots: 'dry' }] });
// ---- pots
parsesTo('pot 3: threshold 40 %, dose 250 mL, at most 2 doses/day', { pots: { 2: { thr: 40, dose: 250, max: 2 } } });
parsesTo('pots 1, 2 and 5: dose large', { pots: { 0: { dose: 900 }, 1: { dose: 900 }, 4: { dose: 900 } } });
parsesTo('pot 4: dose small', { pots: { 3: { dose: 250 } } });
parsesTo('pot 12: off', { pots: { 11: { on: false } } });
parsesTo('pot 12: on', { pots: { 11: { on: true } } });
parsesTo('pot 7: at most 1 dose per day', { pots: { 6: { max: 1 } } });
parsesTo('pot 7: threshold 50, dose 400', { pots: { 6: { thr: 50, dose: 400 } } });
parsesTo('pot 7: threshold 50 %\npot 7: dose 400 mL', { pots: { 6: { thr: 50, dose: 400 } } });
// ---- modifiers
parsesTo('if temperature > 30 °C: dose +30 %', { modifiers: [{ if: { k: 'temp', op: '>', v: 30 }, then: { dosePct: 30 } }] });
parsesTo('if temperature <= 5 C: dose -50 %', { modifiers: [{ if: { k: 'temp', op: '<=', v: 5 }, then: { dosePct: -50 } }] });
parsesTo('if rain forecast > 60 % in the next 12 h: skip the round', { modifiers: [{ if: { k: 'rain', op: '>', v: 60, h: 12 }, then: { skip: true } }] });
parsesTo('if rain forecast >= 80 %: skip the round', { modifiers: [{ if: { k: 'rain', op: '>=', v: 80, h: 12 }, then: { skip: true } }] });
parsesTo('if rain > 50 % in the next 24 h: dose -30 %', { modifiers: [{ if: { k: 'rain', op: '>', v: 50, h: 24 }, then: { dosePct: -30 } }] });
parsesTo('if tank < 20 %: dose -50 %', { modifiers: [{ if: { k: 'tank', op: '<', v: 20 }, then: { dosePct: -50 } }] });
parsesTo('if tank < 10 %: skip the round', { modifiers: [{ if: { k: 'tank', op: '<', v: 10 }, then: { skip: true } }] });
// ---- limits, comments, blanks
parsesTo('at most 4 L per day in total', { limits: { dailyML: 4000 } });
parsesTo('at most 4 L/day', { limits: { dailyML: 4000 } });
parsesTo('# only a comment\n\n   \n', {});
parsesTo('', {});

// ---- the RULES.md example set: compiles, ≤ 2 kB, round-trips, stable hash
const EXAMPLE = `# a complete, typical rule set
every day at 07:00 and 19:00: water pots that are dry
pot 3: threshold 40 %, dose 250 mL, at most 2 doses/day
pots 1, 2 and 5: dose large
pot 12: off
if temperature > 30 °C: dose +30 %
if rain forecast > 60 % in the next 12 h: skip the round
if tank < 20 %: dose -50 %
at most 10 L per day in total`;
{
  const r = R.parse(EXAMPLE); eq('example errors', r.errors, []);
  const j = R.compile(r.rules);
  ok('example ≤ 2 kB', j.length <= 2048);
  eq('example json', JSON.parse(j), { v: 1,
    schedule: [{ days: 'all', at: ['07:00', '19:00'], pots: 'dry' }],
    pots: { 0: { dose: 900 }, 1: { dose: 900 }, 2: { thr: 40, dose: 250, max: 2 }, 4: { dose: 900 }, 11: { on: false } },
    modifiers: [{ if: { k: 'temp', op: '>', v: 30 }, then: { dosePct: 30 } }, { if: { k: 'rain', op: '>', v: 60, h: 12 }, then: { skip: true } }, { if: { k: 'tank', op: '<', v: 20 }, then: { dosePct: -50 } }],
    limits: { dailyML: 10000 } });
  eq('example hash', R.hash(j), R.hash(R.compile(R.parse(R.toText(r.rules)).rules)));
  ok('hash is 8 hex', /^[0-9a-f]{8}$/.test(R.hash(j)));
  ok('hash differs', R.hash(j) !== R.hash(j + ' '));
  eq('fromJSON(compile) == rules', R.fromJSON(j), { ok: true, rules: JSON.parse(j) });
  eq('isEmpty', [R.isEmpty(R.empty()), R.isEmpty(r.rules)], [true, false]);
}
// worst case size: 4 schedules, 16 full pots, 6 modifiers
{
  const big = ['every mon, tue, wed, thu, fri and sat at 06:15, 12:30, 18:45 and 23:59: water pots 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 and 16',
    'every sun at 06:15, 12:30, 18:45 and 23:59: water pots 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 and 16', 'every 1 h: water pots that are dry', 'every 168 h: water pots that are dry'];
  for (let i = 1; i <= 16; i++) big.push(`pot ${i}: threshold 99 %, dose 2000 mL, at most 4 doses/day, off`);
  for (let i = 0; i < 6; i++) big.push('if rain forecast >= 100 % in the next 48 h: dose -80 %');
  big.push('at most 20 L per day in total');
  const r = R.parse(big.join('\n')); eq('big errors', r.errors, []);
  ok(`big ≤ 2 kB (${R.compile(r.rules).length})`, R.compile(r.rules).length <= 2048);
  roundTrip(big.join('\n'));
}
// ---- round trips
['every day at 07:00 and 19:00: water pots that are dry', 'every weekdays at 06:30: water pots 1, 2 and 5 that are dry', 'every weekends at 09:00: water pot 3 that are dry',
  'every tue and thu at 05:05: water pots that are dry', 'every 12 h: water pots that are dry', 'pot 3: threshold 40 %, dose 250 mL, at most 1 dose/day', 'pot 12: off', 'pot 2: on',
  'if temperature > 30 °C: dose +30 %', 'if rain forecast > 60 % in the next 6 h: skip the round', 'if rain forecast > 60 %: skip the round', 'if tank < 20 %: dose -50 %',
  'at most 4 L per day in total', EXAMPLE].forEach(roundTrip);
eq('toText of empty', R.toText(R.empty()), 'at most 10 L per day in total');
eq('toText canonical', R.toText(R.parse('pots 5 and 1: dose large\nevery 12 h: water pot 2').rules), 'every 12 h: water pot 2 that are dry\npot 1: dose 900 mL\npot 5: dose 900 mL\nat most 10 L per day in total');

// ---- errors (RULES.md §4 F and more)
errorIs('every day at 25:00: water pots that are dry', 'time 25:00 is not on the clock', '0:00–23:59');
errorIs('every day at 07:60: water pots that are dry', 'is not on the clock');
errorIs('pot 3: threshold 140 %', 'threshold 140 out of range', '1–99');
errorIs('pot 17: off', 'pot number 17 out of range', '1–16');
errorIs('pot 0: off', 'pot number 0 out of range', '1–16');
errorIs('if humidity > 50 %: skip the round', 'unknown condition "humidity"', 'temperature · rain forecast · tank');
errorIs('every day: water pots that are dry', 'expected "at HH:MM" after "every day"', 'every day at 07:00');
errorIs('at most 30 L per day in total', 'daily total 30 out of range', '1–20');
errorIs('every day at 7: water pots that are dry', 'time 7 needs minutes', '7:00');
errorIs('every day at 07:00 water pots that are dry', 'expected ":"');
errorIs('every day at 07:00: water', 'expected "pots"');
errorIs('every day at 07:00: water pots that are wet', 'expected "dry"');
errorIs('every 0 h: water pots that are dry', 'interval 0 out of range', '1–168');
errorIs('every 200 h: water pots that are dry', 'interval 200 out of range');
errorIs('every day at 1:00, 2:00, 3:00, 4:00 and 5:00: water pots that are dry', 'more than 4 times');
errorIs('every fnord at 07:00: water pots that are dry', 'expected "day", a weekday or a number');
errorIs('pot 3: dose 5 mL', 'dose 5 out of range', '10–2000');
errorIs('pot 3: dose 2001', 'dose 2001 out of range');
errorIs('pot 3: at most 5 doses/day', 'doses per day 5 out of range', '1–4');
errorIs('pot 3: at most 2 doses', 'expected "/day"');
errorIs('pot 3: colour red', 'unknown pot setting "colour"', 'threshold N %');
errorIs('pot 3 threshold 40 %', 'expected ":"');
errorIs('if temperature > 30 °C: dose 30 %', 'expected + or -');
errorIs('if temperature > 30 °C: dose +150 %', 'dose change 150 out of range');
errorIs('if temperature > 30 °C: dose -90 %', 'dose change -90 % out of range', '−80');
errorIs('if temperature > 70 °C: dose +10 %', 'temperature 70 out of range', '20–60');
errorIs('if temperature = 30: skip the round', 'expected > < >= or <=');
errorIs('if rain forecast > 60 % in the next 72 h: skip the round', 'forecast window 72 out of range', '1–48');
errorIs('if tank < 20 %: stop', 'unknown effect "stop"', 'skip the round');
errorIs('water pots that are dry', 'a rule starts with every · pot · pots · if · at most');
errorIs('every day at 07:00: water pots that are dry now', 'unexpected "now" at the end');
errorIs('pot 3: threshold 40 % {', 'unexpected "{"');
errorIs('at most 10 L per week', 'expected "day"');
{ // several errors, one per line, the good lines still parse
  const r = R.parse('every day at 07:00: water pots that are dry\npot 99: off\nif x > 1: skip the round\nat most 5 L per day');
  eq('multi-line error lines', r.errors.map(e => e.line), [2, 3]);
  eq('multi-line good parts', JSON.parse(R.compile(r.rules)).limits.dailyML, 5000);
  eq('multi-line schedule kept', JSON.parse(R.compile(r.rules)).schedule.length, 1);
}
{ let s = ''; for (let i = 0; i < 5; i++) s += `every day at 0${i}:00: water pots that are dry\n`; errorIs(s.trim(), 'more than 4 schedule lines'); }
{ let s = ''; for (let i = 0; i < 7; i++) s += 'if tank < 20 %: dose -10 %\n'; errorIs(s.trim(), 'more than 6 modifiers'); }

// ---- validate (what the board would refuse)
const good = JSON.parse(R.compile(R.parse(EXAMPLE).rules));
eq('validate good', R.validate(good), null);
const bad = (patch) => { const o = JSON.parse(JSON.stringify(good)); patch(o); return R.validate(o); };
ok('v', bad(o => o.v = 2) === 'v: must be 1');
ok('sched days', /schedule\[0\]\.days/.test(bad(o => o.schedule[0].days = [7])));
ok('sched at', /schedule\[0\]\.at/.test(bad(o => o.schedule[0].at = ['24:00'])));
ok('sched pots', /schedule\[0\]\.pots/.test(bad(o => o.schedule[0].pots = [16])));
ok('everyMin', /everyMin/.test(bad(o => o.schedule[0] = { everyMin: 90, pots: 'dry' })));
ok('too many sched', /schedule: more/.test(bad(o => o.schedule = [1, 2, 3, 4, 5].map(() => ({ everyMin: 60, pots: 'dry' })))));
ok('pot thr', bad(o => o.pots[2].thr = 0) === 'pots.2.thr: 1–99');
ok('pot max', bad(o => o.pots[2].max = 5) === 'pots.2.max: 1–4');
ok('pot key', /unknown key/.test(bad(o => o.pots[2].name = 'x')));
ok('pot ch', /pots\.16/.test(bad(o => o.pots[16] = { thr: 5 })));
ok('mod k', /modifiers\[0\]\.if\.k/.test(bad(o => o.modifiers[0].if.k = 'wind')));
ok('mod op', /modifiers\[0\]\.if\.op/.test(bad(o => o.modifiers[0].if.op = '=')));
ok('mod v', /modifiers\[2\]\.if\.v/.test(bad(o => o.modifiers[2].if.v = 101)));
ok('mod then', /exactly one/.test(bad(o => o.modifiers[0].then = { skip: true, dosePct: 1 })));
ok('mod dosePct', /dosePct/.test(bad(o => o.modifiers[0].then.dosePct = 101)));
ok('limits', bad(o => o.limits.dailyML = 25000) === 'limits.dailyML: 1000–20000');
ok('fromJSON bad json', !R.fromJSON('{').ok);
ok('fromJSON not object', !R.fromJSON('[]').ok);
eq('fromJSON fills defaults', R.fromJSON({ v: 1, schedule: [], pots: {}, modifiers: [], limits: {} }).rules.limits.dailyML, 10000);
eq('fromJSON rain h default', R.fromJSON({ v: 1, schedule: [], pots: {}, modifiers: [{ if: { k: 'rain', op: '>', v: 50 }, then: { skip: true } }], limits: {} }).rules.modifiers[0].if.h, 12);

// ---- roundPlan (modifier combination, unknown inputs)
const rp = R.parse('if temperature > 30 °C: dose +30 %\nif rain forecast > 60 % in the next 12 h: skip the round\nif tank < 20 %: dose -50 %\nif temperature > 35 °C: skip the round').rules;
eq('plan nothing fires', R.roundPlan(rp, { tempC: 20, rainPct: 10, rainH: 12, tankPct: 60 }).dosePct, 0);
eq('plan hot', R.roundPlan(rp, { tempC: 32, rainPct: 10, rainH: 12, tankPct: 60 }).dosePct, 30);
eq('plan hot + low tank adds up', R.roundPlan(rp, { tempC: 32, rainPct: 10, rainH: 12, tankPct: 18 }).dosePct, -20);
eq('plan rain skips', !!R.roundPlan(rp, { tempC: 20, rainPct: 80, rainH: 12, tankPct: 60 }).skip, true);
eq('plan rain skip names the rule', R.roundPlan(rp, { tempC: 20, rainPct: 80, rainH: 12, tankPct: 60 }).skip.if.k, 'rain');
eq('plan first skip wins', R.roundPlan(rp, { tempC: 40, rainPct: 80, rainH: 12, tankPct: 60 }).skip.if.k, 'rain');
eq('plan temp skip', R.roundPlan(rp, { tempC: 40, rainPct: 0, rainH: 12, tankPct: 60 }).skip.if.k, 'temp');
eq('plan unknown temp = false', R.roundPlan(rp, { tempC: null, rainPct: 80, rainH: 12, tankPct: 60 }).unknown, ['temp', 'temp']);
eq('plan no weather = false', R.roundPlan(rp, { tempC: 20, rainPct: null, rainH: 0, tankPct: 60 }).unknown, ['rain']);
eq('plan short forecast window = unknown', R.roundPlan(rp, { tempC: 20, rainPct: 90, rainH: 6, tankPct: 60 }).unknown, ['rain']);
eq('plan clamp', R.roundPlan(R.parse('if tank < 90 %: dose -50 %\nif tank < 80 %: dose -50 %').rules, { tankPct: 10 }).dosePct, -80);
eq('plan no rules', R.roundPlan(null, { tankPct: 10 }), { skip: null, dosePct: 0, fired: [], unknown: [] });
eq('scaleDose', [R.scaleDose(250, 30), R.scaleDose(900, 30), R.scaleDose(250, -20), R.scaleDose(10, -80), R.scaleDose(255, 0)], [330, 1170, 200, 10, 260]);
eq('targets dry', R.targets({ pots: 'dry' }, 4), [0, 1, 2, 3]);
eq('targets list clipped to fitted', R.targets({ pots: [0, 5, 9] }, 6), [0, 5]);
eq('targets manual', R.targets(null, 2), [0, 1]);

// ---- triggersBetween
{
  const base = new Date(2026, 8, 3, 12, 0, 0).getTime();          // Thu 2026-09-03 12:00 local
  const sched = R.parse('every day at 07:00 and 19:00: water pots that are dry').rules;
  const tr = R.triggersBetween(sched, base, base + 24 * 3600e3, null);
  eq('daily triggers', tr.map(x => new Date(x.t).getHours()), [19, 7]);
  const wk = R.parse('every mon and fri at 06:30: water pots that are dry').rules;
  eq('weekday triggers Thu→Fri', R.triggersBetween(wk, base, base + 24 * 3600e3, null).map(x => [new Date(x.t).getDay(), x.t]), [[5, new Date(2026, 8, 4, 6, 30).getTime()]]);
  eq('weekday no hit', R.triggersBetween(R.parse('every sat at 06:30: water pots that are dry').rules, base, base + 24 * 3600e3, null).length, 0);
  const iv = R.parse('every 6 h: water pots that are dry').rules;
  eq('interval from last round', R.triggersBetween(iv, base, base + 24 * 3600e3, base - 3600e3).map(x => (x.t - base) / 3600e3), [5, 11, 17, 23]);
  eq('interval, no last round', R.triggersBetween(iv, base, base + 24 * 3600e3, null).map(x => (x.t - base) / 3600e3), [6, 12, 18, 24]);
  eq('exclusive from, inclusive to', R.triggersBetween(sched, new Date(2026, 8, 3, 7, 0).getTime(), new Date(2026, 8, 3, 19, 0).getTime(), null).map(x => new Date(x.t).getHours()), [19]);
  eq('no schedule', R.triggersBetween(R.empty(), base, base + 86400e3, null), []);
  eq('two lines merge sorted', R.triggersBetween(R.parse('every day at 20:00: water pots that are dry\nevery day at 13:00: water pot 1').rules, base, base + 12 * 3600e3, null).map(x => x.idx), [1, 0]);
}

// ---- simulate (the Preview)
function world(over) {
  const pots = [];
  for (let i = 0; i < 16; i++) pots.push({ i, name: `Pot ${i + 1}`, pct: 60, sState: 1, thrPct: 35, doseML: i % 3 === 0 ? 900 : 250, max: 2, todayML: 0, senEn: true, valEn: true, ratePctPerH: 0 });
  pots[2].pct = 22; pots[6].pct = 30; pots[9].pct = 33; pots[11].sState = 2; pots[12].sState = 3; pots[13].senEn = false; pots[14].valEn = false;
  return Object.assign({ pots, nFitted: 16, tempC: 19.6, rainPct: null, rainH: 0, tankLeft: 15250, tankFull: 25000, reserve: 500, minTempC: 3, mlPerSec: 30, maxPumpMs: 90000, autoMin: 0, lastRoundMs: null, havePCA: true }, over || {});
}
const T0 = new Date(2026, 8, 3, 12, 0).getTime();
{
  const s = R.simulate(R.parse('every day at 07:00 and 19:00: water pots that are dry').rules, world(), T0, 24);
  eq('sim rounds', s.rounds.length, 2);
  eq('sim first round waters the dry pots', s.rounds[0].watered.map(w => [w.i, w.ml]), [[2, 250], [6, 900], [9, 900]]);
  eq('sim refused', s.rounds[0].refused.map(w => [w.i, w.reason]), [[11, 'implausible'], [12, 'uncal']]);
  eq('sim skipped count', s.rounds[0].skipped.length, 11);
  eq('sim off reasons', s.rounds[0].skipped.filter(x => x.reason === 'off').map(x => x.i), [13, 14]);
  eq('sim tank after', s.rounds[0].tankLeft, 15250 - 2050);
  eq('sim second round: watered pots are wet now', s.rounds[1].watered, []);
  eq('sim next', s.nextT, new Date(2026, 8, 3, 19, 0).getTime());
  eq('sim notes', s.notes, []);
}
{ // drying makes more pots dry by the second round; the daily budget bites on the third
  const w = world(); w.pots.forEach(p => p.ratePctPerH = 3);
  const s = R.simulate(R.parse('every 6 h: water pots that are dry').rules, w, T0, 24);
  eq('sim drying rounds', s.rounds.length, 4);
  ok('sim drying more pots later', s.rounds[1].watered.length > s.rounds[0].watered.length);
}
{ // rain skip, temperature scale, tank modifier, global cap
  const rr = R.parse('every day at 19:00: water pots that are dry\nif rain forecast > 60 % in the next 12 h: skip the round\nif temperature > 30 °C: dose +30 %').rules;
  const s1 = R.simulate(rr, world({ rainPct: 80, rainH: 12 }), T0, 24);
  eq('sim rain skipped', [s1.rounds.length, s1.rounds[0].skip.if.k, s1.rounds[0].watered.length], [1, 'rain', 0]);
  const s2 = R.simulate(rr, world({ rainPct: 20, rainH: 12, tempC: 32 }), T0, 24);
  eq('sim hot scaled', s2.rounds[0].watered.map(w => w.ml), [330, 1170, 1170]);
  eq('sim hot dosePct', s2.rounds[0].dosePct, 30);
  const s3 = R.simulate(rr, world(), T0, 24);
  eq('sim no weather note', s3.notes.length, 1);
  const s4 = R.simulate(R.parse('every day at 19:00: water pots that are dry\nat most 1 L per day in total').rules, world(), T0, 24);
  eq('sim global cap', [s4.rounds[0].watered.map(w => w.i), s4.rounds[0].refused.filter(r => r.reason === 'budget').map(r => r.i)], [[2], [6, 9]]);
  const s5 = R.simulate(R.parse('every day at 19:00: water pots 3 and 7').rules, world(), T0, 24);
  eq('sim only listed pots', s5.rounds[0].watered.map(w => w.i), [2, 6]);
  const s6 = R.simulate(R.parse('every day at 19:00: water pots that are dry').rules, world({ tempC: 1 }), T0, 24);
  eq('sim frost refuses', s6.rounds[0].refused.filter(r => r.reason === 'cold').length, 3);
  const s7 = R.simulate(R.parse('every day at 19:00: water pots that are dry').rules, world({ tankLeft: 1000 }), T0, 24);
  eq('sim tank reserve', s7.rounds[0].refused.filter(r => r.reason === 'tank').map(r => r.i), [6, 9]);
  const s8 = R.simulate(R.parse('every day at 19:00: water pots that are dry\nif temperature > 10 °C: dose +100 %').rules, world({ mlPerSec: 15 }), T0, 24);
  eq('sim 90 s cap trims', s8.rounds[0].watered.find(w => w.i === 6).ml, 1350);
  const w9 = world(); w9.pots[2].max = 1; w9.pots[2].todayML = 250;
  const s9 = R.simulate(R.parse('every day at 19:00: water pots that are dry').rules, w9, T0, 24);
  eq('sim per-pot budget', s9.rounds[0].refused.find(r => r.i === 2).reason, 'budget');
}
{ // no rules: today's auto behaviour; nothing at all
  const s = R.simulate(null, world({ autoMin: 720, lastRoundMs: T0 - 200 * 60e3 }), T0, 24);
  eq('sim auto trigger', [s.rounds.length, s.rounds[0].trigger, (s.rounds[0].t - T0) / 60e3], [2, 'auto', 520]);
  const n = R.simulate(null, world(), T0, 24);
  eq('sim nothing', [n.rounds.length, n.notes.length], [0, 1]);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
