// mock.js — a fake controller + fake cloud in the browser.
// Simulates 16 pots drying out, the tank counter, temperature, alerts, and the
// command round-trip (queued → sent → acked) with sketch 06's interlocks in the
// same order as waterPot(). Everything here is replaced by the real backend;
// nothing in the UI depends on this file directly.

const N_CH = 16;
const TANK_FULL = 25000, TANK_RESERVE = 500, MIN_TEMP = 3.0, PLAUS_MARGIN = 250, MAX_PUMP_MS = 90000;

function uid() { return Math.random().toString(36).slice(2, 10); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function createMockBackend(config) {
  const now = Date.now();
  const subs = new Set();
  let offline = false;             // "controller unreachable" switch (Settings)
  let seq = 0;

  // ---- controller-side state (what sketch 06 holds in RAM/NVS) ----
  const pots = [];
  for (let i = 0; i < N_CH; i++) {
    const air = 1650 + Math.round(Math.random() * 120), water = 1050 + Math.round(Math.random() * 90);
    pots.push({ i, air, water, thrPct: 35, doseML: i % 3 === 0 ? 900 : 250, senEn: true, valEn: true,
      raw: 0, pct: -1, sState: 0, vState: 3, todayML: 0, max: 2,
      _true: 40 + Math.random() * 45, _rate: 0.010 + Math.random() * 0.02 });   // % per second drift
  }
  pots[2]._true = 22; pots[6]._true = 30; pots[9]._true = 33;          // already dry
  pots[11]._unplugged = true;                                           // implausible
  pots[12].air = -1; pots[12].water = -1;                              // uncalibrated
  pots[13].senEn = false;                                              // sensor off
  pots[14].valEn = false;                                              // valve off

  const ctl = {
    nSensors: 16, nServos: 16, openUs: 2500, closedUs: 1300, mlPerSec: 30.0,
    tankLeft: 15250, totalML: 9750, pumpRunning: false, pumpEn: true, tempEn: true, ledEn: true,
    autoMin: 720, tempC: 19.6, tempOK: true, havePCA: true, up: 3 * 86400 + 4212,
    autoLast: now - 200 * 60e3,                 // = the last seeded round; next one in 12 h − 200 min
    rules: null, rulesHash: '',                 // app/RULES.md — the rule set the `rules` command installed (null = 0.2.0 behaviour)
    rainPct: 35, rainH: 12, tMaxC: 24, wxAt: now,   // the last `weather` push (mock: a fair-weather default)
  };
  const dailyML = () => ctl.rules ? ctl.rules.limits.dailyML : 10000;
  const todayTotal = () => pots.reduce((s, p) => s + p.todayML, 0);
  function nextRoundMs() {
    if (ctl.rules && ctl.rules.schedule.length) { const t = Rules.triggersBetween(ctl.rules, Date.now(), Date.now() + 8 * 86400e3, ctl.autoLast); return t.length ? t[0].t : null; }
    return ctl.autoMin > 0 ? ctl.autoLast + ctl.autoMin * 60e3 : null;
  }

  const state = {
    device: { id: config.deviceId, name: 'Balcony', fw: '08.0.1-mock', ip: '192.168.1.42', rssi: -63, up: ctl.up,
      lastSeen: now - 40e3, intervalS: 300, havePCA: true },
    telemetry: {}, config: {}, pots: [],
    household: { potNames: { 0: 'Tomato L', 1: 'Tomato R', 2: 'Basil', 3: 'Chili', 4: 'Mint', 5: 'Rosemary', 6: 'Strawberry', 7: 'Lavender' }, ntfyTopic: 'balcony-' + uid(), weatherLoc: null },
    lastRound: null, alerts: [], commands: [], events: [], readings: [],
  };

  // ---- seeded history: 30 days, a round every 12 h (last one 200 min ago), four refills ----
  // The Glance chart is drawn from these events: the tank steps down at every round and jumps at a refill.
  const pushEvent = (e) => { state.events.unshift({ id: uid(), ts: Date.now(), ...e }); if (state.events.length > 400) state.events.length = 400; };
  const ROUND_MS = 12 * 3600e3, N_ROUNDS = 60, LAST_ROUND_TS = now - 200 * 60e3;
  const REFILL_BEFORE = new Set([12, 26, 40, 54]);                     // refill just before round k (k = 0 is the latest round)
  const roundPots = (k) => (k > 12 && k % 2 === 0) ? [0, 1, 4, 7] : [1, 4, 7];   // an extra big pot on some older rounds → the level before the last refill is lower
  const doseOf = (k) => roundPots(k).reduce((sum, ch) => sum + pots[ch].doseML, 0);
  let level = TANK_FULL - 3 * 750;                                            // a few rounds already spent before the window
  for (let k = N_ROUNDS - 1; k >= 0; k--) {
    const ts = LAST_ROUND_TS - k * ROUND_MS;
    if (REFILL_BEFORE.has(k)) { level = TANK_FULL; state.events.push({ id: uid(), ts: ts - 3600e3, kind: 'refill', tankLeft: level }); }
    level -= doseOf(k);
    roundPots(k).forEach(ch => state.events.push({ id: uid(), ts: ts - 20e3, kind: 'dose', ch, ml: pots[ch].doseML, sec: pots[ch].doseML / 30, pct: 28 }));
    state.events.push({ id: uid(), ts: ts - 30e3, kind: 'refused', ch: 11, reason: 'implausible', raw: 3900 });
    state.events.push({ id: uid(), ts, kind: 'round', watered: roundPots(k).length, skipped: 16 - roundPots(k).length - 1, refused: 1, tankLeft: level, tempC: 18.2, trigger: 'auto' });
  }
  ctl.tankLeft = level; ctl.totalML = TANK_FULL - level;      // = 15250 with 13 × 750 mL since the last refill
  state.events.sort((a, b) => b.ts - a.ts);
  state.lastRound = { ...state.events.find(e => e.kind === 'round') };
  for (let h = 30 * 24; h >= 1; h--) {                         // hourly readings (tank = last event before that hour; a day/night temperature curve)
    const t = now - h * 3600e3;
    const ev = state.events.find(e => e.ts <= t && (e.kind === 'round' || e.kind === 'refill'));
    state.readings.push({ ts: t, tankLeft: ev ? ev.tankLeft : level, tempC: 17 + 6 * Math.sin((t / 3600e3) * Math.PI / 12) });
  }

  // ---- alerts (cloud-side rules) ----
  function raise(key, kind, severity, ch, message) {
    if (state.alerts.some(a => a.key === key && a.active)) return;
    state.alerts.unshift({ id: uid(), ts: Date.now(), key, kind, severity, ch, message, active: true, ackedAt: null });
  }
  function clear(key) { state.alerts.forEach(a => { if (a.key === key && a.active) a.active = false; }); }
  function evalAlerts() {
    if (ctl.tankLeft < TANK_FULL / 5) raise('tank_low', 'tank_low', 'warn', null, `Tank at ${Math.round(100 * ctl.tankLeft / TANK_FULL)} % — refill soon`);
    else if (ctl.tankLeft > TANK_FULL / 2) { clear('tank_low'); clear('tank_reserve'); }
    if (ctl.tempOK && ctl.tempC < MIN_TEMP) raise('frost', 'frost', 'info', null, `${ctl.tempC.toFixed(1)} °C — watering suspended below 3 °C`);
    else if (ctl.tempC > 5) clear('frost');
  }
  raise('pot_refused:11', 'pot_refused', 'warn', 11, 'Pot 12 refused: implausible reading — sensor unplugged or broken');
  state.alerts.push({ id: uid(), ts: now - 26 * 3600e3, key: 'offline', kind: 'offline', severity: 'critical', ch: null, message: 'Controller offline for 22 min', active: false, ackedAt: now - 25 * 3600e3 });

  // ---- sensing (evalCh) ----
  function evalCh(p) {
    if (p._unplugged) p.raw = 3900 + Math.round(Math.random() * 80);
    else if (p.air > 0 && p.water > 0) p.raw = Math.round(p.air - (p._true / 100) * (p.air - p.water) + (Math.random() - .5) * 30);
    else p.raw = 1400 + Math.round(Math.random() * 40);
    if (p.air < 0 || p.water < 0) { p.sState = 3; p.pct = -1; return; }
    const lo = Math.min(p.air, p.water) - PLAUS_MARGIN, hi = Math.max(p.air, p.water) + PLAUS_MARGIN;
    if (p.raw < lo || p.raw > hi) { p.sState = 2; p.pct = -1; return; }
    p.sState = 1; p.pct = clamp(Math.round(100 * (p.air - p.raw) / (p.air - p.water)), 0, 100);
  }
  function readAll() { pots.forEach(p => { if (p.i < ctl.nSensors && p.senEn) evalCh(p); }); }
  readAll();

  // ---- publish (what a telemetry post would carry) ----
  function snapshot() {
    state.telemetry = { ts: Date.now(), tempC: ctl.tempC, tempOK: ctl.tempOK, tankLeft: ctl.tankLeft, totalML: ctl.totalML,
      pumpRunning: ctl.pumpRunning, pumpEn: ctl.pumpEn, tempEn: ctl.tempEn, ledEn: ctl.ledEn, autoMin: ctl.autoMin,
      nextRoundAt: nextRoundMs(), rulesHash: ctl.rulesHash, rainPct: ctl.rainPct, rainH: ctl.rainH, wxAgeS: Math.round((Date.now() - ctl.wxAt) / 1000),
      nSensors: ctl.nSensors, nServos: ctl.nServos, mlPerSec: ctl.mlPerSec };
    state.config = { openUs: ctl.openUs, closedUs: ctl.closedUs, tankFull: TANK_FULL, tankReserve: TANK_RESERVE, minTempC: MIN_TEMP, plausMargin: PLAUS_MARGIN, maxPumpMs: MAX_PUMP_MS };
    state.pots = pots.map(p => ({ i: p.i, raw: p.raw, pct: p.pct, sState: p.sState, vState: p.vState, todayML: p.todayML,
      air: p.air, water: p.water, thrPct: p.thrPct, doseML: p.doseML, max: p.max, senEn: p.senEn, valEn: p.valEn }));
    state.device.up = ctl.up; state.device.havePCA = ctl.havePCA;
    if (!offline) state.device.lastSeen = Date.now();
    seq++;
  }
  function emit() { snapshot(); evalAlerts(); const s = getState(); subs.forEach(fn => fn(s)); }
  function getState() { return JSON.parse(JSON.stringify(state)); }

  // ---- the controller's watering path, mirroring waterPot() line by line ----
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let abortPump = false;
  async function pumpMs(ms, what) {
    if (!ctl.pumpEn) return { ok: false, reason: 'pump_disabled' };
    let capped = false;
    if (ms > MAX_PUMP_MS) { ms = MAX_PUMP_MS; capped = true; raise('pump_cap', 'pump_cap', 'warn', null, 'A dose hit the 90 s cap — check the flow constant'); }
    ctl.pumpRunning = true; abortPump = false; pushEvent({ kind: 'pump', on: true, why: what }); emit();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (abortPump) { ctl.pumpRunning = false; pushEvent({ kind: 'pump', on: false, why: 'aborted' }); emit(); return { ok: false, reason: 'aborted' }; } await sleep(100); }
    ctl.pumpRunning = false; pushEvent({ kind: 'pump', on: false, why: capped ? 'capped' : 'done' }); emit();
    return { ok: true };
  }
  async function waterPot(i, quiet, dosePct) {      // dosePct: the round's modifier sum (app/RULES.md §3.4); 0 for a manual `water`
    const p = pots[i];
    const refuse = (reason) => { if (!quiet || reason !== 'wet') pushEvent({ kind: 'refused', ch: i, reason, raw: p.raw, pct: p.pct, tempC: ctl.tempC });
      if (['implausible', 'uncal', 'budget', 'nopca'].includes(reason)) raise(`pot_refused:${i}`, 'pot_refused', 'warn', i, `Pot ${i + 1} refused: ${reasonText(reason)}`);
      if (reason === 'tank') raise('tank_reserve', 'tank_reserve', 'critical', null, 'Tank counter at the reserve — nothing waters until you refill');
      return { ok: false, reason }; };
    if (i < 0 || i >= N_CH) return refuse('nosuch');
    if (i >= ctl.nServos || !p.valEn) return refuse('off');
    if (i >= ctl.nSensors || !p.senEn) return refuse('off');
    if (!ctl.havePCA) return refuse('nopca');
    evalCh(p);
    if (p.sState === 3) return refuse('uncal');
    if (p.sState === 2) return refuse('implausible');
    if (p.pct >= p.thrPct) return refuse('wet');
    if (ctl.tempEn && ctl.tempOK && ctl.tempC < MIN_TEMP) return refuse('cold');
    const ml = Rules.scaleDose(p.doseML, dosePct || 0);
    if (ctl.tankLeft - ml < TANK_RESERVE) return refuse('tank');
    if (p.todayML + ml > p.max * p.doseML) return refuse('budget');           // per-pot budget on the UNSCALED class
    if (todayTotal() + ml > dailyML()) return refuse('budget');              // global daily cap (review #13)
    const ms = 1000 * ml / ctl.mlPerSec;
    p.vState = 2; emit(); await sleep(500);
    const r = await pumpMs(ms, 'dosing');
    p.vState = 1; emit(); await sleep(700); p.vState = 3;
    if (r.ok) {
      ctl.tankLeft -= ml; ctl.totalML += ml; p.todayML += ml; p._true = Math.min(95, p._true + 45);
      pushEvent({ kind: 'dose', ch: i, ml, sec: ms / 1000, pct: p.pct, tankLeft: ctl.tankLeft });
      clear(`pot_refused:${i}`);
    }
    emit();
    return r.ok ? { ok: true, ml, sec: +(ms / 1000).toFixed(1) } : r;
  }
  async function runRound(trigger, sched) {          // sched: the schedule line that fired (null = manual run / auto timer)
    ctl.pumpRunning = false; pots.forEach(p => { if (p.vState !== 3) p.vState = 3; }); emit(); await sleep(200);
    readAll();
    // modifiers (app/RULES.md §3.4): evaluated once per round, after sensing; unknown inputs count as false
    const plan = Rules.roundPlan(ctl.rules, { tempC: ctl.tempEn && ctl.tempOK ? ctl.tempC : null, rainPct: Date.now() - ctl.wxAt < 86400e3 ? ctl.rainPct : null, rainH: ctl.rainH, tankPct: 100 * ctl.tankLeft / TANK_FULL });
    const nFitted = Math.min(ctl.nSensors, ctl.nServos);
    let watered = 0, skipped = 0, refused = 0;
    if (plan.skip) { skipped = nFitted; pushEvent({ kind: 'round_skipped', by: plan.skip.if.k, trigger }); }
    else for (const i of Rules.targets(sched, nFitted)) {
      const r = await waterPot(i, true, plan.dosePct);
      if (r.ok) watered++; else if (r.reason === 'wet' || r.reason === 'off') skipped++; else refused++;
    }
    state.lastRound = { ts: Date.now(), watered, skipped, refused, tankLeft: ctl.tankLeft, tempC: ctl.tempC, trigger, skippedBy: plan.skip ? plan.skip.if.k : undefined, dosePct: plan.dosePct || undefined };
    pushEvent({ kind: 'round', ...state.lastRound });
    emit();
    return { watered, skipped, refused, tankLeft: ctl.tankLeft };
  }
  function reasonText(r) {
    return { off: 'switched off or not fitted', nopca: 'no PCA9685 — cannot move a valve', uncal: 'not calibrated', implausible: 'implausible reading — sensor unplugged or broken',
      wet: 'wet enough, skipped', cold: 'too cold to water', tank: 'tank counter at the reserve', budget: 'daily budget already used', pump_disabled: 'pump is switched off',
      aborted: 'aborted', bad_rules: 'the controller rejected the rule set', expired: 'expired — controller was offline', nosuch: 'no such pot' }[r] || r;
  }

  // ---- command execution (handle()) ----
  async function execute(cmd, args) {
    const p = args && Number.isInteger(args.ch) ? pots[args.ch] : null;
    switch (cmd) {
      case 'water': return waterPot(args.ch, false, 0);
      case 'run': return { ok: true, ...(await runRound('cmd')) };
      case 'auto': ctl.autoMin = Math.max(0, args.min | 0); ctl.autoLast = Date.now(); return { ok: true, autoMin: ctl.autoMin };
      case 'tank': ctl.tankLeft = args.full ? TANK_FULL : clamp(args.ml | 0, 0, TANK_FULL); pushEvent({ kind: 'refill', tankLeft: ctl.tankLeft }); clear('tank_low'); clear('tank_reserve'); return { ok: true, tankLeft: ctl.tankLeft };
      case 'thr': p.thrPct = clamp(args.pct | 0, 1, 99); return { ok: true, ch: p.i, thrPct: p.thrPct };
      case 'dose': p.doseML = clamp(args.ml | 0, 10, 2000); return { ok: true, ch: p.i, doseML: p.doseML };
      case 'cal':
        if (args.clear) { p.air = p.water = -1; }
        else if (args.which) { await sleep(1200); const v = args.which === 'air' ? 1700 + Math.round(Math.random() * 60) : 1080 + Math.round(Math.random() * 50); if (args.which === 'air') p.air = v; else p.water = v; }
        else { p.air = args.air | 0; p.water = args.water | 0; }
        evalCh(p);
        return { ok: true, ch: p.i, air: p.air, water: p.water, warn: p.air > 0 && p.water > 0 && Math.abs(p.air - p.water) < 200 ? 'air and water are very close' : undefined };
      case 'en': {
        const w = String(args.what), on = !!args.on;
        if (w === 'all') { pots.forEach(q => { q.senEn = q.valEn = on; }); ctl.pumpEn = ctl.tempEn = ctl.ledEn = on; }
        else if (w === 'sensors') pots.forEach(q => q.senEn = on);
        else if (w === 'valves') pots.forEach(q => q.valEn = on);
        else if (w === 'pump') { ctl.pumpEn = on; if (!on) { abortPump = true; ctl.pumpRunning = false; } }
        else if (w === 'temp') ctl.tempEn = on;
        else if (w === 'led') ctl.ledEn = on;
        else if (w.startsWith('pot')) { const q = pots[+w.slice(3) - 1]; if (q) q.senEn = q.valEn = on; }
        else if (w[0] === 's') { const q = pots[+w.slice(1) - 1]; if (q) q.senEn = on; }
        else if (w[0] === 'v') { const q = pots[+w.slice(1) - 1]; if (q) { q.valEn = on; if (!on) q.vState = 3; } }
        else return { ok: false, reason: 'bad_what' };
        return { ok: true, what: w, on };
      }
      case 'fit': ctl.nSensors = clamp(args.nSensors | 0, 0, N_CH); ctl.nServos = clamp(args.nServos | 0, 0, N_CH); return { ok: true, nSensors: ctl.nSensors, nServos: ctl.nServos };
      case 'flow': ctl.mlPerSec = Math.max(0.1, +args.mlPerSec || 30); return { ok: true, mlPerSec: ctl.mlPerSec };
      case 'vlim': ctl.openUs = clamp(args.openUs | 0, 500, 2500); ctl.closedUs = clamp(args.closedUs | 0, 500, 2500); return { ok: true, openUs: ctl.openUs, closedUs: ctl.closedUs };
      case 'v': p.vState = { o: 2, c: 1, x: 3 }[args.st] ?? 0; return { ok: true, ch: p.i, vState: p.vState };
      case 'vtest': p.vState = 2; emit(); await sleep(1000); p.vState = 1; emit(); await sleep(700); p.vState = 3; return { ok: true };
      case 'vall': if (args.st === 'c') { for (const q of pots.slice(0, ctl.nServos)) { q.vState = 1; emit(); await sleep(300); } } pots.forEach(q => q.vState = 3); return { ok: true };
      case 'p': { const r = await pumpMs(clamp(+args.sec || 0, 0, 90) * 1000, 'manual'); return { ...r, sec: args.sec }; }
      case 'pstop': abortPump = true; return { ok: true };
      case 'stop': abortPump = true; ctl.pumpRunning = false; pots.forEach(q => q.vState = 3); pushEvent({ kind: 'estop' }); raise('estop', 'estop', 'info', null, 'Emergency stop received — pump off, all PWM cut'); return { ok: true };
      case 'save': case 'defaults': return { ok: true };
      case 'refresh': readAll(); return { ok: true };
      case 'temp': return { ok: true, tempC: ctl.tempC, tempOK: ctl.tempOK };
      case 'hwcheck': await sleep(800); return { ok: true, text: 'I2C: 0x40 PCA9685, 0x70 all-call\n1-Wire: idle HIGH, probe responds\nsensors: 15 of 16 plausible (ch 11 open)\npump gate LOW at boot' };
      case 'sweep': return { ok: true, raw: pots.map(q => q.raw) };
      case 'interval': state.device.intervalS = clamp(args.s | 0, 60, 3600); return { ok: true, interval_s: state.device.intervalS };
      case 'rules': {                                                         // app/RULES.md §2 — validate, apply pots{}, keep the last good set on error
        if (args.clear) { ctl.rules = null; ctl.rulesHash = ''; pushEvent({ kind: 'rules', hash: '' }); return { ok: true, rulesHash: '' }; }
        const r = Rules.fromJSON(args);
        if (!r.ok) return { ok: false, reason: 'bad_rules', detail: r.error };
        const json = Rules.compile(r.rules);
        if (json.length > Rules.LIM.bytes) return { ok: false, reason: 'bad_rules', detail: `too long (${json.length} B)` };
        Object.keys(r.rules.pots).forEach(k => { const q = pots[+k], s = r.rules.pots[k];
          if (s.thr !== undefined) q.thrPct = s.thr; if (s.dose !== undefined) q.doseML = s.dose; if (s.max !== undefined) q.max = s.max;
          if (s.on !== undefined) { q.senEn = s.on; q.valEn = s.on; } });
        ctl.rules = r.rules; ctl.rulesHash = Rules.hash(json); ctl.autoLast = Date.now();
        pushEvent({ kind: 'rules', hash: ctl.rulesHash });
        return { ok: true, rulesHash: ctl.rulesHash, n: { schedule: r.rules.schedule.length, pots: Object.keys(r.rules.pots).length, modifiers: r.rules.modifiers.length } };
      }
      case 'weather': ctl.rainPct = clamp(args.rainPct | 0, 0, 100); ctl.rainH = clamp(args.h | 0, 1, 48); ctl.tMaxC = args.tMaxC | 0; ctl.wxAt = Date.now(); return { ok: true, rainPct: ctl.rainPct, h: ctl.rainH };
      case 'reboot': ctl.up = 0; pushEvent({ kind: 'boot', fw: state.device.fw, reason: 'sw' }); return { ok: true };
      default: return { ok: false, reason: 'unknown_cmd' };
    }
  }

  const TTL_SHORT = 30 * 60e3, TTL_LONG = 24 * 3600e3;
  const settingCmds = new Set(['thr', 'dose', 'cal', 'en', 'fit', 'flow', 'vlim', 'auto', 'tank', 'interval', 'save', 'defaults', 'rules', 'weather']);
  let busy = Promise.resolve();
  function sendCommand(cmd, args) {
    const rec = { id: uid(), cmd, args: args || {}, status: 'queued', createdAt: Date.now(), ackedAt: null, result: null,
      expiresAt: cmd === 'stop' ? null : Date.now() + (settingCmds.has(cmd) ? TTL_LONG : TTL_SHORT) };
    state.commands.unshift(rec); if (state.commands.length > 40) state.commands.length = 40;
    emit();
    return new Promise((resolve) => {
      const attempt = () => {
        if (offline) {                                            // controller not polling: wait or expire
          if (rec.expiresAt && Date.now() > rec.expiresAt) { rec.status = 'expired'; rec.result = { reason: 'expired' }; emit(); resolve({ ...rec }); return; }
          setTimeout(attempt, 1000); return;
        }
        busy = busy.then(async () => {
          rec.status = 'sent'; emit(); await sleep(400);
          const r = await execute(cmd, rec.args);
          rec.status = r.ok ? 'acked' : 'failed'; rec.result = r; rec.ackedAt = Date.now();
          emit(); resolve({ ...rec });
        });
      };
      setTimeout(attempt, 250);
    });
  }

  // ---- the world ticks: drying, temperature, auto rounds, daily reset ----
  let dayMark = new Date().getDate(), lastTick = Date.now();
  setInterval(() => {
    ctl.up += 1;
    pots.forEach(p => { p._true = Math.max(0, p._true - p._rate); });
    ctl.tempC = 17 + 6 * Math.sin((Date.now() / 3600e3) * Math.PI / 12) + (Math.random() - .5) * .1;
    if (new Date().getDate() !== dayMark) { dayMark = new Date().getDate(); pots.forEach(p => p.todayML = 0); pushEvent({ kind: 'budget_reset' }); }
    const nowMs = Date.now();
    if (ctl.rules && ctl.rules.schedule.length) {                   // rules present: the schedule lines trigger rounds (app/RULES.md §3.3)
      const due = Rules.triggersBetween(ctl.rules, lastTick, nowMs, ctl.autoLast);
      if (due.length && !offline) { ctl.autoLast = nowMs; const s = due[0].sched; busy = busy.then(() => runRound('rule', s)); }
    } else if (ctl.autoMin > 0 && !offline && nowMs - ctl.autoLast > ctl.autoMin * 60e3) { ctl.autoLast = nowMs; busy = busy.then(() => runRound('auto', null)); }
    lastTick = nowMs;
  }, 1000);
  setInterval(() => { if (offline) return; readAll(); state.readings.push({ ts: Date.now(), tankLeft: ctl.tankLeft, tempC: ctl.tempC }); if (state.readings.length > 2000) state.readings.shift(); emit(); }, 5000);

  return {
    isMock: true,
    async init() { emit(); },
    getState,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    sendCommand,
    async ackAlert(id) { state.alerts.forEach(a => { if (id === 'all' || a.id === id) a.ackedAt = a.ackedAt || Date.now(); }); emit(); },
    async setHousehold(patch) { Object.assign(state.household, patch); emit(); },
    async login() { return { email: 'household@example.org' }; },
    async logout() {},
    session() { return { email: 'household@example.org' }; },
    // history for the charts (backend.js: History shape). Readings/events are the seeded 30 days.
    async history(days) { return historyFromLocal(state.readings, state.events, days, Date.now()); },
    // one pot's moisture: simulated forward over the window at a realistic ~1 %/h (not the demo's fast live drift), +45 % at each dose, a little day/night wobble
    async potHistory(ch, days) {
      const p = pots[ch], now = Date.now(), from = Math.floor((now - days * 86400e3) / 3600e3) * 3600e3, ratePerH = 0.7 + 0.2 * (ch % 4);
      const doses = state.events.filter(e => e.kind === 'dose' && e.ch === ch && e.ts >= from).map(e => ({ ts: e.ts, ml: e.ml })).sort((a, b) => a.ts - b.ts);
      const moisture = [];
      if (p.sState === 1 || (p.air > 0 && p.water > 0 && !p._unplugged)) {
        let v = 60;
        for (let t = from; t <= now; t += 3600e3) {
          if (doses.some(d => d.ts > t - 3600e3 && d.ts <= t)) v = Math.min(95, v + 45);
          v = clamp(v - ratePerH, 0, 95);
          moisture.push({ ts: t, pct: Math.round(clamp(v + 2 * Math.sin((t / 3600e3) * Math.PI / 12), 0, 100)) });
        }
        moisture[moisture.length - 1].pct = Math.round(clamp(p._true, 0, 100));   // the last point is the live value
      }
      return { days, moisture, doses };
    },
    // mock-only controls (Settings shows them when isMock)
    mock: {
      setOffline(v) { offline = !!v; emit(); },
      isOffline() { return offline; },
      dryOut(i) { pots[i]._true = 10; readAll(); emit(); },
      setForecast(pct) { ctl.rainPct = clamp(pct | 0, 0, 100); ctl.wxAt = Date.now(); emit(); },
      dryRates() { return pots.map(p => p._rate * 3600); },     // % per hour, for the Preview's drying model
      reasonText,
    },
  };
}
