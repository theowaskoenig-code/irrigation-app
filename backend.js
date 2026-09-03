// backend.js — the ONE interface the UI talks to. Swap the implementation here.
//
// The app never imports mock.js or a Supabase client directly; it calls
// `createBackend()` and uses the object below. To connect the real cloud:
//   1. supabase.js implements `createSupabaseBackend(config)` with the same methods;
//   2. set CONFIG.backend = 'supabase' and fill url + anonKey (../SETUP.md step 7).
//
// Contract (all methods return Promises unless noted):
//
//   init()                     -> load initial state, start realtime/polling
//   getState()                 -> current State (sync)
//   subscribe(fn)              -> fn(state) on every change; returns unsubscribe()
//   sendCommand(cmd, args)     -> resolves with the Command record once it is
//                                 acked / failed / expired. Rejects only on a
//                                 transport error (not on a refused watering —
//                                 that is ok:false with result.reason).
//   ackAlert(idOrAll)          -> 'all' or an alert id
//   setHousehold(patch)        -> household-only settings (pot names, ntfy topic)
//   login(email, pw) / logout() / session() -> auth (mock: always logged in)
//   isMock                     -> boolean (UI shows mock-only controls)
//
// State shape (field names = sketch 06 variables; ch is 0-based, pot = ch + 1):
//   device:    { id, name, fw, ip, rssi, up, lastSeen, intervalS, havePCA }
//   telemetry: { ts, tempC, tempOK, tankLeft, totalML, pumpRunning, pumpEn,
//                tempEn, ledEn, autoMin, nextRoundAt (ms epoch | null when auto is off),
//                nSensors, nServos, mlPerSec }
//   config:    { openUs, closedUs, tankFull, tankReserve, minTempC, plausMargin,
//                maxPumpMs }
//   pots:      [16 × { i, raw, pct, sState, vState, todayML, air, water,
//                      thrPct, doseML, senEn, valEn }]
//   household: { potNames: {}, ntfyTopic }
//   lastRound: { ts, watered, skipped, refused, tankLeft, tempC, trigger } | null
//   alerts:    [{ id, ts, key, kind, severity, ch, message, active, ackedAt }]
//   commands:  [{ id, cmd, args, status, createdAt, ackedAt, result }]  (newest first)
//   events:    [{ id, ts, kind, ch, ... }]                                (newest first)
//   readings:  [{ ts, tankLeft, tempC }]   (tank sparkline; the Glance chart is drawn from round/refill/dose events)

// ↓↓↓ Theo: paste your two values here (Supabase → Project Settings → API), then change 'mock' to 'supabase'.
const CONFIG = {
  backend: 'supabase',          // 'mock' = the fake controller (double-click demo) · 'lan' = the real controller on the home WiFi (sketch 09) · 'supabase' = the cloud
  lanHost: 'irrigation.local', // LAN mode: the controller's name or IP (override with index.html?host=192.168.1.42)
  supabaseUrl: 'https://aghudpkgpyptlkkazxgs.supabase.co',          // e.g. 'https://abcdefghijklmnop.supabase.co'   ← "Project URL"
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnaHVkcGtncHlwdGxra2F6eGdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MzYzMDIsImV4cCI6MjEwNDAxMjMwMn0.xuugLFhQ-qc_GFqKGrC0SBkNrEcsIJg4MrrhxmcCFrs',      // the long "anon public" key from the same page (safe in the browser: RLS limits it)
  deviceId: 'balcony-1',    // must equal the device row in the `devices` table and `devid` on the ESP
};
// The address bar can override the choice: index.html?backend=mock shows the demo even on the
// hosted app, ?backend=supabase tries the cloud even while CONFIG still says mock, ?backend=lan talks to the controller on the home WiFi.

const S_STATE = { NONE: 0, OK: 1, IMPLAUSIBLE: 2, UNCAL: 3 };
const V_STATE = { UNKNOWN: 0, CLOSED: 1, OPEN: 2, LIMP: 3 };

async function createBackend() {
  let which = CONFIG.backend;
  try { const q = new URLSearchParams(location.search).get('backend'); if (q === 'mock' || q === 'supabase') which = q; } catch (e) { /* ignore */ }
  if (which === 'supabase') return createSupabaseBackend(CONFIG);   // supabase.js, loaded as a plain script before this file
  if (which === 'lan')      return createLanBackend(CONFIG);        // lan.js — polls http://irrigation.local/api/state
  return createMockBackend(CONFIG);
}

// Helpers shared by UI and backends ------------------------------------------

// Controller freshness from lastSeen and the telemetry interval.
function connState(device, now) {
  if (!device.lastSeen) return 'offline';
  const age = (now - device.lastSeen) / 1000;
  if (age > 3 * device.intervalS) return 'offline';
  if (age > 2 * device.intervalS) return 'stale';
  return 'online';
}

// Litres/day from the last 7 days of dose events; null when there is no history.
function dailyUseML(events, now) {
  const week = 7 * 86400e3;
  const doses = events.filter(e => e.kind === 'dose' && now - e.ts < week);
  if (!doses.length) return null;
  const spanDays = Math.max(1, (now - Math.min(...doses.map(e => e.ts))) / 86400e3);
  return doses.reduce((s, e) => s + (e.ml || 0), 0) / spanDays;
}
