// supabase.js — the cloud backend. Same methods as mock.js / lan.js (list in backend.js).
// Needs supabase-js as a plain script before this file (index.html, jsDelivr UMD build).
// Tables: ../supabase/schema.sql · history rpc: ../supabase/history.sql · edge functions: ../supabase/functions/*.
// device_state.payload = the board's telemetry (mapPayload) · device_config.payload.rules = the plan document the board holds.
// Live: one Realtime channel (each change refetches that table) + a 20 s poll; without a working channel the poll refetches everything.

function createSupabaseBackend(config) {
  const subs = new Set(), id = config.deviceId, raw = {}, pending = new Map();
  let sb = null, sess = null, state = null, live = false, lastMsgAt = 0, chain = Promise.resolve(), started = false;
  let stay = true; try { stay = sessionStorage.getItem('sb-stay') !== '0'; } catch (e) { /* private mode */ }
  const storage = {   // "Stay signed in" = localStorage, otherwise sessionStorage
    getItem: (k) => { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch (e) { return null; } },
    setItem: (k, v) => { try { (stay ? localStorage : sessionStorage).setItem(k, v); } catch (e) { /* ignore */ } },
    removeItem: (k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  function client() {
    if (sb) return sb;
    if (!window.supabase) throw new Error('supabase-js did not load');
    if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error('no cloud keys in backend.js');
    sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    sb.auth.onAuthStateChange((_e, s) => { sess = s; });
    return sb;
  }
  const ms = (iso) => (iso ? Date.parse(iso) : null);
  const mapCommand = (r) => ({ id: r.id, cmd: r.cmd, status: r.status, result: r.result });

  const fetchers = {
    devices: () => client().from('devices').select('fw,ip,rssi,last_seen,interval_s').eq('id', id).maybeSingle(),
    state: () => client().from('device_state').select('ts,payload').eq('device_id', id).maybeSingle(),
    config: () => client().from('device_config').select('ts,payload').eq('device_id', id).maybeSingle(),
    mark: () => client().from('events').select('ts,detail').eq('device_id', id).in('kind', ['refill', 'level']).order('ts', { ascending: false }).limit(1).maybeSingle(),
    household: () => client().from('household').select('pot_names,pot_look,weather').eq('id', 1).maybeSingle(),
  };
  const ALL = Object.keys(fetchers);
  function refresh(keys) {
    chain = chain.catch(() => {}).then(async () => {
      const res = await Promise.all(keys.map(k => fetchers[k]()));
      res.forEach((r, i) => { if (r.error) throw new Error(`${keys[i]}: ${r.error.message}`); raw[keys[i]] = r.data; });
      build(); subs.forEach(fn => fn(state));
    });
    return chain;
  }
  function build() {
    const d = raw.devices || {}, sp = (raw.state && raw.state.payload) || {}, cp = (raw.config && raw.config.payload) || {}, mk = raw.mark, hh = raw.household || {};
    const m = mapPayload(sp);
    state = {
      device: { id, fw: m.t.fw || d.fw || '', ip: sp.ip || d.ip || '', rssi: sp.rssi || d.rssi || 0, up: m.t.up, lastSeen: ms(d.last_seen), intervalS: d.interval_s || 300 },
      t: m.t, ch: m.ch, rules: cp.rules && typeof cp.rules === 'object' ? cp.rules : null,
      potNames: hh.pot_names || {}, potLook: hh.pot_look || {}, weatherLoc: hh.weather && Number.isFinite(hh.weather.lat) ? hh.weather : null,
      mark: mk ? { ts: ms(mk.ts), tankLeft: mk.detail && mk.detail.tankLeft } : null,
    };
    try { localStorage.setItem('irrigation-state', JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function settle(row) {
    if (!row || !['acked', 'failed', 'expired'].includes(row.status)) return;
    const res = pending.get(row.id); if (res) { pending.delete(row.id); res(mapCommand(row)); }
  }
  function startLive() {
    if (started) return; started = true;
    const filter = `device_id=eq.${id}`, on = (table, keys, fn) => (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table, filter }, (p) => { lastMsgAt = Date.now(); if (fn) fn(p); refresh(keys).catch(() => {}); });
    let ch = client().channel('irrigation-live');
    ch = on('device_state', ['devices', 'state'])(ch);
    ch = on('device_config', ['config'])(ch);
    ch = on('events', ['mark', 'devices'])(ch);
    ch = on('commands', [], (p) => settle(p.new))(ch);
    ch.subscribe((s) => { live = s === 'SUBSCRIBED'; if (live) lastMsgAt = Date.now(); });
    setInterval(async () => {
      try { await refresh(live && Date.now() - lastMsgAt < 120e3 ? ['devices'] : ALL); if (state.backendDown) { state.backendDown = false; subs.forEach(fn => fn(state)); } }
      catch (e) { if (state && !state.backendDown) { state.backendDown = true; subs.forEach(fn => fn(state)); } }
    }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(ALL).catch(() => {}); });
  }

  return {
    isMock: false,
    async init() {
      try { client(); } catch (e) { return; }
      if (!sess) sess = (await sb.auth.getSession()).data.session;
      if (!sess || state) return;
      try { await refresh(ALL); }
      catch (e) { let c = null; try { c = JSON.parse(localStorage.getItem('irrigation-state')); } catch (e2) { /* none */ } if (!c) throw e; state = c; state.backendDown = true; }
      startLive();
    },
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async sendCommand(cmd, args) {
      const c = client();
      const { data, error } = await c.from('commands').insert({ device_id: id, cmd, args: args || {} }).select().single();
      if (error) throw new Error(error.message);
      return new Promise((resolve) => {
        pending.set(data.id, resolve);
        const t0 = Date.now();
        const tick = async () => {           // belt and braces next to the realtime UPDATE
          if (!pending.has(data.id)) return;
          let row = null; try { row = (await c.from('commands').select('*').eq('id', data.id).maybeSingle()).data; settle(row); } catch (e) { /* retry */ }
          if (!pending.has(data.id)) return;
          if (Date.now() - t0 > 40 * 60e3) { pending.delete(data.id); resolve(mapCommand(row || data)); return; }
          setTimeout(tick, 3000);
        };
        setTimeout(tick, 3000);
      });
    },
    async setPotName(ch, name) {
      const names = { ...(state.potNames || {}) }; if (name) names[ch] = name; else delete names[ch];
      const { error } = await client().from('household').update({ pot_names: names }).eq('id', 1);
      if (error) throw new Error(error.message);
      await refresh(['household']);
    },
    async setPotLook(look) {
      const { error } = await client().from('household').update({ pot_look: look }).eq('id', 1);
      if (error) throw new Error(error.message);
      await refresh(['household']);
    },
    // perDay from history_doses, tank from history_readings, refills / level sets from the events table
    async history(days, endOffsetDays) {
      const c = client(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin', off = endOffsetDays || 0;
      const from = dayStart(Date.now(), -(off + days - 1)), to = dayStart(from, days), pEnd = new Date(to - 1).toISOString();
      const [rd, ds, ev] = await Promise.all([
        c.rpc('history_readings', { p_dev: id, p_days: days, p_end: pEnd, p_tz: tz }),
        c.rpc('history_doses', { p_dev: id, p_days: days, p_tz: tz, p_end: pEnd }),
        c.from('events').select('ts,kind').eq('device_id', id).in('kind', ['refill', 'level']).gte('ts', new Date(from).toISOString()).lt('ts', new Date(to).toISOString()).order('ts').limit(200),
      ]);
      if (rd.error || ds.error) throw new Error((rd.error || ds.error).message);
      const perDay = []; for (let i = 0; i < days; i++) perDay.push({ day: dayStart(from, i), ml: 0, n: 0 });
      (ds.data || []).forEach(r => { const [y, m, d] = r.day.split('-').map(Number), i = perDay.findIndex(p => p.day === new Date(y, m - 1, d).getTime()); if (i >= 0) { perDay[i].ml = r.ml || 0; perDay[i].n = r.n || 0; } });
      const evs = ev.data || [];
      return { days, from, perDay, tank: (rd.data || []).filter(r => r.tank_ml !== null).map(r => ({ ts: ms(r.ts), ml: r.tank_ml })),
        refills: evs.filter(e => e.kind === 'refill').map(e => ms(e.ts)), levels: evs.filter(e => e.kind === 'level').map(e => ms(e.ts)) };
    },
    async potHistory(ch, days) {
      const c = client();
      const [mo, ev] = await Promise.all([
        c.rpc('history_pot', { p_dev: id, p_ch: ch, p_days: days }),
        c.from('events').select('ts,detail').eq('device_id', id).eq('kind', 'dose').eq('ch', ch).gte('ts', new Date(dayStart(Date.now(), -(days - 1))).toISOString()).order('ts').limit(500),
      ]);
      return { moisture: mo.error ? [] : (mo.data || []).map(r => ({ ts: ms(r.ts), pct: r.pct })), doses: (ev.data || []).map(r => ({ ts: ms(r.ts), ml: (r.detail && r.detail.ml) || 0 })) };
    },
    async login(email, password, staySignedIn) {
      stay = staySignedIn !== false; try { sessionStorage.setItem('sb-stay', stay ? '1' : '0'); } catch (e) { /* ignore */ }
      const { data, error } = await client().auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      sess = data.session; return { email: data.user.email };
    },
    async logout() { if (sb) await sb.auth.signOut(); sess = null; },
    session() { return sess ? { email: sess.user.email } : null; },
  };
}
