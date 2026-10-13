// backend.test.js — run with:  node app/web/backend.test.js
// Covers the helpers in backend.js (mapPayload, frostBlocks, connState, historyFromLocal, runsFromEvents, reasonText, dayStart) and Weather.dayNight
// from weather.js. The DST cases pin the process to Europe/Berlin: on 2026-03-29 the clocks jump 02:00 → 03:00, so
// that day is 23 hours long and "midnight + n × 24 h" is an hour off from the next midnight (review B8).
'use strict';
process.env.TZ = 'Europe/Berlin';
const B = require('./backend.js');
const Weather = require('./weather.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
}
const D = (y, m, d, h, mi) => new Date(y, m - 1, d, h || 0, mi || 0).getTime();

// ---- connState: online → stale after 2 × interval → offline after 3 ×
{
  const dev = { lastSeen: D(2026, 9, 3, 12, 0), intervalS: 300 };
  eq('conn online', B.connState(dev, D(2026, 9, 3, 12, 4)), 'online');
  eq('conn stale', B.connState(dev, D(2026, 9, 3, 12, 11)), 'stale');
  eq('conn offline', B.connState(dev, D(2026, 9, 3, 12, 16)), 'offline');
  eq('conn never seen', B.connState({ lastSeen: null, intervalS: 300 }, D(2026, 9, 3)), 'offline');
}

// ---- dayStart: local midnights across the DST change
{
  eq('dayStart same day', B.dayStart(D(2026, 3, 28, 15, 30), 0), D(2026, 3, 28));
  eq('dayStart +1 over the 23 h day', B.dayStart(D(2026, 3, 29), 1), D(2026, 3, 30));
  eq('dayStart 29 Mar is 23 h', (B.dayStart(D(2026, 3, 29), 1) - B.dayStart(D(2026, 3, 29), 0)) / 3600e3, 23);
  eq('dayStart 25 Oct is 25 h', (B.dayStart(D(2026, 10, 25), 1) - B.dayStart(D(2026, 10, 25), 0)) / 3600e3, 25);
  eq('dayStart negative k', B.dayStart(D(2026, 4, 1, 9), -3), D(2026, 3, 29));
}

// ---- historyFromLocal: a 3-day window over the DST change, doses land on their local calendar day
{
  const now = D(2026, 3, 30, 14, 0);
  const events = [
    { id: 1, ts: D(2026, 3, 28, 7, 0), kind: 'dose', ch: 0, ml: 250 },
    { id: 2, ts: D(2026, 3, 29, 23, 30), kind: 'dose', ch: 1, ml: 900 },
    { id: 3, ts: D(2026, 3, 30, 0, 30), kind: 'dose', ch: 2, ml: 250 },    // 00:30 on the 30th: with "+ n × 24 h" this fell on the 29th
    { id: 4, ts: D(2026, 3, 30, 7, 0), kind: 'refill', tankLeft: 25000 },
    { id: 6, ts: D(2026, 3, 29, 9, 0), kind: 'level', tankLeft: 18000 },
    { id: 5, ts: D(2026, 3, 27, 7, 0), kind: 'dose', ch: 0, ml: 250 },     // before the window
  ];
  const readings = [
    { ts: D(2026, 3, 29, 1, 10), tankLeft: 20000, tempC: 4 }, { ts: D(2026, 3, 29, 1, 50), tankLeft: 21000, tempC: 6 },
    { ts: D(2026, 3, 30, 12, 0), tankLeft: 25000, tempC: 12.25 }, { ts: D(2026, 3, 26, 12, 0), tankLeft: 9, tempC: 1 },
  ];
  const h = B.historyFromLocal(readings, events, 3, now, 0);
  eq('hist from = local midnight 28 Mar', h.from, D(2026, 3, 28));
  eq('hist perDay days are local midnights', h.perDay.map(d => d.day), [D(2026, 3, 28), D(2026, 3, 29), D(2026, 3, 30)]);
  eq('hist perDay ml (DST-safe day boundaries)', h.perDay.map(d => [d.ml, d.n]), [[250, 1], [900, 1], [250, 1]]);
  eq('hist hourly tank bucket averages', h.tank, [{ ts: D(2026, 3, 29, 1), ml: 20500 }, { ts: D(2026, 3, 30, 12), ml: 25000 }]);
  eq('hist refills in the window', h.refills, [D(2026, 3, 30, 7)]);
  eq('hist level sets in the window', h.levels, [D(2026, 3, 29, 9)]);
  const past = B.historyFromLocal(readings, events, 2, now, 2);          // window ending 2 days back: 27 + 28 Mar
  eq('hist endOffsetDays shifts the window', [past.from, past.perDay.map(d => d.ml)], [D(2026, 3, 27), [250, 250]]);
  const fut = B.historyFromLocal([], events, 2, now, -1);                 // 30 + 31 Mar: tomorrow stays empty
  eq('hist future day stays empty', fut.perDay.map(d => d.ml), [250, 0]);
}

// ---- reasonText: short labels, unknown keys pass through
{
  eq('reason nosensor', B.reasonText('nosensor'), 'no sensor');
  eq('reason frost', B.reasonText('frost'), 'frost');
  eq('reason unknown passes through', B.reasonText('flux_capacitor'), 'flux_capacitor');
  eq('reason empty', B.reasonText(undefined), '—');
}

// ---- mapPayload: the contract's names → the app's { t, ch }; missing fields get safe defaults
{
  const p = { fw: '0.5.0', up: 42, mlPerSec: 30, maxDoseML: 2700, maxPumpMs: 90000, tankLeft: 15300, tankFullML: 25000, tankReserve: 500,
    pumpRunning: true, pumpEn: true, rulesHash: 'abcd1234', planNext: 1760000000, planNextId: 'a', running: { plan: 'a', ch: 2, ml: 450, target: 900 }, queue: [3, 'x', 5],
    frostMinC: 1.5, frostAgeS: 600,
    ch: [{ senEn: true, valEn: true, raw: 2268, pct: 48, sd: 9, sState: 0, air: 2744, water: 1633, soilDry: -1, soilWet: -1, vState: 1, vOpenUs: 2500, vClosedUs: 1300, todayML: 900, lastML: 900, lastTs: 1759990000, lastWhy: 'watered' }] };
  const m = B.mapPayload(p);
  eq('t limits', [m.t.maxDoseML, m.t.maxPumpMs, m.t.tankFullML, m.t.tankReserve], [2700, 90000, 25000, 500]);
  eq('planNext s → ms', m.t.planNext, 1760000000000);
  eq('running', m.t.running, { plan: 'a', ch: 2, ml: 450, target: 900 });
  eq('queue integers only', m.t.queue, [3, 5]);
  eq('16 channels', m.ch.length, 16);
  eq('ch0', [m.ch[0].pct, m.ch[0].sd, m.ch[0].sState, m.ch[0].air, m.ch[0].lastTs, m.ch[0].lastWhy], [48, 9, 0, 2744, 1759990000000, 'watered']);
  eq('missing channel = nothing fitted, no reading', [m.ch[15].senEn, m.ch[15].valEn, m.ch[15].pct, m.ch[15].sState, m.ch[15].vState], [false, false, -1, 1, 0]);
  const e = B.mapPayload(undefined);
  eq('empty payload', [e.t.maxDoseML, e.t.planNext, e.t.running, e.t.frostMinC, e.ch.length], [null, null, null, null, 16]);
  eq('ch[].i wins over position', B.mapPayload({ ch: [{ i: 3, pct: 77 }] }).ch[3].pct, 77);
}

// ---- frostBlocks: fresh (< 6 h) and below 3 °C
{
  eq('frost blocks', B.frostBlocks({ frostMinC: 1.5, frostAgeS: 600 }), true);
  eq('frost 3.0 does not block', B.frostBlocks({ frostMinC: 3, frostAgeS: 600 }), false);
  eq('frost stale does not block', B.frostBlocks({ frostMinC: -2, frostAgeS: 6 * 3600 }), false);
  eq('no frost reading', B.frostBlocks({ frostMinC: null, frostAgeS: null }), false);
}

// ---- Weather.dayNight: 06–22 = day, 22–06 = the night that FOLLOWS the day (00:00–05:59 counts for the previous day)
{
  const pts = [
    { ts: D(2026, 9, 2, 12), c: 20 }, { ts: D(2026, 9, 2, 18), c: 24 },      // day 2 Sep
    { ts: D(2026, 9, 2, 23), c: 14 }, { ts: D(2026, 9, 3, 3), c: 10 },        // the night after 2 Sep
    { ts: D(2026, 9, 3, 8), c: 16 }, { ts: D(2026, 9, 3, 5), c: NaN },        // day 3 Sep; NaN ignored
  ];
  const dn = Weather.dayNight(pts);
  eq('dayNight 2 Sep', dn[D(2026, 9, 2)], { tDay: 22, tNight: 12 });
  eq('dayNight 3 Sep (no night yet)', dn[D(2026, 9, 3)], { tDay: 16, tNight: null });
  eq('dayNight over the DST night', Weather.dayNight([{ ts: D(2026, 3, 29, 1), c: 2 }, { ts: D(2026, 3, 29, 4), c: 4 }])[D(2026, 3, 28)], { tDay: null, tNight: 3 });
}

// ---- runsFromEvents: plan doses + refused events before each round event; a manual dose and an older round stay out
{
  const T = D(2026, 10, 13, 7), m = 60e3;
  const ev = [
    { ts: T - 12 * 3600e3, kind: 'round', plan: 'a', trigger: 'plan', watered: 0, skipped: 16, refused: 0, tankLeft: 9000 },
    { ts: T - 30 * m, kind: 'dose', ch: 9, ml: 500 },                                  // manual: no plan → not part of the round
    { ts: T + 0.5 * m, kind: 'dose', ch: 0, ml: 529, pct: 40, plan: 'a' },
    { ts: T + 1 * m, kind: 'dose', ch: 3, ml: 2700, pct: 82, plan: 'a', trimmed: true },
    { ts: T + 1.1 * m, kind: 'refused', ch: 1, pct: -1, reason: 'tank' },
    { ts: T + 1.5 * m, kind: 'round', plan: 'a', trigger: 'plan', watered: 2, skipped: 13, refused: 1, tankLeft: 5771 },
  ];
  const r = B.runsFromEvents(ev, 0);
  eq('runs newest first', r.map(x => x.watered), [2, 0]);
  eq('run total mL', r[0].ml, 3229);
  eq('run pots by channel', r[0].pots, [{ ch: 0, ml: 529, pct: 40, why: 'ok' }, { ch: 1, ml: 0, pct: null, why: 'tank' }, { ch: 3, ml: 2700, pct: 82, why: 'cap_trim' }]);
  eq('older round has no pots', r[1].pots, []);
  eq('from cuts older rounds', B.runsFromEvents(ev, T).length, 1);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
