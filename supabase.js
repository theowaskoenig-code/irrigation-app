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
  let sb = null, sess = null, state = null, channel = null, live = false, lastMsgAt = 0, refreshing = Promise.resolve();
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
  const mapEvent = (r) => ({ ...(r.detail || {}), id: r.id, ts: ms(r.ts), kind: r.kind, ch: r.ch });   // the row's own columns win over anything the device put in detail (review S5)

  // ---- one fetcher per table; each writes into raw[key]
  const fetchers = {
    devices: () => client().from('devices').select('id,name,fw,ip,rssi,last_seen,interval_s').eq('id', id).maybeSingle(),
    state: () => client().from('device_state').select('ts,payload').eq('device_id', id).maybeSingle(),
    config: () => client().from('device_config').select('ts,payload').eq('device_id', id).maybeSingle(),
    alerts: () => client().from('alerts').select('*').eq('device_id', id).order('ts', { ascending: false }).limit(50),
    commands: () => client().from('commands').select('*').eq('device_id', id).order('created_at', { ascending: false }).limit(40),
    // events and readings are fetched incrementally: only rows since the newest one already held (review R2); the first fetch keeps the 1000 cap
    events: async () => {
      const have = raw.events || [], since = have.length ? have[0].ts : new Date(Date.now() - 15 * 86400e3).toISOString();
      const r = await client().from('events').select('*').eq('device_id', id).gte('ts', since).order('ts', { ascending: false }).limit(1000);
      if (r.error) return r;
      const seen = new Set(r.data.map(e => e.id));
      return { data: r.data.concat(have.filter(e => !seen.has(e.id))).slice(0, 1000) };
    },
    readings: async () => {
      const have = raw.readings || [], since = have.length ? have[have.length - 1].ts : new Date(Date.now() - 3 * 86400e3).toISOString();
      const r = await client().from('readings').select('ts,tank_ml,temp_c').eq('device_id', id).gte('ts', since).order('ts', { ascending: true }).limit(1000);
      if (r.error) return r;
      const seen = new Set(r.data.map(x => x.ts)), cutoff = new Date(Date.now() - 3 * 86400e3).toISOString();
      return { data: have.filter(x => !seen.has(x.ts) && x.ts >= cutoff).concat(r.data).slice(-1000) };
    },
    household: () => client().from('household').select('*').eq('id', 1).maybeSingle(),
  };
  const ALL = Object.keys(fetchers);

  // Refetch the given tables (serialised), rebuild the State, tell the UI.
  function refresh(keys) {
    refreshing = refreshing.catch(() => {}).then(async () => {                    // one failed refresh must not block every later one (review B1)
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
    if (num(sp.planNext, 0) > 0) nextRoundAt = sp.planNext * 1000;                       // the watering plan's next round (epoch s, firmware 0.4.0)
    else if (autoMin > 0) {
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
      // fw / ip / rssi / up: the latest device_state payload first (it arrives with every telemetry post and is in the realtime
      // publication), the devices row only as the fallback — otherwise a firmware update showed the old version until a full reload.
      device: { id, name: d.name || 'Balcony', fw: sp.fw || cp.fw || d.fw || '—', ip: sp.ip || d.ip || '', rssi: num(sp.rssi, num(d.rssi, 0)), up: num(sp.up, 0),
        lastSeen: ms(d.last_seen), intervalS: num(d.interval_s, 300), havePCA: sp.havePCA !== false },
      telemetry: { ts: stTs, tempC: num(sp.tempC, 0), tempOK: sp.tempOK === true, tankLeft: num(sp.tankLeft, 0), totalML: num(sp.totalML, 0),
        pumpRunning: sp.pumpRunning === true, pumpEn: sp.pumpEn !== false, tempEn: sp.tempEn !== false, ledEn: sp.ledEn !== false, autoMin, nextRoundAt,
        nSensors: num(sp.nSensors, num(cp.nSensors, 0)), nServos: num(sp.nServos, num(cp.nServos, 0)), mlPerSec: num(sp.mlPerSec, num(cp.mlPerSec, 30)),
        rulesHash: typeof sp.rulesHash === 'string' ? sp.rulesHash : undefined, planNext: num(sp.planNext, 0) },   // rulesHash undefined = firmware before the watering plan (app/RULES.md §2)
      config: { openUs: num(cp.openUs, 2500), closedUs: num(cp.closedUs, 1300), tankFull: num(cp.tankFull, 25000), tankReserve: num(cp.tankReserve, 500),
        minTempC: num(cp.minTempC, 3), plausMargin: num(cp.plausMargin, 250), maxPumpMs: num(cp.maxPumpMs, 90000) },
      pots,
      household: { potNames: hh.pot_names || {}, ntfyTopic: hh.ntfy_topic || '',
        weatherLoc: hh.weather && Number.isFinite(hh.weather.lat) && Number.isFinite(hh.weather.lon) ? { lat: hh.weather.lat, lon: hh.weather.lon, label: hh.weather.label || '' } : null },
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'device_state', filter }, () => { lastMsgAt = Date.now(); refresh(['devices', 'state', 'readings']).catch(() => {}); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'device_config', filter }, () => { lastMsgAt = Date.now(); refresh(['config']).catch(() => {}); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts', filter }, () => { lastMsgAt = Date.now(); refresh(['alerts']).catch(() => {}); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commands', filter }, (p) => { lastMsgAt = Date.now(); settle(p.new); refresh(['commands']).catch(() => {}); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter }, () => { lastMsgAt = Date.now(); refresh(['events', 'devices']).catch(() => {}); })
      .subscribe((status) => { live = status === 'SUBSCRIBED'; if (live) lastMsgAt = Date.now(); });   // CHANNEL_ERROR / CLOSED / TIMED_OUT → not live
    // Polling fallback + liveness (review R1): the channel counts as live only while it delivered something in the last 2 minutes;
    // otherwise every poll refetches everything (cheap: events/readings are incremental). A failed poll marks the cloud down.
    setInterval(async () => {
      const isLive = live && Date.now() - lastMsgAt < 120e3;
      try { await refresh(isLive ? ['devices'] : ALL); }
      catch (e) { if (state && !state.backendDown) { state.backendDown = true; emit(); } }
    }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(ALL).catch(() => {}); });   // back from the background: full refresh
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
      const { data, error } = await c.from('commands').insert({ device_id: id, cmd, args: args || {} }).select().single();   // args is jsonb: Postgres reorders its keys, so the board's rulesHash (in the ack result) is the one to compare against
      if (error) throw new Error(error.message);
      refresh(['commands']).catch(() => {});
      return new Promise((resolve) => {
        pending.set(data.id, resolve);
        const t0 = Date.now();
        const tick = async () => {                            // belt and braces next to the realtime UPDATE; a failed poll is retried, never dropped (review A4)
          if (!pending.has(data.id)) return;
          let row = null;
          try { row = (await c.from('commands').select('*').eq('id', data.id).maybeSingle()).data; settle(row); } catch (e) { /* offline for a moment */ }
          if (!pending.has(data.id)) return;
          if (Date.now() - t0 > 40 * 60e3) { pending.delete(data.id); resolve(mapCommand(row || data)); return; }   // give up waiting after 40 min (a never-expiring `stop` included, review R3); the row keeps its state
          setTimeout(tick, 3000);
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
      if (patch.weatherLoc !== undefined) {                    // merge: weather.sql keeps its own keys (req, last) in the same column
        const w = { ...((raw.household && raw.household.weather) || {}) };
        delete w.lat; delete w.lon; delete w.label;
        row.weather = patch.weatherLoc ? { ...w, lat: patch.weatherLoc.lat, lon: patch.weatherLoc.lon, label: patch.weatherLoc.label || '' } : w;
      }
      const { error } = await client().from('household').update(row).eq('id', 1);
      if (error) throw new Error(error.message);
      await refresh(['household']);
    },

    // History charts: GROUP BY helpers from ../supabase/history.sql (rpc). Until Theo has run that file the rpc
    // fails, and the last 3 days held in state.readings/events are bucketed here instead, flagged `partial`.
    async history(days, endOffsetDays) {
      const c = client(), tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Europe/Berlin', off = endOffsetDays || 0;
      const DAY = 86400e3, from = dayStart(Date.now(), -(off + days - 1)), to = dayStart(from, days);   // local midnights (DST-safe, review B8)
      const pEnd = new Date(to - 1).toISOString();                                             // the window's last day, local (history.sql p_end)
      const [rd, ds, rf] = await Promise.all([
        c.rpc('history_readings', { p_dev: id, p_days: days, p_end: pEnd, p_tz: tz }),
        c.rpc('history_doses', { p_dev: id, p_days: days, p_tz: tz, p_end: pEnd }),
        c.from('events').select('ts').eq('device_id', id).eq('kind', 'refill').gte('ts', new Date(from).toISOString()).lt('ts', new Date(to).toISOString()).order('ts', { ascending: true }).limit(200),
      ]);
      if (rd.error || ds.error) {
        const h = historyFromLocal(state.readings, state.events, days, Date.now(), off);
        h.partial = true; h.note = `Only the last 3 days — run app/supabase/history.sql once more (SETUP.md step 11; it gained the pan window and the time zone). (${(rd.error || ds.error).message})`;
        return h;
      }
      const perDay = []; for (let i = 0; i < days; i++) perDay.push({ day: dayStart(from, i), ml: 0, n: 0 });
      (ds.data || []).forEach(r => { const [y, m, d] = r.day.split('-').map(Number); const t = new Date(y, m - 1, d).getTime(); const i = Math.round((t - from) / DAY); if (i >= 0 && i < days) { perDay[i].ml = num(r.ml, 0); perDay[i].n = num(r.n, 0); } });
      const rows = rd.data || [];
      return { days, from, tank: rows.filter(r => r.tank_ml !== null).map(r => ({ ts: ms(r.ts), ml: r.tank_ml })), temp: rows.filter(r => r.temp_c !== null).map(r => ({ ts: ms(r.ts), c: r.temp_c })),
        perDay, refills: (rf.data || []).map(r => ms(r.ts)) };
    },
    async potHistory(ch, days) {
      const c = client();
      const [mo, ev] = await Promise.all([
        c.rpc('history_pot', { p_dev: id, p_ch: ch, p_days: days }),
        c.from('events').select('ts,detail').eq('device_id', id).eq('kind', 'dose').eq('ch', ch).gte('ts', new Date(Date.now() - days * 86400e3).toISOString()).order('ts', { ascending: true }).limit(500),
      ]);
      const doses = (ev.data || []).map(r => ({ ts: ms(r.ts), ml: num(r.detail && r.detail.ml, 0) }));
      if (mo.error) return { days, moisture: [], doses, note: `Moisture history needs app/supabase/history.sql (SETUP.md step 11). (${mo.error.message})` };
      return { days, moisture: (mo.data || []).map(r => ({ ts: ms(r.ts), pct: r.pct })), doses };
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
