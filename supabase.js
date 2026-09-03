// supabase.js — the real backend (phase 1b). Same contract as mock.js (see backend.js for the
// method list and the State shape); app.js does not know which one it is talking to.
//
// Needs supabase-js as a plain script BEFORE this file (index.html):
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.114.0/dist/umd/supabase.min.js"></script>
// (defines window.supabase; cdnjs does not carry supabase-js, jsDelivr's UMD build is the pinned source.)
// Tables and endpoints: ../supabase/schema.sql, ../supabase/alerts.sql, ../supabase/functions/*, ../SPEC.md §5 + Part 2.
//
// How it stays live: one Realtime channel on device_state / device_config / alerts / commands / events
// (each change refetches just that table), plus a 20 s poll of the devices row (last_seen is bumped by
// the ESP's command polls, which touch no realtime table) — and if the channel is not subscribed, the
// poll refetches everything, so a blocked WebSocket only makes the app slower, never wrong.

const N_POTS = 16;

function createSupabaseBackend(config) {
  const subs = new Set();
  const id = config.deviceId;
  const raw = {};                         // last rows per table, as fetched
  const pending = new Map();              // command id → resolve (sendCommand waiting for the ack)
  let sb = null, sess = null, state = null, channel = null, live = false, refreshing = Promise.resolve();
  let stay = true;
  try { stay = sessionStorage.getItem('sb-stay') !== '0'; } catch (e) { /* private mode */ }

  // "Stay signed in" = session in localStorage; otherwise sessionStorage (gone when the tab closes).
  const storage = {
    getItem: (k) => { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch (e) { return null; } },
    setItem: (k, v) => { try { (stay ? localStorage : sessionStorage).setItem(k, v); } catch (e) { /* ignore */ } },
    removeItem: (k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  function client() {
    if (sb) return sb;
    if (!window.supabase) throw new Error('supabase-js did not load — check the <script> tag in index.html and the internet connection');
    if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error('Fill in supabaseUrl and supabaseAnonKey in backend.js (SETUP.md step 7)');
    sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey,
      { auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    sb.auth.onAuthStateChange((_ev, s) => { sess = s; });
    return sb;
  }

  // ---- row → State mappers (snake_case rows, camelCase state; timestamps as ms)
  const ms = (iso) => (iso ? Date.parse(iso) : null);
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const mapCommand = (r) => ({ id: r.id, cmd: r.cmd, args: r.args || {}, status: r.status, createdAt: ms(r.created_at), ackedAt: ms(r.acked_at), expiresAt: ms(r.expires_at), result: r.result });
  const mapAlert = (r) => ({ id: r.id, ts: ms(r.ts), key: r.key, kind: r.kind, severity: r.severity, ch: r.ch, message: r.message, active: r.active, ackedAt: ms(r.acked_at) });
  const mapEvent = (r) => ({ id: r.id, ts: ms(r.ts), kind: r.kind, ch: r.ch, ...(r.detail || {}) });

  // ---- one fetcher per table; each writes into raw[key]
  const fetchers = {
    devices: () => client().from('devices').select('id,name,fw,ip,rssi,last_seen,interval_s').eq('id', id).maybeSingle(),
    state: () => client().from('device_state').select('ts,payload').eq('device_id', id).maybeSingle(),
    config: () => client().from('device_config').select('ts,payload').eq('device_id', id).maybeSingle(),
    alerts: () => client().from('alerts').select('*').eq('device_id', id).order('ts', { ascending: false }).limit(50),
    commands: () => client().from('commands').select('*').eq('device_id', id).order('created_at', { ascending: false }).limit(40),
    events: () => client().from('events').select('*').eq('device_id', id).gte('ts', new Date(Date.now() - 15 * 86400e3).toISOString()).order('ts', { ascending: false }).limit(1000),
    readings: () => client().from('readings').select('ts,tank_ml,temp_c').eq('device_id', id).gte('ts', new Date(Date.now() - 3 * 86400e3).toISOString()).order('ts', { ascending: true }).limit(1000),
    household: () => client().from('household').select('*').eq('id', 1).maybeSingle(),
  };
  const ALL = Object.keys(fetchers);

  // Refetch the given tables (serialised), rebuild the State, tell the UI.
  function refresh(keys) {
    refreshing = refreshing.then(async () => {
      const results = await Promise.all(keys.map(k => fetchers[k]()));
      results.forEach((r, n) => { if (r.error) throw new Error(`${keys[n]}: ${r.error.message}`); raw[keys[n]] = r.data; });
      build(); emit();
    });
    return refreshing;
  }

  function build() {
    const d = raw.devices || {}, sp = (raw.state && raw.state.payload) || {}, cp = (raw.config && raw.config.payload) || {};
    const stTs = raw.state ? ms(raw.state.ts) : null;
    const events = (raw.events || []).map(mapEvent);
    const autoMin = num(sp.autoMin, 0);
    // The protocol's telemetry has no next-round field; the firmware may add `nextRoundS` (seconds until the
    // next auto round). Without it: last auto round + interval.
    let nextRoundAt = null;
    if (autoMin > 0) {
      if (Number.isFinite(sp.nextRoundS)) nextRoundAt = (stTs || Date.now()) + sp.nextRoundS * 1000;
      else { const last = events.find(e => e.kind === 'round' && e.trigger === 'auto'); nextRoundAt = (last ? last.ts : (stTs || Date.now())) + autoMin * 60e3; }
    }
    const sch = new Map((Array.isArray(sp.ch) ? sp.ch : []).map(c => [c.i, c]));
    const cch = new Map((Array.isArray(cp.ch) ? cp.ch : []).map(c => [c.i, c]));
    const pots = [];
    for (let i = 0; i < N_POTS; i++) {
      const s = sch.get(i) || {}, c = cch.get(i) || {};
      pots.push({ i, raw: num(s.raw, 0), pct: num(s.pct, -1), sState: num(s.sState, 0), vState: num(s.vState, 0), todayML: num(s.todayML, 0),
        air: num(c.air, -1), water: num(c.water, -1), thrPct: num(c.thrPct, 35), doseML: num(c.doseML, 250), senEn: c.senEn !== false, valEn: c.valEn !== false });
    }
    const lr = events.find(e => e.kind === 'round') || null;
    const hh = raw.household || {};
    state = {
      device: { id, name: d.name || 'Balcony', fw: d.fw || sp.fw || '—', ip: d.ip || sp.ip || '', rssi: num(d.rssi, num(sp.rssi, 0)), up: num(sp.up, 0),
        lastSeen: ms(d.last_seen), intervalS: num(d.interval_s, 300), havePCA: sp.havePCA !== false },
      telemetry: { ts: stTs, tempC: num(sp.tempC, 0), tempOK: sp.tempOK === true, tankLeft: num(sp.tankLeft, 0), totalML: num(sp.totalML, 0),
        pumpRunning: sp.pumpRunning === true, pumpEn: sp.pumpEn !== false, tempEn: sp.tempEn !== false, ledEn: sp.ledEn !== false, autoMin, nextRoundAt,
        nSensors: num(sp.nSensors, num(cp.nSensors, 0)), nServos: num(sp.nServos, num(cp.nServos, 0)), mlPerSec: num(sp.mlPerSec, num(cp.mlPerSec, 30)) },
      config: { openUs: num(cp.openUs, 2500), closedUs: num(cp.closedUs, 1300), tankFull: num(cp.tankFull, 25000), tankReserve: num(cp.tankReserve, 500),
        minTempC: num(cp.minTempC, 3), plausMargin: num(cp.plausMargin, 250), maxPumpMs: num(cp.maxPumpMs, 90000) },
      pots,
      household: { potNames: hh.pot_names || {}, ntfyTopic: hh.ntfy_topic || '' },
      lastRound: lr ? { ts: lr.ts, watered: num(lr.watered, 0), skipped: num(lr.skipped, 0), refused: num(lr.refused, 0), tankLeft: num(lr.tankLeft, 0), tempC: num(lr.tempC, 0), trigger: lr.trigger || 'auto' } : null,
      alerts: (raw.alerts || []).map(mapAlert),
      commands: (raw.commands || []).map(mapCommand),
      events,
      readings: (raw.readings || []).map(r => ({ ts: ms(r.ts), tankLeft: num(r.tank_ml, 0), tempC: num(r.temp_c, 0) })),
    };
    try { localStorage.setItem('irrigation-state', JSON.stringify(state)); } catch (e) { /* quota / private mode */ }
  }
  function emit() { subs.forEach(fn => fn(state)); }

  // A command is finished when its row reaches acked / failed / expired (set by /ack or pg_cron).
  function settle(row) {
    if (!row || !['acked', 'failed', 'expired'].includes(row.status)) return;
    const resolve = pending.get(row.id);
    if (resolve) { pending.delete(row.id); resolve(mapCommand(row)); }
  }

  function startLive() {
    if (channel) return;
    const c = client(), filter = `device_id=eq.${id}`;
    channel = c.channel('irrigation-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'device_state', filter }, () => refresh(['devices', 'state', 'readings']))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'device_config', filter }, () => refresh(['config']))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts', filter }, () => refresh(['alerts']))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commands', filter }, (p) => { settle(p.new); refresh(['commands']); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter }, () => refresh(['events', 'devices']))
      .subscribe((status) => { live = status === 'SUBSCRIBED'; });
    setInterval(() => { refresh(live ? ['devices'] : ALL).catch(() => {}); }, 20000);   // polling fallback + liveness
  }

  return {
    isMock: false,

    // First call: create the client and look for a saved session. If there is none, return —
    // app.js shows the login screen and calls init() again after login, which then loads everything.
    async init() {
      try { client(); } catch (e) { return; }                 // no keys / no library: session() stays null, login() explains
      if (!sess) { const { data } = await sb.auth.getSession(); sess = data.session; }
      if (!sess || state) return;
      try { await refresh(ALL); }
      catch (e) {                                              // backend paused or unreachable: last known state from this phone
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem('irrigation-state')); } catch (e2) { /* none */ }
        if (!cached) throw e;
        state = cached; state.backendDown = true;
      }
      startLive();
    },
    getState() { return state; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    async sendCommand(cmd, args) {
      const c = client();
      const { data, error } = await c.from('commands').insert({ device_id: id, cmd, args: args || {} }).select().single();
      if (error) throw new Error(error.message);
      refresh(['commands']).catch(() => {});
      return new Promise((resolve) => {
        pending.set(data.id, resolve);
        const tick = async () => {                            // belt and braces next to the realtime UPDATE
          if (!pending.has(data.id)) return;
          const { data: row } = await c.from('commands').select('*').eq('id', data.id).maybeSingle();
          settle(row);
          if (pending.has(data.id)) setTimeout(tick, 3000);
        };
        setTimeout(tick, 3000);
      });
    },

    async ackAlert(idOrAll) {
      let q = client().from('alerts').update({ acked_at: new Date().toISOString() }).eq('device_id', id).is('acked_at', null);
      if (idOrAll !== 'all') q = q.eq('id', idOrAll);
      const { error } = await q;
      if (error) throw new Error(error.message);
      await refresh(['alerts']);
    },

    async setHousehold(patch) {
      const row = {};
      if (patch.potNames !== undefined) row.pot_names = patch.potNames;
      if (patch.ntfyTopic !== undefined) row.ntfy_topic = patch.ntfyTopic;
      const { error } = await client().from('household').update(row).eq('id', 1);
      if (error) throw new Error(error.message);
      await refresh(['household']);
    },

    async login(email, password, staySignedIn) {
      stay = staySignedIn !== false;
      try { sessionStorage.setItem('sb-stay', stay ? '1' : '0'); } catch (e) { /* ignore */ }
      const { data, error } = await client().auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      sess = data.session;
      return { email: data.user.email };
    },
    async logout() { if (sb) await sb.auth.signOut(); sess = null; },
    session() { return sess ? { email: sess.user.email } : null; },
  };
}
