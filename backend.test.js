// backend.test.js — run with:  node app/web/backend.test.js
// Covers the helpers in backend.js (connState, historyFromLocal, dailyUseML, reasonText, dayStart) and Weather.dayNight
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
  eq('hist temp buckets', h.temp, [{ ts: D(2026, 3, 29, 1), c: 5 }, { ts: D(2026, 3, 30, 12), c: 12.3 }]);
  eq('hist refills in the window', h.refills, [D(2026, 3, 30, 7)]);
  const past = B.historyFromLocal(readings, events, 2, now, 2);          // window ending 2 days back: 27 + 28 Mar
  eq('hist endOffsetDays shifts the window', [past.from, past.perDay.map(d => d.ml)], [D(2026, 3, 27), [250, 250]]);
  const fut = B.historyFromLocal([], events, 2, now, -1);                 // 30 + 31 Mar: tomorrow stays empty
  eq('hist future day stays empty', fut.perDay.map(d => d.ml), [250, 0]);
}

// ---- dailyUseML: last 7 days of doses over the span they cover
{
  const now = D(2026, 9, 3, 12);
  eq('dailyUse none', B.dailyUseML([], now), null);
  eq('dailyUse ignores older than a week', B.dailyUseML([{ kind: 'dose', ts: now - 8 * 86400e3, ml: 900 }], now), null);
  const ev = [{ kind: 'dose', ts: now - 2 * 86400e3, ml: 900 }, { kind: 'dose', ts: now - 1 * 86400e3, ml: 300 }, { kind: 'refill', ts: now - 3600e3 }];
  eq('dailyUse = ml over the span in days', B.dailyUseML(ev, now), 600);
  eq('dailyUse span at least a day', B.dailyUseML([{ kind: 'dose', ts: now - 3600e3, ml: 250 }], now), 250);
}

// ---- reasonText: plain sentences, unknown keys pass through, nothing → "no reason given"
{
  eq('reason implausible', B.reasonText('implausible'), 'the sensor gives no believable reading — unplugged or broken');
  eq('reason unknown passes through', B.reasonText('flux_capacitor'), 'flux_capacitor');
  eq('reason empty', B.reasonText(undefined), 'no reason given');
}

// ---- Weather.dayNight: 06–22 = day, 22–06 = the night that FOLLOWS the day (00:00–05:59 counts for the previous day)
{
  const pts = [
    { ts: D(2026, 9, 2, 12), c: 20 }, { ts: D(2026, 9, 2, 18), c: 24 },      // day 2 Sep
    { ts: D(2026, 9, 2, 23), c: 14 }, { ts: D(2026, 9, 3, 3), c: 10 },        // the night after 2 Sep
    { ts: D(2026, 9, 3, 8), c: 16 }, { ts: D(2026, 9, 3, 5), c: NaN },        // day 3 Sep; NaN ignored
  ];
  const dn = Weather.dayNight(pts);
  eq('dayNight 2 Sep', dn[D(2026, 9, 2)], { tDay: 22, nDay: 2, tNight: 12, nNight: 2 });
  eq('dayNight 3 Sep (no night yet)', dn[D(2026, 9, 3)], { tDay: 16, nDay: 1, tNight: null, nNight: 0 });
  eq('dayNight over the DST night', Weather.dayNight([{ ts: D(2026, 3, 29, 1), c: 2 }, { ts: D(2026, 3, 29, 4), c: 4 }])[D(2026, 3, 28)], { tDay: null, nDay: 0, tNight: 3, nNight: 2 });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
