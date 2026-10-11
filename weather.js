// weather.js — the forecast for the Home chart, from Open-Meteo (free, no key). The browser fetches it itself:
// ONE call for 92 past + 7 forecast days, so the chart can pan its whole window from one cached answer.
// Location = the household's weather location if the cloud has one, else Oldenburg. Plain script: window.Weather.
// (The board's frost stop gets its own forecast from the cloud: app/supabase/redraft-0.5.sql.)

const Weather = (() => {
  const DEFAULT_LOC = { lat: 53.14, lon: 8.21 };
  const TTL_MS = 30 * 60e3, RETRY_MS = 2 * 60e3, CACHE_KEY = 'wx5';
  let cache = null, inflight = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { cache = null; }

  function loc(l) { return l && Number.isFinite(l.lat) && Number.isFinite(l.lon) ? l : DEFAULT_LOC; }
  function key(l) { return `${(+l.lat).toFixed(2)},${(+l.lon).toFixed(2)}`; }
  // dayNight(points [{ts, c}]) → { <local midnight ms>: { tDay, tNight } }: the DAY (06–22) and the NIGHT after it (22–06) averaged.
  function dayNight(points) {
    const acc = {};
    (points || []).forEach(p => {
      if (!Number.isFinite(p.c)) return;
      const d = new Date(p.ts), hr = d.getHours(), night = hr >= 22 || hr < 6;
      if (hr < 6) d.setDate(d.getDate() - 1);
      d.setHours(0, 0, 0, 0);
      const a = acc[d.getTime()] || (acc[d.getTime()] = { ds: 0, dn: 0, ns: 0, nn: 0 });
      if (night) { a.ns += p.c; a.nn++; } else { a.ds += p.c; a.dn++; }
    });
    const out = {};
    Object.keys(acc).forEach(k => { const a = acc[k]; out[k] = { tDay: a.dn ? +(a.ds / a.dn).toFixed(1) : null, tNight: a.nn ? +(a.ns / a.nn).toFixed(1) : null }; });
    return out;
  }
  // Open-Meteo JSON → { days: [{ day (local midnight ms), code, mm, tDay, tNight }] }
  function summarise(j) {
    const h = j.hourly || {}, d = j.daily || {}, temp = h.temperature_2m || [];
    const dn = dayNight((h.time || []).map((t, k) => ({ ts: new Date(t).getTime(), c: temp[k] })));
    return { days: (d.time || []).map((t, k) => { const day = new Date(t + 'T00:00').getTime(), a = dn[day] || {};
      return { day, code: d.weather_code ? d.weather_code[k] : null, mm: d.precipitation_sum ? +(+d.precipitation_sum[k] || 0).toFixed(1) : 0,
        tDay: a.tDay === undefined ? null : a.tDay, tNight: a.tNight === undefined ? null : a.tNight }; }) };
  }
  async function fetchIt(l) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${(+l.lat).toFixed(3)}&longitude=${(+l.lon).toFixed(3)}&hourly=temperature_2m&daily=weather_code,precipitation_sum&past_days=92&forecast_days=7&timezone=auto`;
    const r = await fetch(url); if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    return summarise(await r.json());
  }
  // get(l) → the cached chart data or null; ensure(l, onDone) fetches when stale (30 min; 2 min after a failure).
  function get(l) { const k = key(loc(l)); return cache && cache.key === k ? cache.data : null; }
  function ensure(l, onDone) {
    l = loc(l); const k = key(l);
    if ((cache && cache.key === k && Date.now() - cache.at < (cache.err ? RETRY_MS : TTL_MS)) || inflight) return;
    inflight = fetchIt(l).then(data => { cache = { key: k, at: Date.now(), data, err: null }; try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ } })
      .catch(e => { cache = { key: k, at: Date.now(), data: cache && cache.key === k ? cache.data : null, err: e.message }; })
      .finally(() => { inflight = null; if (onDone) onDone(); });
  }
  return { get, ensure, summarise, dayNight };
})();
if (typeof module !== 'undefined') module.exports = Weather;   // backend.test.js
