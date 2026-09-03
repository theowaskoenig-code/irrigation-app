// weather.js — the forecast for the Weather tile on Glance, from Open-Meteo (free, no key, no account).
// The browser calls it directly — ONE call for 92 past days + 7 forecast days (Open-Meteo's maxima), so the Glance chart can
// draw weather across its whole pannable window from one cached answer; the controller gets its own hourly copy from the cloud (app/supabase/weather.sql).
// Location = household.weatherLoc {lat, lon, label} set in Settings; without one the default is Oldenburg, Germany.
// Plain script: window.Weather. In mock mode nothing is fetched — a fake forecast follows the demo's rain figure.

const Weather = (() => {
  const DEFAULT_LOC = { lat: 53.14, lon: 8.21, label: 'Oldenburg (default)' };
  const TTL_MS = 30 * 60e3, RETRY_MS = 2 * 60e3, CACHE_KEY = 'wx4';   // wx4: chart days carry tDay/tNight (older wx2/wx3 shapes are ignored)
  let cache = null, inflight = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (cache && !(cache.data && cache.data.chart && cache.data.chart.days)) cache = null; } catch (e) { cache = null; }

  function loc(household) { const w = household && household.weatherLoc; return w && Number.isFinite(w.lat) && Number.isFinite(w.lon) ? w : DEFAULT_LOC; }
  function key(l) { return `${(+l.lat).toFixed(2)},${(+l.lon).toFixed(2)}`; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localHour(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`; }
  // dayNight(points [{ts, c}]) → { <local midnight ms>: { tDay, nDay, tNight, nNight } } — the average of hourly readings in the
  // DAY (06:00–22:00) and the NIGHT that follows it (22:00–06:00; 00:00–05:59 counts for the previous day). n = readings used.
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
    Object.keys(acc).forEach(k => { const a = acc[k]; out[k] = { tDay: a.dn ? +(a.ds / a.dn).toFixed(1) : null, nDay: a.dn, tNight: a.nn ? +(a.ns / a.nn).toFixed(1) : null, nNight: a.nn }; });
    return out;
  }

  // Open-Meteo JSON → { today, tomorrow: {tMax, pct, mm} · h12, h24: {pct, mm} · chart: {days:[{day, code, tMax, tMin, mm, tDay, tNight}]} }  (mm = the day's precipitation_sum · tDay/tNight = hourly temperature_2m averaged 06–22 / 22–06)
  // The call covers past_days=92 + forecast_days=7, so "today" is found by date, not by index 0.
  function summarise(j, now) {
    const h = j.hourly || {}, d = j.daily || {}, times = h.time || [], prob = h.precipitation_probability || [], mm = h.precipitation || [];
    const dn = new Date(now), todayStr = `${dn.getFullYear()}-${pad(dn.getMonth() + 1)}-${pad(dn.getDate())}`;
    let i = times.indexOf(localHour(dn)); if (i < 0) i = 0;
    let k0 = (d.time || []).indexOf(todayStr); if (k0 < 0) k0 = 0;
    const win = (n) => { let p = 0, s = 0; for (let k = i; k < Math.min(times.length, i + n); k++) { p = Math.max(p, prob[k] || 0); s += mm[k] || 0; } return { pct: Math.round(p), mm: +s.toFixed(1) }; };
    const day = (k) => ({ tMax: d.temperature_2m_max ? Math.round(d.temperature_2m_max[k]) : null, pct: d.precipitation_probability_max ? Math.round(d.precipitation_probability_max[k]) : null, mm: d.precipitation_sum ? +(+d.precipitation_sum[k]).toFixed(1) : null });
    const temp = h.temperature_2m || [], dn2 = dayNight(times.map((t, k) => ({ ts: new Date(t).getTime(), c: temp[k] })));
    const chart = {
      days: (d.time || []).map((t, k) => { const day = new Date(t + 'T00:00').getTime(), a = dn2[day] || {}; return { day, code: d.weather_code ? d.weather_code[k] : null, tMax: d.temperature_2m_max ? d.temperature_2m_max[k] : null, tMin: d.temperature_2m_min ? d.temperature_2m_min[k] : null, mm: d.precipitation_sum ? +(+d.precipitation_sum[k] || 0).toFixed(1) : 0, tDay: a.tDay === undefined ? null : a.tDay, tNight: a.tNight === undefined ? null : a.tNight }; }),
    };
    return { at: now, today: day(k0), tomorrow: day(k0 + 1), h12: win(12), h24: win(24), chart };
  }
  async function fetchIt(l) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${(+l.lat).toFixed(3)}&longitude=${(+l.lon).toFixed(3)}&hourly=precipitation_probability,precipitation,temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum&past_days=92&forecast_days=7&timezone=auto`;
    const r = await fetch(url); if (!r.ok) throw new Error(`Open-Meteo answered ${r.status}`);
    return summarise(await r.json(), Date.now());
  }
  // The fake forecast for the demo: rain = the demo's forecast figure, temperature = the demo's day curve.
  function fake(telemetry) {
    const pct = telemetry.rainPct === undefined ? 35 : telemetry.rainPct, t = Math.round(21 + 6 * Math.sin((Date.now() / 3600e3) * Math.PI / 12));
    return { at: Date.now(), fake: true, today: { tMax: t + 3, pct, mm: +(pct / 25).toFixed(1) }, tomorrow: { tMax: t + 1, pct: Math.max(0, pct - 15), mm: +(pct / 40).toFixed(1) }, h12: { pct, mm: +(pct / 30).toFixed(1) }, h24: { pct: Math.min(100, pct + 10), mm: +(pct / 20).toFixed(1) } };
  }
  // get(household) → the cached forecast (or null); ensure() fetches when the cache is stale (30 min; 2 min after a failure) and calls onDone().
  function get(household) { const k = key(loc(household)); return cache && cache.key === k ? cache.data : null; }
  function ensure(household, onDone) {
    const l = loc(household), k = key(l);
    if (cache && cache.key === k && Date.now() - cache.at < (cache.err ? RETRY_MS : TTL_MS)) return;
    if (inflight) return;
    inflight = fetchIt(l).then(data => { cache = { key: k, at: Date.now(), data, err: null }; try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ } })
      .catch(e => { cache = { key: k, at: Date.now(), data: cache && cache.key === k ? cache.data : null, err: e.message }; })
      .finally(() => { inflight = null; if (onDone) onDone(); });
  }
  function error(household) { const k = key(loc(household)); return cache && cache.key === k ? cache.err : null; }
  return { DEFAULT_LOC, loc, get, ensure, error, fake, summarise, dayNight };
})();
if (typeof module !== 'undefined') module.exports = Weather;   // backend.test.js
