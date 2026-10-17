// mock.js — a fake firmware-0.5.0 controller in the browser (app/SPEC.md Part 2 = the contract).
// It builds the same payload the board posts and runs it through mapPayload() (backend.js), executes the contract's
// commands with the board's rules (one valve at a time, every move ends relaxed, manual water never checks the sensor,
// plans never water a pot without a working sensor, 90 s cap, tank reserve, frost), and runs the plan schedule.
// Pumping runs 5× faster than real time so a demo round does not take minutes; ran_ms reports the real-time figure.
// Demo switches in the address bar: ?frost=1 (forecast low 1.5 °C → every dose refused).

function createMockBackend(config) {
  const SPEED = 5, MAX_PUMP_MS = 90000, RESERVE = 500, SWIM_SD = 60, PLAUS = 250;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const subs = new Set();
  let frostQ = false; try { frostQ = new URLSearchParams(location.search).get('frost') === '1'; } catch (e) { /* node */ }

  // ---- the board ----
  const TRUE = [71, 24, 15, 58, 33, 52];
  const chs = [];
  for (let i = 0; i < 16; i++) {
    const air = 2700 + Math.round(Math.random() * 90), water = 1600 + Math.round(Math.random() * 70);
    chs.push({ senEn: i < 6, valEn: i < 7, air: i < 6 ? air : -1, water: i < 6 ? water : -1, soilDry: i === 0 ? 2510 : -1, soilWet: i === 0 ? 1650 : -1,
      _air: air, _water: water, _true: TRUE[i] === undefined ? 50 : TRUE[i], _rate: 0.004 + Math.random() * 0.006,
      raw: 0, pct: -1, sd: 0, sState: 1, vState: 1, vOpenUs: 2500, vClosedUs: 1300, todayML: 0, lastML: 0, lastTs: 0, lastWhy: '', filling: false });
  }
  const b = { fw: '0.5.0-mock', mlPerSec: 30.0, tankFullML: 25000, tankLeft: 15300, pumpRunning: false, pumpEn: true, havePCA: true,
    running: null, queue: [], frostMinC: frostQ ? 1.5 : 8.5, frostAt: Date.now() - 20 * 60e3, up: 3 * 86400,
    rules: Rules.upgrade({ v: 2, plans: [
      { id: 'a', name: 'Default', on: true, times: ['07:00', '19:00'], mode: 'min', thr: 49, min: 35, max: 60, dose: 900 },
      { id: 'b', name: 'Herbs', on: false, times: ['08:30'], mode: 'max', thr: 70, min: 35, max: 60, dose: 250 }],
      default: 'a', pots: { 6: 'b' } }) };   // written in the v2 form, handed to the pots as a 0.6.0 board does at boot
  b.rulesHash = Rules.hash(Rules.compile(b.rules));
  const maxDose = () => Math.floor(b.mlPerSec * MAX_PUMP_MS / 1000 / 10) * 10;
  const frostNow = () => b.frostMinC !== null && Date.now() - b.frostAt < 6 * 3600e3 && b.frostMinC < 3;

  function readCh(c) {
    if (!c.senEn) { c.raw = 300 + Math.round(Math.random() * 3400); c.sd = 180 + Math.round(Math.random() * 120); c.sState = 1; c.pct = -1; return; }
    c.raw = Math.round(c._air - c._true / 100 * (c._air - c._water) + (Math.random() - .5) * 16); c.sd = 5 + Math.round(Math.random() * 6);
    if (c.sd > SWIM_SD || c.raw < 100 || c.raw > 4000) { c.sState = 1; c.pct = -1; return; }
    if (c.air < 0 || c.water < 0) { c.sState = 3; c.pct = -1; return; }
    if (c.raw < Math.min(c.air, c.water) - PLAUS || c.raw > Math.max(c.air, c.water) + PLAUS) { c.sState = 2; c.pct = -1; return; }
    c.sState = 0; c.pct = clamp(Math.round(100 * (c.air - c.raw) / (c.air - c.water)), 0, 100);
  }
  const readAll = () => chs.forEach(readCh);
  readAll();

  // ---- history: 30 days of rounds at 07:00 / 19:00, refills when the tank runs low, one level set ----
  const events = [], readings = [], now0 = Date.now();
  {
    let level = 25000;
    const d0 = dayStart(now0, -30);
    events.push({ ts: d0, kind: 'refill', tankLeft: level });
    for (let d = 0; d <= 30; d++) {
      [7, 19].forEach((hr, slot) => {
        const ts = dayStart(d0, d) + hr * 3600e3; if (ts > now0) return;
        if (level < 9000) { level = 25000; events.push({ ts: ts - 2 * 3600e3, kind: 'refill', tankLeft: level }); }
        if (d === 12 && slot === 0) { level -= 800; events.push({ ts: ts - 3600e3, kind: 'level', tankLeft: level }); }
        const pots = [(d * 2 + slot) % 6]; if (d % 3 === 0 && slot === 0) pots.push((d + 3) % 6);
        pots.forEach((ch, k) => { level -= 900; events.push({ ts: ts + k * 40e3, kind: 'dose', ch, ml: 900, tankLeft: level, plan: 'a', pct: 30 + (d * 7 + ch) % 15 }); });
        const ref = d % 7 === 0 && slot === 1; if (ref) events.push({ ts: ts + pots.length * 40e3, kind: 'refused', ch: 5, reason: 'implausible' });
        events.push({ ts: ts + pots.length * 40e3 + 30e3, kind: 'round', plan: 'a', trigger: 'plan', watered: pots.length, skipped: 4 - pots.length, refused: ref ? 1 : 0, tankLeft: level });
      });
    }
    events.sort((x, y) => x.ts - y.ts);
    let k = 0, lv = 25000;
    for (let t = dayStart(now0, -30); t <= now0; t += 3600e3) { while (k < events.length && events[k].ts <= t) lv = events[k++].tankLeft; readings.push({ ts: t, tankLeft: lv }); }
    b.tankLeft = lv;
    const lastDose = (ch) => { for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'dose' && events[i].ch === ch) return events[i]; return null; };
    chs.forEach((c, ch) => { const e = lastDose(ch); if (e) { c.lastML = e.ml; c.lastTs = e.ts; c.lastWhy = 'watered'; } });
  }
  const pushEvent = (e) => { events.push({ ts: Date.now(), ...e }); if (events.length > 2000) events.shift(); };

  // ---- the payload the board would post (contract names) → the app's state ----
  function payload() {
    const nt = Rules.nextTrigger(b.rules, Date.now());
    return { fw: b.fw, up: b.up, mlPerSec: b.mlPerSec, maxDoseML: maxDose(), maxPumpMs: MAX_PUMP_MS, tankLeft: b.tankLeft, tankFullML: b.tankFullML,
      tankReserve: RESERVE, pumpRunning: b.pumpRunning, pumpEn: b.pumpEn, rulesHash: b.rulesHash,
      planNext: nt ? Math.floor(nt.t / 1000) : 0, planNextId: nt ? nt.plan.id : '', running: b.running, queue: b.queue.slice(),
      frostMinC: b.frostMinC, frostAgeS: Math.round((Date.now() - b.frostAt) / 1000),
      ch: chs.map(c => ({ senEn: c.senEn, valEn: c.valEn, raw: c.raw, pct: c.pct, sd: c.sd, sState: c.sState, air: c.air, water: c.water,
        soilDry: c.soilDry, soilWet: c.soilWet, vState: c.vState, vOpenUs: c.vOpenUs, vClosedUs: c.vClosedUs, todayML: c.todayML,
        lastML: c.lastML, lastTs: c.lastTs ? Math.floor(c.lastTs / 1000) : 0, lastWhy: c.lastWhy, filling: c.filling })) };
  }
  let state = null;
  function emit() {
    const m = mapPayload(payload()), mk = [...events].reverse().find(e => e.kind === 'refill' || e.kind === 'level');
    state = { device: { id: config.deviceId, fw: b.fw, ip: '192.168.1.42', rssi: -63, up: b.up, lastSeen: Date.now(), intervalS: 300 },
      t: m.t, ch: m.ch, rules: JSON.parse(JSON.stringify(b.rules)), potNames, potLook, mark: mk ? { ts: mk.ts, tankLeft: mk.tankLeft } : null };
    subs.forEach(fn => fn(state));
  }
  const potNames = { 0: 'Tomato L', 1: 'Tomato R', 2: 'Basil', 3: 'Mint', 4: 'Chili', 5: 'Thyme', 6: 'Lavender' };
  let potLook = { 0: { e: '🍅' }, 1: { e: '🍅' }, 2: { e: '🌿' }, 3: { e: '🌱' }, 4: { e: '🌶️' } };

  // ---- valves and pump ----
  let abort = false;
  async function moveValve(ch, open) {                 // drive, hold, relax — one servo at a time
    await sleep(open ? 700 : 900); chs[ch].vState = open ? 2 : 1; emit();
  }
  async function closeOthers(except) { for (let i = 0; i < 16; i++) if (i !== except && chs[i].vState !== 1) await moveValve(i, false); }
  async function pump(ms, onTick) {                   // → ran_ms (real-time figure); stoppable
    b.pumpRunning = true; abort = false; emit();
    const t0 = Date.now(); let ran = 0;
    while (ran < ms && !abort) { await sleep(100); ran = Math.min(ms, (Date.now() - t0) * SPEED); if (onTick) onTick(ran); }
    b.pumpRunning = false; emit();
    return Math.round(ran);
  }
  // One dose (manual or plan): close the others, open, settle, pump, close, book what really ran.
  async function dose(ch, ml, plan) {
    const c = chs[ch];
    await closeOthers(ch); await moveValve(ch, true); await sleep(500);
    b.running = { plan: plan || '', ch, ml: 0, target: ml }; emit();
    const ran = await pump(Math.min(MAX_PUMP_MS, 1000 * ml / b.mlPerSec), (r) => { if (b.running) { b.running.ml = Math.round(r / 1000 * b.mlPerSec); emit(); } });
    const pumped = Math.round(ran / 1000 * b.mlPerSec), stopped = abort;
    b.running = null; if (!stopped) await moveValve(ch, false);      // an e-stop sends no close pulse: the valve stays as it is (state unknown)
    b.tankLeft = Math.max(0, b.tankLeft - pumped); c.todayML += pumped; c.lastML = pumped; c.lastTs = Date.now(); c._true = Math.min(95, c._true + pumped / 20);
    if (pumped) pushEvent({ kind: 'dose', ch, ml: pumped, tankLeft: b.tankLeft, plan: plan || '', pct: c.pct });
    emit();
    return stopped ? { ok: false, reason: 'aborted', ch, ml_pumped: pumped, ran_ms: ran } : { ok: true, ch, ml_pumped: pumped, ran_ms: ran };
  }
  async function round(planId) {
    const plan = Rules.planById(b.rules, planId); if (!plan) return { ok: false, reason: 'no_plan' };
    abort = false; readAll(); await closeOthers(-1);
    const ctx = () => ({ maxDoseML: maxDose(), tankLeft: b.tankLeft, tankReserve: RESERVE, frost: frostNow() });
    const plan0 = Rules.preview(b.rules, planId, chs, ctx());
    b.queue = plan0.filter(x => x.action === 'water').map(x => x.ch); emit();
    let watered = 0, skipped = 0, refused = 0;
    for (const item of plan0) {
      if (abort) break;
      const c = chs[item.ch], d = Rules.decide(Rules.potSet(b.rules, item.ch), c, ctx());
      c.lastWhy = d.why; c.filling = d.filling;
      b.queue = b.queue.filter(x => x !== item.ch);
      if (d.action === 'water') { const r = await dose(item.ch, d.ml, planId); watered++; if (!r.ok) break; }
      else if (['wet', 'off', 'nosensor', 'frost'].includes(d.why)) skipped++;     // as the board: these are skips, the rest is refused + an event
      else { refused++; pushEvent({ kind: 'refused', ch: item.ch, reason: d.why, pct: c.pct }); }
    }
    b.queue = []; pushEvent({ kind: 'round', plan: planId, trigger: 'cmd', watered, skipped, refused, tankLeft: b.tankLeft }); emit();
    return abort ? { ok: false, reason: 'aborted', watered, skipped, refused } : { ok: true, watered, skipped, refused };
  }

  // ---- commands (contract table) ----
  const en = (what) => { const m = /^([sv])(\d+)$/.exec(String(what)); return m && +m[2] >= 1 && +m[2] <= 16 ? { k: m[1], ch: +m[2] - 1 } : null; };
  async function execute(cmd, a) {
    const c = Number.isInteger(a.ch) ? chs[a.ch] : null;
    switch (cmd) {
      case 'valve': if (!c) return { ok: false, reason: 'nosuch' }; if (!b.havePCA) return { ok: false, reason: 'nopca' };
        if (a.open) await closeOthers(a.ch); await moveValve(a.ch, !!a.open); return { ok: true, ch: a.ch, vState: c.vState };
      case 'valves_all': { let n = 0; for (let i = 0; i < 16; i++) if (chs[i].valEn) { await moveValve(i, !!a.open); n++; } return { ok: true, n }; }
      case 'pump': if (!a.on) { abort = true; return { ok: true, ran_ms: 0 }; } return { ok: true, ran_ms: await pump(Math.min(MAX_PUMP_MS, (+a.sec || 90) * 1000)) };
      case 'water': {
        if (!c) return { ok: false, reason: 'nosuch' };
        if (!c.valEn) return { ok: false, reason: 'off' };
        if (!b.havePCA) return { ok: false, reason: 'nopca' };
        const ml = Math.round(+a.ml);
        if (!(ml > 0)) return { ok: false, reason: 'too_much', maxDoseML: maxDose() };
        if (ml > maxDose()) return { ok: false, reason: 'too_much', maxDoseML: maxDose() };
        if (frostNow()) return { ok: false, reason: 'frost' };
        if (b.tankLeft - ml < RESERVE) return { ok: false, reason: 'tank' };
        return dose(a.ch, ml, '');
      }
      case 'run': return round(a.plan);
      case 'rules': {
        const r = Rules.fromJSON(a);
        if (!r.ok) return { ok: false, reason: 'bad_rules', detail: r.error };
        b.rules = r.rules; b.rulesHash = Rules.hash(JSON.stringify(a)); return { ok: true, rulesHash: b.rulesHash };
      }
      case 'cal': { if (!c) return { ok: false, reason: 'nosuch' }; await sleep(1200);
        const v = (a.which === 'air' ? c._air : c._water) + Math.round((Math.random() - .5) * 16); if (a.which === 'air') c.air = v; else c.water = v;
        readCh(c); return { ok: true, ch: a.ch, air: c.air, water: c.water, sd: c.sd }; }
      case 'soil': { if (!c) return { ok: false, reason: 'nosuch' }; await sleep(1200);
        const v = Math.round(c._air - (a.which === 'dry' ? 0.12 : 0.88) * (c._air - c._water)); if (a.which === 'dry') c.soilDry = v; else c.soilWet = v;
        return { ok: true, ch: a.ch, soilDry: c.soilDry, soilWet: c.soilWet }; }
      case 'cal_copy': { if (!c) return { ok: false, reason: 'nosuch' };
        chs.forEach(x => { if (a.kind === 'soil') { x.soilDry = c.soilDry; x.soilWet = c.soilWet; } else { x.air = c.air; x.water = c.water; } }); readAll(); return { ok: true, n: 16 }; }
      case 'servo': { const o = clamp(a.openUs | 0, 500, 2500), cl = clamp(a.closedUs | 0, 500, 2500);
        (a.all ? chs : [c]).forEach(x => { x.vOpenUs = o; x.vClosedUs = cl; }); return a.all ? { ok: true, all: true, openUs: o, closedUs: cl } : { ok: true, ch: a.ch, openUs: o, closedUs: cl }; }
      case 'pump_test': { if (!c) return { ok: false, reason: 'nosuch' };
        await closeOthers(a.ch); await moveValve(a.ch, true); await sleep(500); const ran = await pump(Math.min(MAX_PUMP_MS, (+a.sec || 10) * 1000)); if (!abort) await moveValve(a.ch, false);
        b.tankLeft = Math.max(0, b.tankLeft - Math.round(ran / 1000 * b.mlPerSec)); return { ok: true, ch: a.ch, ran_ms: ran }; }
      case 'flow': { const f = +a.mlPerSec; if (!(f >= 1 && f <= 200)) return { ok: false, reason: 'range' }; b.mlPerSec = +f.toFixed(1); return { ok: true, mlPerSec: b.mlPerSec, maxDoseML: maxDose() }; }
      case 'tank': b.tankLeft = a.full ? b.tankFullML : clamp(Math.round(+a.ml || 0), 0, b.tankFullML); pushEvent({ kind: a.full ? 'refill' : 'level', tankLeft: b.tankLeft }); readings.push({ ts: Date.now(), tankLeft: b.tankLeft }); return { ok: true, tankLeft: b.tankLeft };
      case 'tanksize': { const v = Math.round(+a.ml); if (!(v > 0)) return { ok: false, reason: 'range' }; b.tankFullML = v; b.tankLeft = Math.min(b.tankLeft, v); return { ok: true, tankFullML: v }; }
      case 'en': { const w = en(a.what); if (!w) return { ok: false, reason: 'bad_what' }; if (w.k === 's') chs[w.ch].senEn = !!a.on; else chs[w.ch].valEn = !!a.on; readCh(chs[w.ch]); return { ok: true }; }
      case 'refresh': readAll(); return { ok: true };
      case 'frost': b.frostMinC = +a.tMinC; b.frostAt = Date.now(); return { ok: true };
      default: return { ok: false, reason: 'unknown_cmd' };
    }
  }
  function stopNow() { abort = true; b.pumpRunning = false; b.running = null; b.queue = []; chs.forEach(x => { if (x.vState === 2) x.vState = 0; }); pushEvent({ kind: 'estop' }); emit(); }

  let busy = Promise.resolve();
  function sendCommand(cmd, args) {
    args = args || {};
    if (cmd === 'stop' || (cmd === 'pump' && !args.on)) {                       // acts at once, also mid-dose
      return sleep(300).then(() => { if (cmd === 'stop') stopNow(); else abort = true; return { status: 'acked', result: { ok: true, ran_ms: 0 } }; });
    }
    const p = busy.then(async () => { await sleep(300); const r = await execute(cmd, args); emit(); return { status: r.ok ? 'acked' : 'failed', result: r }; });
    busy = p.catch(() => {});
    return p;
  }

  // ---- the world ticks: drying, the plan schedule, the day boundary ----
  let lastTick = Date.now(), day = dayStart(Date.now(), 0);
  setInterval(() => {
    b.up++; chs.forEach(c => { c._true = Math.max(0, c._true - c._rate); });
    const now = Date.now();
    if (dayStart(now, 0) !== day) { day = dayStart(now, 0); chs.forEach(c => { c.todayML = 0; }); }
    Rules.triggersBetween(b.rules, lastTick, now).forEach(tr => { busy = busy.then(() => round(tr.plan.id)).catch(() => {}); });
    lastTick = now;
  }, 1000);
  setInterval(() => { if (!b.running) readAll(); readings.push({ ts: Date.now(), tankLeft: b.tankLeft }); emit(); }, 5000);

  return {
    isMock: true,
    async init() { emit(); },
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    sendCommand,
    async setPotName(ch, name) { if (name) potNames[ch] = name; else delete potNames[ch]; emit(); },
    async setPotLook(look) { potLook = look; emit(); },
    async history(days, endOffsetDays) { return historyFromLocal(readings, events, days, Date.now(), endOffsetDays || 0); },
    // one pot's moisture: −0.3 %/h, a jump at each dose, ending on the live value
    async runs(days) { return runsFromEvents(events, dayStart(Date.now(), -(days - 1))); },
    async potHistory(ch, days) {
      const now = Date.now(), from = dayStart(now, -(days - 1)), c = chs[ch];
      const doses = events.filter(e => e.kind === 'dose' && e.ch === ch && e.ts >= from).map(e => ({ ts: e.ts, ml: e.ml }));
      const moisture = [];
      if (c.sState === 0) {
        let v = 55, k = 0;
        for (let t = from; t <= now; t += 3600e3) { while (k < doses.length && doses[k].ts <= t) v = Math.min(95, v + doses[k++].ml / 25); v = clamp(v - 0.3, 5, 95); moisture.push({ ts: t, pct: Math.round(v) }); }
        moisture.push({ ts: now, pct: c.pct });
      }
      return { moisture, doses };
    },
    async login() { return { email: 'demo' }; },
    async logout() {},
    session() { return { email: 'demo' }; },
    // fake weather over the chart's pannable range (weather.js chart shape)
    weatherChart() {
      const d0 = dayStart(Date.now(), 0), days = [];
      for (let k = -92; k <= 7; k++) {
        const day = dayStart(d0, k), tD = Math.round(17 + 7 * Math.sin(k / 3)), rain = (k % 4 === 0 || k === 2) ? 2 + Math.abs(k % 7) * 1.5 : 0;
        days.push({ day, code: rain ? 61 : [0, 1, 2, 3][Math.abs(k) % 4], mm: +rain.toFixed(1), tDay: tD, tNight: tD - 8 - Math.abs(k % 3) });
      }
      return { days };
    },
  };
}
