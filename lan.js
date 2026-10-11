// lan.js — the controller on the home WiFi, no cloud (firmware 0.5.0: GET /api/state, POST /api/cmd).
// /api/state carries the same names as the cloud telemetry (contract) plus `rules` = the stored plan document, `busy`/`queued`, `events`, so the
// same mapPayload() (backend.js) reads both. History here starts when this tab opened (one tank reading a minute) plus
// whatever the board's own event ring holds (`events`, if present). Pot names live in this browser (localStorage).
//
// App command → console line (pot n = ch + 1):
//   valve {ch,open} → v <n> o|c          valves_all {open} → vall o|c        pump {on,sec} → p <sec> / pstop
//   stop → !                              water {ch,ml} → w <n> <ml>           run {plan} → rules run <id>
//   rules {…} → rules <json>              cal {ch,which} → cal <n> air|water   soil {ch,which} → soil <n> dry|wet
//   cal_copy {ch,kind} → calcopy <n> air|soil                                  servo {ch,openUs,closedUs,all} → vpos <n>|all <o> <c>
//   pump_test {ch,sec} → ptest <n> <sec>  flow {mlPerSec} → flow <x>           tank {full}/{ml} → tank full / tank <ml>
//   tanksize {ml} → tanksize <ml>         en {what,on} → en s<n>|v<n> on|off   refresh → r
// /api/cmd answers at once; when its JSON carries the ack fields they are used, otherwise the result is read from the
// following polls (the condition per command is in done() below).

function createLanBackend(config) {
  const POLL_MS = 2000, TIMEOUT_MS = 4000, HOST_OK = /^[\w.-]+(:\d+)?$/;
  const subs = new Set();
  const ls = { get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } } };
  let host = config.lanHost || 'irrigation.local';
  try { const q = new URLSearchParams(location.search).get('host'), s = ls.get('lanHost', ''); host = HOST_OK.test(q || '') ? q : HOST_OK.test(s) ? s : host; } catch (e) { /* ignore */ }
  const potNames = ls.get('potNames', {}), readings = [];
  let potLook = ls.get('potLook', {});
  let state = { device: { id: config.deviceId, fw: '', ip: host, rssi: 0, up: 0, lastSeen: 0, intervalS: 2 }, ...mapPayload({}), rules: null, potNames, potLook, mark: null, events: [] };

  async function http(path, opts) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try { return await fetch(`http://${host}${path}`, { ...opts, signal: ac.signal, cache: 'no-store' }); } finally { clearTimeout(t); }
  }
  function ingest(s, now) {
    const m = mapPayload(s), bootMs = s.time && Number.isFinite(s.time.ms) ? now - s.time.ms : null;
    // the board's event ring: each entry carries its time as epoch s (`t`) or as board millis (`ms`, with time.ms = millis now)
    const evTs = (e) => (e.t > 1e9 ? e.t * 1000 : bootMs !== null && Number.isFinite(e.ms) ? bootMs + e.ms : null);
    const events = Array.isArray(s.events) ? s.events.map(e => ({ ts: evTs(e), kind: e.kind || (e.type === 'refill' && e.note === 'set' ? 'level' : e.type),
      ch: Number.isInteger(e.ch) ? e.ch : e.pot > 0 ? e.pot - 1 : null, ml: e.ml, tankLeft: e.tankLeft ?? e.tank })).filter(e => e.ts) : state.events;
    const mk = events.filter(e => e.kind === 'refill' || e.kind === 'level').sort((a, b) => b.ts - a.ts)[0];
    if (!readings.length || now - readings[readings.length - 1].ts >= 60e3) readings.push({ ts: now, tankLeft: m.t.tankLeft });
    state = { device: { id: config.deviceId, fw: m.t.fw, ip: s.ip || (s.wifi && s.wifi.ip) || host, rssi: s.rssi || (s.wifi && s.wifi.rssi) || 0, up: m.t.up, lastSeen: now, intervalS: 2 },
      t: m.t, ch: m.ch, rules: [s.rules, s.plan].find(x => x && typeof x === 'object') || null, potNames, potLook, mark: mk ? { ts: mk.ts, tankLeft: mk.tankLeft } : state.mark, events,
      idle: !s.busy && !s.queued };   // busy/queued: the board's command queue (0.5.0 /api/state)
  }
  let misses = 0, asked = false;
  async function poll() {
    try { const r = await http('/api/state'); if (!r.ok) throw new Error(r.status); ingest(await r.json(), Date.now()); misses = 0; }
    catch (e) {
      if (++misses === 5 && !asked && typeof prompt === 'function') {
        asked = true; const ip = (prompt(`IP of the controller (${host} does not answer)`, '') || '').trim();
        if (HOST_OK.test(ip)) { host = ip; ls.set('lanHost', ip); misses = 0; }
      }
    }
    subs.forEach(fn => fn(state));
  }

  const n1 = (a) => (a.ch | 0) + 1;
  function line(cmd, a) {
    switch (cmd) {
      case 'valve': return `v ${n1(a)} ${a.open ? 'o' : 'c'}`;
      case 'valves_all': return `vall ${a.open ? 'o' : 'c'}`;
      case 'pump': return a.on ? `p ${a.sec || 90}` : 'pstop';
      case 'stop': return '!';
      case 'water': return `w ${n1(a)} ${Math.round(a.ml)}`;
      case 'run': return `rules run ${a.plan}`;
      case 'rules': return `rules ${JSON.stringify(a)}`;
      case 'cal': return `cal ${n1(a)} ${a.which}`;
      case 'soil': return `soil ${n1(a)} ${a.which}`;
      case 'cal_copy': return `calcopy ${n1(a)} ${a.kind}`;
      case 'servo': return `vpos ${a.all ? 'all' : n1(a)} ${a.openUs | 0} ${a.closedUs | 0}`;
      case 'pump_test': return `ptest ${n1(a)} ${a.sec || 10}`;
      case 'flow': return `flow ${a.mlPerSec}`;
      case 'tank': return a.full ? 'tank full' : `tank ${Math.round(a.ml)}`;
      case 'tanksize': return `tanksize ${Math.round(a.ml)}`;
      case 'en': return `en ${a.what} ${a.on ? 'on' : 'off'}`;
      case 'refresh': return 'r';
      default: return null;
    }
  }
  // When a command counts as done, read from the polled state (before = the state when it was sent). Returns the ack result or null.
  // sawIdle = a poll at least 1.5 s after sending showed the board's command queue empty (the line has run).
  function done(cmd, a, before, sawPump, sawIdle) {
    const c = state.ch[a.ch], b0 = before.ch[a.ch], idle = !state.t.pumpRunning && !state.t.running && !state.t.queue.length;
    switch (cmd) {
      case 'valve': return c.vState === (a.open ? 2 : 1) ? { ch: a.ch, vState: c.vState } : null;
      case 'valves_all': return state.ch.every(x => !x.valEn || x.vState === (a.open ? 2 : 1)) ? { n: state.ch.filter(x => x.valEn).length } : null;
      case 'water': return c.lastTs && c.lastTs !== b0.lastTs && idle ? { ch: a.ch, ml_pumped: c.lastML, ran_ms: Math.round(1000 * c.lastML / (state.t.mlPerSec || 1)) } : null;
      case 'pump': case 'pump_test': return sawPump && idle ? { ch: a.ch, ran_ms: (a.sec || 10) * 1000, estimated: true } : null;
      case 'run': return sawPump && idle ? {} : null;
      case 'cal': return c.air !== b0.air || c.water !== b0.water || sawIdle ? { ch: a.ch, air: c.air, water: c.water, sd: c.sd } : null;
      case 'soil': return c.soilDry !== b0.soilDry || c.soilWet !== b0.soilWet || sawIdle ? { ch: a.ch, soilDry: c.soilDry, soilWet: c.soilWet } : null;
      case 'rules': return state.t.rulesHash !== before.t.rulesHash || sawIdle ? { rulesHash: state.t.rulesHash } : null;
      default: return sawIdle ? {} : null;
    }
  }
  async function sendCommand(cmd, args) {
    args = args || {};
    const l = line(cmd, args); if (!l) return { status: 'failed', result: { ok: false, reason: 'unknown_cmd' } };
    const before = state;
    const r = await http('/api/cmd', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: l });
    let j = {}; try { j = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok || j.ok === false) return { status: 'failed', result: { ok: false, reason: j.reason || (r.status === 409 ? 'busy' : 'transport'), ...j } };
    if (j.result) return { status: j.result.ok === false ? 'failed' : 'acked', result: j.result };
    if (j.queued && j.id != null) {   // 0.5.0: pumping commands are queued; their ack is read from GET /api/result?id=n
      const t1 = Date.now();
      while (Date.now() - t1 < 20 * 60e3) {
        await new Promise(res => setTimeout(res, 800));
        let q = null; try { const rr = await http('/api/result?id=' + j.id); if (rr.status === 404) break; q = await rr.json(); } catch (e) { continue; }
        if (q && q.done) return { status: q.ok === false ? 'failed' : 'acked', result: { ok: q.ok !== false, ...(q.result || {}) } };
      }
    }
    const t0 = Date.now(), slow = ['water', 'pump', 'pump_test', 'run', 'valves_all'].includes(cmd); let sawPump = false, sawIdle = false;
    while (Date.now() - t0 < (slow ? 20 * 60e3 : 30e3)) {
      await new Promise(res => setTimeout(res, 600));
      if (state.device.lastSeen <= t0) continue;
      sawPump = sawPump || state.t.pumpRunning || !!state.t.running;
      sawIdle = sawIdle || (state.idle && state.device.lastSeen > t0 + 1500);
      const res = done(cmd, args, before, sawPump, sawIdle);
      if (res) return { status: 'acked', result: { ok: true, ...res } };
      if (cmd === 'water' && !sawPump && Date.now() - t0 > 8000) return { status: 'failed', result: { ok: false, reason: 'refused' } };   // no dose started: the console shows why
    }
    return { status: 'sent', result: null };
  }

  return {
    isMock: false, isLan: true,
    async init() { await poll(); setInterval(poll, POLL_MS); },
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    sendCommand,
    async setPotName(ch, name) { if (name) potNames[ch] = name; else delete potNames[ch]; ls.set('potNames', potNames); subs.forEach(fn => fn(state)); },
    async setPotLook(look) { potLook = look; state = { ...state, potLook }; ls.set('potLook', potLook); subs.forEach(fn => fn(state)); },
    async history(days, endOffsetDays) { return historyFromLocal(readings, state.events || [], days, Date.now(), endOffsetDays || 0); },
    async potHistory(ch, days) { const from = dayStart(Date.now(), -(days - 1)); return { moisture: [], doses: (state.events || []).filter(e => e.kind === 'dose' && e.ch === ch && e.ts >= from).map(e => ({ ts: e.ts, ml: e.ml })) }; },
    async login() { return { email: 'lan' }; },
    async logout() {},
    session() { return { email: 'lan' }; },
  };
}
