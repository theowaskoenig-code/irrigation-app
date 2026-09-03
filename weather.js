// weather.js — the forecast for the Weather tile on Glance, from Open-Meteo (free, no key, no account).
// The browser calls it directly — ONE call for 92 past days + 7 forecast days (Open-Meteo's maxima), so the Glance chart can
// draw weather across its whole pannable window from one cached answer; the controller gets its own hourly copy from the cloud (app/supabase/weather.sql).
// Location = household.weatherLoc {lat, lon, label} set in Settings; without one the default is Oldenburg, Germany.
// Plain script: window.Weather. In mock mode nothing is fetched — a fake forecast follows the demo's rain figure.

const Weather = (() => {
  const DEFAULT_LOC = { lat: 53.14, lon: 8.21, label: 'Oldenburg (default)' };
  const TTL_MS = 30 * 60e3, RETRY_MS = 2 * 60e3, CACHE_KEY = 'wx3';   // wx3: the shape with `chart` over 92+7 days (an older wx2 without it is ignored)
  let cache = null, inflight = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (cache && !(cache.data && cache.data.chart && cache.data.chart.days)) cache = null; } catch (e) { cache = null; }

  function loc(household) { const w = household && household.weatherLoc; return w && Number.isFinite(w.lat) && Number.isFinite(w.lon) ? w : DEFAULT_LOC; }
  function key(l) { return `${(+l.lat).toFixed(2)},${(+l.lon).toFixed(2)}`; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localHour(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`; }

  // Open-Meteo JSON → { today, tomorrow: {tMax, pct, mm} · h12, h24: {pct, mm} · chart: {days:[{day, code, tMax, tMin, mm}]} }  (mm = the day's precipitation_sum)
  // The call covers past_days=92 + forecast_days=7, so "today" is found by date, not by index 0.
  function summarise(j, now) {
    const h = j.hourly || {}, d = j.daily || {}, times = h.time || [], prob = h.precipitation_probability || [], mm = h.precipitation || [];
    const dn = new Date(now), todayStr = `${dn.getFullYear()}-${pad(dn.getMonth() + 1)}-${pad(dn.getDate())}`;
    let i = times.indexOf(localHour(dn)); if (i < 0) i = 0;
    let k0 = (d.time || []).indexOf(todayStr); if (k0 < 0) k0 = 0;
    const win = (n) => { let p = 0, s = 0; for (let k = i; k < Math.min(times.length, i + n); k++) { p = Math.max(p, prob[k] || 0); s += mm[k] || 0; } return { pct: Math.round(p), mm: +s.toFixed(1) }; };
    const day = (k) => ({ tMax: d.temperature_2m_max ? Math.round(d.temperature_2m_max[k]) : null, pct: d.precipitation_probability_max ? Math.round(d.precipitation_probability_max[k]) : null, mm: d.precipitation_sum ? +(+d.precipitation_sum[k]).toFixed(1) : null });
    const chart = {
      days: (d.time || []).map((t, k) => ({ day: new Date(t + 'T00:00').getTime(), code: d.weather_code ? d.weather_code[k] : null, tMax: d.temperature_2m_max ? d.temperature_2m_max[k] : null, tMin: d.temperature_2m_min ? d.temperature_2m_min[k] : null, mm: d.precipitation_sum ? +(+d.precipitation_sum[k] || 0).toFixed(1) : 0 })),
    };
    return { at: now, today: day(k0), tomorrow: day(k0 + 1), h12: win(12), h24: win(24), chart };
  }
  async function fetchIt(l) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${(+l.lat).toFixed(3)}&longitude=${(+l.lon).toFixed(3)}&hourly=precipitation_probability,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum&past_days=92&forecast_days=7&timezone=auto`;
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
  return { DEFAULT_LOC, loc, get, ensure, error, fake, summarise };
})();
