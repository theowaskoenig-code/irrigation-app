// lan.js — LAN backend: the app talks straight to the controller on the home
// network, no cloud. Firmware side = sketches/09_irrigation (GET /api/state,
// POST /api/cmd). Same contract as mock.js / backend.js; nothing in the UI
// depends on this file directly.
//
// Enable: CONFIG.backend = 'lan' (+ CONFIG.lanHost, default 'irrigation.local')
// and load this file in index.html. Host fallback order: ?host=<ip> in the URL
// → localStorage 'lanHost' → CONFIG.lanHost. If the controller does not answer
// for a while and no host was typed yet, the app asks once for its IP (the
// board prints it on the serial console and on the `wifi` command).
//
// What the controller gives us and what it does not:
//   · polling GET /api/state every 2 s — live pots, tank, pump, temperature,
//     auto timer, and a ring of the last 48 events (dose / refused / round /
//     refill / estop / boot) kept in the board's RAM.
//   · HISTORY STARTS AT POWER-UP: the 14-day chart, days-left estimate and
//     refill list are built from that ring only, so they cover at most the time
//     since the last reboot (and at most 48 events). No cloud = no long history.
//     The app shows this as device.name "Balcony · LAN (history since power-up)".
//   · alerts are derived here, in the browser, from the state and the events:
//     tank_low (< 20 %), tank_reserve (a refused-for-tank event after the last
//     refill), frost (< 3 °C), pot_refused (last event of a pot is a refusal for
//     implausible / uncal / budget / nopca), estop (an estop event), offline
//     (three missed polls). Acks live in localStorage only.
//   · push notifications do not exist in LAN mode (household.ntfyTopic is
//     empty); pot names are kept in localStorage.
//
// Command mapping (app command → the console line POSTed to /api/cmd; the
// firmware runs it through the SAME handle() as the serial console, so pot
// numbers are 1-based there — ch + 1):
//   water {ch, ml?}            → w <n> [<ml>]        (ml: firmware 0.4.3 or newer; older boards ignore it and use the pot's dose)
//   run                        → run
//   auto {min}                 → auto <min>          (0 = off)
//   tank {full} / {ml}         → tank full / tank <mL>
//   thr {ch,pct}               → thr <n> <pct>
//   dose {ch,ml}               → dose <n> <mL>
//   cal {ch,which:'air'|'water'} → cal <n> air|water
//   cal {ch,clear:true}        → cal clear <n>
//   cal {ch,air,water}         → cal <n> <air> <water>
//   en {what,on}               → en <what> on|off     (s3 · v7 · pot3 · pump · temp · led · all · sensors · valves)
//   fit {nSensors,nServos}     → fit <sen> <srv>
//   flow {mlPerSec}            → flow <mL/s>
//   vlim {openUs,closedUs}     → vlim <open> <closed>
//   v {ch,st}                  → v <n> o|c|x          vtest {ch} → vtest <n>      vall {st} → vall c|x     reseat {} → vseat
//   p {sec}                    → p <sec>              pstop → pstop
//   stop                       → !                    (emergency stop — acts immediately, even mid-dose)
//   save / defaults            → save / defaults
//   refresh                    → r                    temp → t        sweep → s
//   hwcheck                    → i                    (output goes to the serial console, not back to the app)
//   reboot                     → reboot
//   rules {…} / {clear:true}   → rules <json> / rules clear   (app/RULES.md, rules v2)
//   plan_preview {id}          → rules dry <id>      (the board prints its list on the serial console; /api/cmd cannot
//                                 return it, so the app shows its own Rules.preview of the last /api/state — same logic)
//   plan_run {id}              → rules run <id>      (a real round with that plan; acked on its round event)
//   weather {rainPct,h,tMaxC}  → weather <pct> <h> <tMax>
//   interval                   → not available in LAN mode (the app polls every 2 s) → ok:false, reason 'not_in_lan_mode'
//
// Result of a command: the controller answers {ok:true, queued:n} at once and
// runs the line when its loop is free. For `water` we then wait for the dose /
// refused event of that pot (so the toast can say "250 mL, 8.3 s" or the
// refusal reason); for `run` we wait for the round event; everything else is
// acked as soon as a later poll shows the queue empty.

function createLanBackend(config) {
  const POLL_MS = 2000, FETCH_TIMEOUT_MS = 4000, INTERVAL_S = 5;   // connState: stale after 10 s, offline after 15 s
  const TANK_FULL_FALLBACK = 25000, TANK_RESERVE_FALLBACK = 500, MIN_TEMP_FALLBACK = 3.0;
  const HARD_REFUSALS = new Set(['implausible', 'uncal', 'budget', 'nopca']);
  const subs = new Set();
  let host = config.lanHost || 'irrigation.local';
  try { const q = new URLSearchParams(location.search).get('host'), s = localStorage.getItem('lanHost'); const ok = (h) => h && /^[\w.-]+(:\d+)?$/.test(h); host = ok(q) ? q : ok(s) ? s : host; if (ok(q)) localStorage.setItem('lanHost', q); } catch (e) { /* file:// private mode etc. */ }
  let askedForHost = false, misses = 0, pollTimer = null, lastReadingAt = 0, seq = 0, firstPollDone = false;
  const HOST_OK = /^[\w.-]+(:\d+)?$/;

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  const state = {
    device: { id: config.deviceId, name: 'Balcony · LAN (history since power-up)', fw: '?', ip: host, rssi: 0, up: 0, lastSeen: 0, intervalS: INTERVAL_S, havePCA: false },
    telemetry: { ts: 0, tempC: null, tempOK: false, tankLeft: 0, totalML: 0, pumpRunning: false, pumpEn: true, tempEn: true, ledEn: true, autoMin: 0, nextRoundAt: null, nSensors: 0, nServos: 0, mlPerSec: 30 },
    config: { openUs: 2500, closedUs: 1300, tankFull: TANK_FULL_FALLBACK, tankReserve: TANK_RESERVE_FALLBACK, minTempC: MIN_TEMP_FALLBACK, plausMargin: 250, maxPumpMs: 90000 },
    pots: [], household: { potNames: lsGet('potNames', {}), ntfyTopic: '', weatherLoc: lsGet('weatherLoc', null) },
    lastRound: null, alerts: [], commands: [], events: [], readings: [],
  };
  const acked = lsGet('lanAckedAlerts', {});        // alert key → ackedAt
  const firstSeen = {};                              // state-derived alert key → ts

  // ---------------------------------------------------------------- transport
  function base() { return `http://${host}`; }
  async function http(path, opts) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try { return await fetch(base() + path, { ...opts, signal: ctl.signal, cache: 'no-store' }); }
    finally { clearTimeout(t); }
  }
  async function postCmd(line) {
    const r = await http('/api/cmd', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: line });
    let j = null; try { j = await r.json(); } catch (e) { /* non-JSON */ }
    if (r.status === 409) return { ok: false, reason: 'busy' };
    if (!r.ok) throw new Error(`controller answered ${r.status}`);
    return j || { ok: true };
  }

  // ---------------------------------------------------------------- state ← /api/state
  function ingest(s, receivedAt) {
    const now = receivedAt, msToTs = (ms) => now - (s.time.ms - ms);        // board millis → wall clock
    state.device = { ...state.device, fw: s.fw, ip: s.wifi.ip || host, rssi: s.wifi.rssi, up: s.uptime_s, lastSeen: now, intervalS: INTERVAL_S, havePCA: !!s.have_pca };
    state.telemetry = {
      ts: now, tempC: s.temp_c, tempOK: s.temp_c !== null, tankLeft: s.tank.ml, totalML: s.tank.total_ml,
      pumpRunning: !!s.pump.on, pumpEn: !!s.pump.enabled, tempEn: !!s.temp_en, ledEn: !!s.led_en,
      autoMin: s.auto.minutes, nextRoundAt: s.planNext > 0 ? s.planNext * 1000 : s.auto.minutes > 0 ? msToTs(s.auto.next_ms) : null,   // planNext (epoch s, 0.4.0) wins over the auto timer
      nSensors: s.fit.sensors, nServos: s.fit.servos, mlPerSec: s.flow_ml_s, busy: !!s.busy, queued: s.queued | 0,
      rulesHash: typeof s.rulesHash === 'string' ? s.rulesHash : undefined,   // undefined = firmware before the watering plan
      planNext: s.planNext > 0 ? s.planNext : 0,
    };
    state.config = { openUs: s.servo.open_us, closedUs: s.servo.closed_us, tankFull: s.tank.full_ml, tankReserve: s.tank.reserve_ml,
      minTempC: s.limits.min_temp_c, plausMargin: s.limits.plaus_margin, maxPumpMs: s.limits.max_pump_ms };
    state.pots = s.pots.map(p => ({ i: p.n - 1, raw: p.raw, pct: p.pct, sState: p.s_state, vState: p.v_state, todayML: p.today_ml,
      air: p.air, water: p.water, thrPct: p.thr_pct, doseML: p.dose_ml, senEn: !!p.sen_en, valEn: !!p.val_en }));
    // events: the board sends newest first; the contract wants newest first too
    state.events = s.events.map(e => {
      const ev = { id: `${e.ms}:${e.type}:${e.pot}`, ts: msToTs(e.ms), kind: e.type, ml: e.ml, tankLeft: e.tank, note: e.note };
      if (e.pot > 0) ev.ch = e.pot - 1;
      if (e.type === 'refused') ev.reason = e.note;
      if (e.type === 'dose') ev.sec = s.flow_ml_s > 0 ? +(e.ml / s.flow_ml_s).toFixed(1) : null;
      if (e.type === 'round') {                                       // note = "w3 s10 r2 auto"
        const m = /w(\d+) s(\d+) r(\d+)\s*(\w*)/.exec(e.note || '');
        if (m) { ev.watered = +m[1]; ev.skipped = +m[2]; ev.refused = +m[3]; ev.trigger = m[4] || 'cmd'; }
        ev.tempC = null;
      }
      if (e.type === 'boot') ev.fw = e.note;
      return ev;
    });
    const lr = state.events.find(e => e.kind === 'round');
    state.lastRound = lr ? { ts: lr.ts, watered: lr.watered, skipped: lr.skipped, refused: lr.refused, tankLeft: lr.tankLeft, tempC: null, trigger: lr.trigger } : null;
    // readings for the tank sparkline: seed from the level events once, then one point a minute
    if (!firstPollDone) {
      firstPollDone = true;
      state.readings = state.events.filter(e => e.kind === 'round' || e.kind === 'refill' || e.kind === 'boot').map(e => ({ ts: e.ts, tankLeft: e.tankLeft, tempC: null })).sort((a, b) => a.ts - b.ts);
    }
    if (now - lastReadingAt >= 60e3) { lastReadingAt = now; state.readings.push({ ts: now, tankLeft: s.tank.ml, tempC: s.temp_c }); if (state.readings.length > 2000) state.readings.shift(); }
    evalAlerts(now);
    seq++;
  }

  // ---------------------------------------------------------------- alerts (derived here, not on the board)
  function setAlert(key, kind, severity, ch, message, ts) {
    let a = state.alerts.find(x => x.key === key);
    if (!a) { a = { id: key, ts, key, kind, severity, ch, message, active: true, ackedAt: acked[key] || null }; state.alerts.unshift(a); }
    else { a.active = true; a.message = message; }
  }
  function clearAlert(key) { state.alerts.forEach(a => { if (a.key === key && a.active) a.active = false; }); }
  function evalAlerts(now) {
    const t = state.telemetry, c = state.config, evs = state.events;
    const seen = (key) => { if (!firstSeen[key]) firstSeen[key] = now; return firstSeen[key]; };
    // tank
    if (t.tankLeft < c.tankFull / 5) setAlert('tank_low', 'tank_low', 'warn', null, `Tank at ${Math.round(100 * t.tankLeft / c.tankFull)} % — refill soon`, seen('tank_low'));
    else { clearAlert('tank_low'); delete firstSeen.tank_low; }
    const lastRefill = evs.find(e => e.kind === 'refill'), tankRefusal = evs.find(e => e.kind === 'refused' && e.reason === 'tank');
    if (tankRefusal && (!lastRefill || tankRefusal.ts > lastRefill.ts)) setAlert(`tank_reserve:${tankRefusal.id}`, 'tank_reserve', 'critical', null, 'Tank counter at the reserve — nothing waters until you refill', tankRefusal.ts);
    else state.alerts.forEach(a => { if (a.kind === 'tank_reserve') a.active = false; });
    // frost
    if (t.tempOK && t.tempC < c.minTempC) setAlert('frost', 'frost', 'info', null, `${t.tempC.toFixed(1)} °C — watering suspended below ${c.minTempC} °C`, seen('frost'));
    else if (!t.tempOK || t.tempC > c.minTempC + 2) { clearAlert('frost'); delete firstSeen.frost; }
    // per pot: the newest dose/refused event decides
    state.pots.forEach(p => {
      const last = evs.find(e => e.ch === p.i && (e.kind === 'dose' || e.kind === 'refused'));
      const key = `pot_refused:${p.i}`;
      if (last && last.kind === 'refused' && HARD_REFUSALS.has(last.reason)) setAlert(`${key}:${last.id}`, 'pot_refused', 'warn', p.i, `Pot ${p.i + 1} refused: ${reasonText(last.reason)}`, last.ts);
      state.alerts.forEach(a => { if (a.kind === 'pot_refused' && a.ch === p.i && a.active && (!last || last.kind !== 'refused' || a.key !== `${key}:${last.id}`)) a.active = false; });
    });
    // emergency stop: one alert per estop event
    evs.filter(e => e.kind === 'estop').forEach(e => setAlert(`estop:${e.id}`, 'estop', 'info', null, `Emergency stop received (${e.note}) — pump off, all PWM cut`, e.ts));
    // offline is handled in poll()
    state.alerts.sort((a, b) => b.ts - a.ts); if (state.alerts.length > 60) state.alerts.length = 60;
  }

  // ---------------------------------------------------------------- polling
  function emit() { const s = getState(); subs.forEach(fn => fn(s)); }
  function getState() { return JSON.parse(JSON.stringify(state)); }
  async function poll() {
    try {
      const r = await http('/api/state', { method: 'GET' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = await r.json();
      ingest(s, Date.now());
      misses = 0;
      state.alerts.forEach(a => { if (a.kind === 'offline' && a.active) a.active = false; });
    } catch (e) {
      misses++;
      if (misses === 3) setAlert(`offline:${Date.now()}`, 'offline', 'critical', null, `Controller not answering at ${host} — is it powered, on WiFi, and is this the right address?`, Date.now());
      if (misses === 5 && !askedForHost) {
        askedForHost = true;
        const ip = typeof prompt === 'function' ? prompt(`No answer from http://${host}/ — type the controller's IP address (it prints it on the serial console, or type  wifi  there). Leave empty to keep trying.`, '') : '';
        if (ip && HOST_OK.test(ip.trim())) { host = ip.trim(); lsSet('lanHost', host); state.device.ip = host; misses = 0; }   // a host name or IP, optional :port — nothing else (review R4)
      }
    }
    emit();
  }

  // ---------------------------------------------------------------- commands
  const n1 = (a) => (a.ch | 0) + 1;
  function toLine(cmd, a) {
    a = a || {};
    switch (cmd) {
      case 'water': return a.ml > 0 ? `w ${n1(a)} ${a.ml | 0}` : `w ${n1(a)}`;
      case 'run': return 'run';
      case 'auto': return `auto ${Math.max(0, a.min | 0)}`;
      case 'tank': return a.full ? 'tank full' : `tank ${Math.max(0, a.ml | 0)}`;
      case 'thr': return `thr ${n1(a)} ${a.pct | 0}`;
      case 'dose': return `dose ${n1(a)} ${a.ml | 0}`;
      case 'cal': return a.clear ? `cal clear ${n1(a)}` : a.which ? `cal ${n1(a)} ${a.which}` : `cal ${n1(a)} ${a.air | 0} ${a.water | 0}`;
      case 'en': return `en ${a.what} ${a.on ? 'on' : 'off'}`;
      case 'fit': return `fit ${a.nSensors | 0} ${a.nServos | 0}`;
      case 'flow': return `flow ${+a.mlPerSec || 30}`;
      case 'vlim': return `vlim ${a.openUs | 0} ${a.closedUs | 0}`;
      case 'v': return `v ${n1(a)} ${a.st}`;
      case 'vtest': return `vtest ${n1(a)}`;
      case 'vall': return `vall ${a.st || 'x'}`;
      case 'reseat': return 'vseat';
      case 'p': return `p ${a.sec | 0}`;
      case 'pstop': return 'pstop';
      case 'stop': return '!';
      case 'save': return 'save';
      case 'defaults': return 'defaults';
      case 'refresh': return 'r';
      case 'temp': return 't';
      case 'sweep': return 's';
      case 'hwcheck': return 'i';
      case 'reboot': return 'reboot';
      case 'rules': return a.clear ? 'rules clear' : `rules ${JSON.stringify(a)}`;          // app/RULES.md §2
      case 'plan_preview': return `rules dry ${a.id}`;
      case 'plan_run': return `rules run ${a.id}`;
      case 'weather': return `weather ${a.rainPct | 0} ${a.h | 0} ${a.tMaxC | 0}`;
      default: return null;                    // interval, unknown
    }
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Wait until a poll after `since` satisfies `test(state)`; resolves with its value or null on timeout.
  async function waitFor(test, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(500);
      if (state.device.lastSeen > t0) { const v = test(); if (v) return v; }
    }
    return null;
  }
  function sendCommand(cmd, args) {
    const rec = { id: Math.random().toString(36).slice(2, 10), cmd, args: args || {}, status: 'queued', createdAt: Date.now(), ackedAt: null, result: null, expiresAt: null };
    state.commands.unshift(rec); if (state.commands.length > 40) state.commands.length = 40;
    emit();
    const finish = (status, result) => { rec.status = status; rec.result = result; rec.ackedAt = Date.now(); emit(); return { ...rec }; };
    const line = toLine(cmd, rec.args);
    if (!line) return Promise.resolve(finish('failed', { ok: false, reason: 'not_in_lan_mode' }));
    return (async () => {
      let ans;
      try { ans = await postCmd(line); }
      catch (e) { finish('failed', { ok: false, reason: 'transport' }); throw new Error(`${host} unreachable: ${e.message}`); }
      if (!ans.ok) return finish('failed', ans);
      rec.status = 'sent'; emit();
      const sentAt = Date.now();
      if (cmd === 'water') {
        const ch = rec.args.ch | 0;
        const ev = await waitFor(() => state.events.find(e => e.ch === ch && (e.kind === 'dose' || e.kind === 'refused') && e.ts >= sentAt - 1500), 150e3);
        if (!ev) return finish('acked', { ok: true, note: 'no dose event seen — check the serial console' });
        return ev.kind === 'dose' ? finish('acked', { ok: true, ml: ev.ml, sec: ev.sec }) : finish('failed', { ok: false, reason: ev.reason });
      }
      if (cmd === 'run' || cmd === 'plan_run') {
        const ev = await waitFor(() => state.events.find(e => e.kind === 'round' && e.ts >= sentAt - 1500), 20 * 60e3);
        return finish('acked', ev ? { ok: true, watered: ev.watered, skipped: ev.skipped, refused: ev.refused, tankLeft: ev.tankLeft } : { ok: true });
      }
      if (cmd === 'plan_preview') return finish('acked', { ok: true, console: true });   // the list prints on the serial console; the app shows its own (rules-ui.js, same logic)
      if (cmd === 'hwcheck') return finish('acked', { ok: true, text: 'Hardware check ran on the controller — its report is on the serial console (LAN mode cannot read it back). Live values: see the Pots and Settings screens.' });
      // everything else: acked once the queue has drained (or after a moment, for the stop that ran immediately)
      await waitFor(() => !state.telemetry.queued && !state.telemetry.busy, 60e3);
      if (cmd === 'rules') return finish('acked', { ok: true, rulesHash: state.telemetry.rulesHash });   // the board's own hash, as the other backends return it
      return finish('acked', { ok: true });
    })();
  }

  return {
    isMock: false,
    async init() { await poll(); pollTimer = setInterval(poll, POLL_MS); },
    getState,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    sendCommand,
    async ackAlert(id) { const now = Date.now(); state.alerts.forEach(a => { if (id === 'all' || a.id === id) { a.ackedAt = a.ackedAt || now; acked[a.key] = a.ackedAt; } }); lsSet('lanAckedAlerts', acked); emit(); },
    async setHousehold(patch) { Object.assign(state.household, patch); lsSet('potNames', state.household.potNames); lsSet('weatherLoc', state.household.weatherLoc); emit(); },
    // history since power-up only (the board keeps 48 events and this tab keeps one reading a minute); moisture history needs the cloud
    async history(days, endOffsetDays) { const h = historyFromLocal(state.readings, state.events, days, Date.now(), endOffsetDays || 0); h.partial = true; h.note = 'LAN mode: history since the controller was powered up, from this browser tab'; return h; },
    async potHistory(ch, days) { const from = Date.now() - days * 86400e3; return { days, moisture: [], doses: state.events.filter(e => e.kind === 'dose' && e.ch === ch && e.ts >= from).map(e => ({ ts: e.ts, ml: e.ml })).sort((a, b) => a.ts - b.ts), note: 'Moisture history needs the cloud (samples table); LAN mode has only the live value.' }; },
    async login() { return { email: 'local network' }; },
    async logout() {},
    session() { return { email: 'local network' }; },   // always signed in: whoever is on the WiFi can reach the board
    lan: { host: () => host, setHost(h) { h = String(h).trim(); if (HOST_OK.test(h)) { host = h; lsSet('lanHost', host); misses = 0; } }, stop() { clearInterval(pollTimer); } },
  };
}
