// rules-ui.js — the "Watering plan" screen (app/RULES.md §5): four settings that shape the watering cycles, nothing else
// (Theo, 2026-09-03: "start real simple … 2–4 basic settings, and we'll add as we go"; "we are programming this to never
// need AI again" — settings only, no text language, the JSON is internal).
//   1. When            — times as chips (max 4) or "every N hours"
//   2. How dry         — one slider: the threshold every pot follows (per-pot exceptions live in the pot sheet)
//   3. How much        — small 250 mL / large 900 mL, the dose every pot follows (exceptions in the pot sheet)
//   4. Daily cap       — litres per day for the whole balcony
// plus one read-only preview line and "Apply on the controller" with a status chip.
// The draft is a `rules v1` object (rules.js) and travels as the `rules` command. Modifiers (rain / hot day / tank) and
// per-pot max doses stay in the schema and the simulator for later; the UI has no control for them.
// Uses app.js globals ($, esc, state, backend, cmd, render, potName, chip, toast, when) and Rules from rules.js.

const RU = { rules: Rules.empty(), def: null, loaded: false };
const RU_TIMES = ['07:00', '19:00'];
const RU_CAP_DEFAULT_ML = 6000;

// ---------------------------------------------------------------- draft state (localStorage; an old draft is reduced to the four settings)
function ruLoad() {
  if (RU.loaded) return; RU.loaded = true;
  let draft = null, def = null;
  try {
    const j = localStorage.getItem('planDraft'), t = localStorage.getItem('rulesDraft');
    if (j) { const r = Rules.fromJSON(j); if (r.ok) draft = r.rules; }
    else if (t) { const r = Rules.parse(t); if (r.ok) draft = r.rules; }
    def = JSON.parse(localStorage.getItem('planDefaults') || 'null');
  } catch (e) { /* file:// or private mode */ }
  const r = Rules.empty();
  if (draft && draft.schedule[0]) { const s = draft.schedule[0]; r.schedule.push(s.everyMin ? { everyMin: s.everyMin, pots: 'dry' } : { days: 'all', at: s.at.slice(0, 4), pots: 'dry' }); }
  else if (!draft) r.schedule.push({ days: 'all', at: RU_TIMES.slice(), pots: 'dry' });
  r.limits.dailyML = draft ? draft.limits.dailyML : RU_CAP_DEFAULT_ML;
  if (draft) Object.keys(draft.pots).forEach(k => { const o = draft.pots[k], t = {}; if (o.thr !== undefined) t.thr = o.thr; if (o.dose !== undefined) t.dose = o.dose; if (Object.keys(t).length) r.pots[k] = t; });
  RU.rules = Rules.normalize(r);
  RU.def = def && Number.isInteger(def.thr) && Number.isInteger(def.dose) ? def : { thr: ruMode(ruFitted().map(p => p.thrPct), 35), dose: ruMode(ruFitted().map(p => p.doseML), 250) };
}
function ruMode(list, d) { const c = {}; let best = d, n = 0; list.forEach(v => { c[v] = (c[v] || 0) + 1; if (c[v] > n) { n = c[v]; best = v; } }); return best; }
function ruSave() { try { localStorage.setItem('planDraft', ruJson()); localStorage.setItem('planDefaults', JSON.stringify(RU.def)); } catch (e) { /* ignore */ } }
function ruCommit() { RU.rules = Rules.normalize(RU.rules); ruSave(); render(); }
function ruJson() { return Rules.compile(RU.rules); }
function ruStatus() {
  const h = state.telemetry.rulesHash;
  if (h === undefined) return { cls: 'uncal', label: 'controller cannot take a plan yet' };     // firmware before 0.3.0
  if (!h) return { cls: 'off', label: 'controller has no plan' };
  if (h === Rules.hash(ruJson())) return { cls: 'info', label: 'controller uses this plan' };
  return { cls: 'warn', label: 'changes not applied yet' };
}
function ruSched() { return RU.rules.schedule[0] || null; }
function ruFitted() { const t = state.telemetry; return state.pots.filter(p => p.i < Math.max(t.nSensors, t.nServos)); }
// What a pot will use: the plan's value if the plan carries one for it, else what the controller holds today.
function ruEff(p) { const o = RU.rules.pots[p.i] || {}; return { thr: o.thr !== undefined ? o.thr : p.thrPct, dose: o.dose !== undefined ? o.dose : p.doseML }; }
// A pot "follows" the plan while its value equals the plan default; a pot set differently in the pot sheet keeps its own value.
function ruSetDefault(field, v) {
  const old = RU.def[field]; if (v === old) return;
  ruFitted().forEach(p => { if (ruEff(p)[field] === old) RU.rules.pots[p.i] = Object.assign(RU.rules.pots[p.i] || {}, { [field]: v }); });
  RU.def[field] = v; ruCommit();
}
function ruExceptions() { return ruFitted().filter(p => { const e = ruEff(p); return e.thr !== RU.def.thr || e.dose !== RU.def.dose; }); }
function ruTimesText(s) { return s.at.length > 1 ? s.at.slice(0, -1).join(', ') + ' and ' + s.at[s.at.length - 1] : s.at[0]; }
function ruWhenText() {
  const s = ruSched();
  if (!s) return state.telemetry.autoMin ? 'no fixed times — the auto interval runs the rounds' : 'no fixed times — nothing runs on its own';
  return s.everyMin ? `a round every ${s.everyMin / 60} h` : `every day at ${ruTimesText(s)}`;
}
function ruNextT() {
  const now = Date.now(), last = state.lastRound ? state.lastRound.ts : null;
  if (ruSched()) { const t = Rules.triggersBetween(RU.rules, now, now + 8 * 86400e3, last); return t.length ? t[0].t : null; }
  return state.telemetry.autoMin ? (last || now) + state.telemetry.autoMin * 60e3 : null;
}
// The one preview line: "Next: Tue 19:00 — pots drier than 35 % get their dose (250 mL); today so far 1.2 L of 6 L."
function ruPreviewText() {
  const n = ruNextT(), ex = ruExceptions().length, today = state.pots.reduce((s, p) => s + p.todayML, 0);
  const what = `pots drier than ${RU.def.thr} % get their dose (${RU.def.dose} mL${ex ? `; ${ex} pot${ex > 1 ? 's' : ''} keep${ex > 1 ? '' : 's'} own values` : ''})`;
  return `${n ? `Next: ${when(n)} — ${what}` : `No round planned — ${what} when you run a round`}; today so far ${(today / 1000).toFixed(1)} L of ${RU.rules.limits.dailyML / 1000} L.`;
}

// ---------------------------------------------------------------- the card on Control
function rulesCard() {
  ruLoad();
  const st = ruStatus();
  return `<div class="card section">
    <div class="row top"><div class="stack"><strong>Watering plan</strong><span class="faint" style="font-size:14px">${esc(ruWhenText())} · drier than ${RU.def.thr} % · ${RU.def.dose} mL · at most ${RU.rules.limits.dailyML / 1000} L/day</span></div>${chip(st.cls, st.label)}</div>
    <button class="btn block" data-action="go" data-arg="rules">Edit the watering plan</button>
  </div>`;
}

// ---------------------------------------------------------------- the screen
function ruChip(active, ru, v, label, extra) { return `<button class="ru-chip ${active ? 'active' : ''}" aria-pressed="${active}" data-ru="${ru}" data-v="${esc(v)}" ${extra || ''}>${label}</button>`; }
function renderRules() {
  ruLoad();
  const st = ruStatus(), s = ruSched(), r = RU.rules, ex = ruExceptions();
  const times = s && !s.everyMin ? [...new Set([...RU_TIMES, ...s.at])].sort() : RU_TIMES;
  const whenBody = s && s.everyMin
    ? `<div class="ru-line">a round every <select data-ru="sched-interval">${[1, 2, 3, 4, 6, 8, 12, 24, 48].map(h => `<option value="${h}" ${s.everyMin === h * 60 ? 'selected' : ''}>${h} h</option>`).join('')}</select> <span class="faint">counted from the last round</span></div>
       <div class="ru-chips">${ruChip(false, 'sched-mode', 'fixed', 'Fixed times instead')}</div>`
    : `<div class="ru-chips">${times.map(t => ruChip(!!s && s.at.includes(t), 'sched-time', t, t)).join('')}</div>
       <div class="inline"><div class="field"><label for="ru-time">Add a time</label><input id="ru-time" type="time" value="12:00"></div><button class="btn" data-ru="sched-time-add" ${s && s.at.length >= 4 ? 'disabled' : ''}>Add</button></div>
       ${!s ? `<div class="faint" style="font-size:15px">${state.telemetry.autoMin ? `No fixed times: the controller keeps its auto interval (${state.telemetry.autoMin >= 60 ? state.telemetry.autoMin / 60 + ' h' : state.telemetry.autoMin + ' min'}).` : 'No fixed times: nothing runs on its own — only "Run a round" from Control.'}</div>` : ''}
       <div class="ru-chips">${ruChip(false, 'sched-mode', 'interval', 'Every N hours instead')}</div>`;
  return `
  <div class="ru-head"><button class="btn sm" data-action="go" data-arg="control" aria-label="Back to Control">‹ Control</button><div class="stack"><h3>Watering plan</h3><span class="faint" style="font-size:14px">when · how dry · how much · daily cap</span></div></div>
  <div class="section">
    <div class="card section"><h2>When</h2>${whenBody}</div>
    <div class="card section"><h2>How dry before watering</h2>
      <div class="field"><label>Water a pot when its moisture is below <b id="ru-thr-val">${RU.def.thr}</b> %</label><input class="ru-range" type="range" min="1" max="99" value="${RU.def.thr}" data-ru="def-thr" aria-label="moisture threshold percent"></div>
      <div class="faint" style="font-size:14px">Every pot follows this. A pot with its own value in the pot sheet keeps it.</div>
    </div>
    <div class="card section"><h2>How much</h2>
      <div class="ru-chips">${ruChip(RU.def.dose === 250, 'def-dose', 250, 'Small · 250 mL')}${ruChip(RU.def.dose === 900, 'def-dose', 900, 'Large · 900 mL')}</div>
      <div class="faint" style="font-size:14px">${ex.length ? `${ex.length} pot${ex.length > 1 ? 's' : ''} keep${ex.length > 1 ? '' : 's'} own values: ${ex.map(p => esc(potName(p.i))).join(', ')}.` : 'Every pot uses this dose. Give a pot its own in the pot sheet.'}</div>
    </div>
    <div class="card section"><h2>Daily safety cap</h2>
      <div class="ru-line">At most <input type="number" min="1" max="20" value="${r.limits.dailyML / 1000}" data-ru="limit" aria-label="litres per day"> L per day for the whole balcony</div>
      <div class="faint" style="font-size:14px">Whatever happens, the controller stops watering for the day at this amount (1–20 L).</div>
    </div>
    <div class="card section">
      <div class="ru-preview">${esc(ruPreviewText())}</div>
      <div class="row"><strong>Controller</strong>${chip(st.cls, st.label)}</div>
      <button class="btn primary block" data-ru="send">Apply on the controller</button>
      <div class="faint" style="font-size:14px">The plan never lifts a safety interlock: sense first · plausibility · one valve at a time · 0.5 s settle · 90 s pump cap · frost · tank reserve.</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- actions
function ruEnsureSched() { let s = ruSched(); if (!s) { s = { days: 'all', at: [], pots: 'dry' }; RU.rules.schedule.unshift(s); } return s; }
async function ruSend() {
  const rec = await cmd('rules', Rules.normalize(RU.rules), 'Watering plan');
  if (rec && rec.status === 'failed' && rec.result && rec.result.detail) toast(`The controller refused the plan: ${rec.result.detail}`, 5000);
}
function ruClick(e) {
  const el = e.target.closest('[data-ru]'); if (!el || !$('#screen-rules').contains(el)) return;
  const v = el.dataset.v, r = RU.rules;
  switch (el.dataset.ru) {
    case 'sched-time': { const s = ruEnsureSched(); if (s.everyMin) break; const i = s.at.indexOf(v); if (i >= 0) s.at.splice(i, 1); else if (s.at.length < 4) s.at.push(v); else { toast('At most 4 times a day'); break; } if (!s.at.length) r.schedule.shift(); ruCommit(); break; }
    case 'sched-time-add': { const t = $('#ru-time').value; if (!/^\d\d:\d\d$/.test(t)) { toast('Pick a time first'); break; } const s = ruEnsureSched(); if (s.everyMin) break; if (!s.at.includes(t)) { if (s.at.length >= 4) { toast('At most 4 times a day'); break; } s.at.push(t); } ruCommit(); break; }
    case 'sched-mode': r.schedule = [v === 'interval' ? { everyMin: 720, pots: 'dry' } : { days: 'all', at: RU_TIMES.slice(), pots: 'dry' }]; ruCommit(); break;
    case 'def-dose': ruSetDefault('dose', +v); break;
    case 'send': ruSend(); break;
  }
}
function ruChange(e) {
  const el = e.target.closest('[data-ru]'); if (!el || !$('#screen-rules').contains(el)) return;
  const n = (min, max) => Math.max(min, Math.min(max, Math.round(+el.value || 0)));
  switch (el.dataset.ru) {
    case 'sched-interval': RU.rules.schedule = [{ everyMin: +el.value * 60, pots: 'dry' }]; ruCommit(); break;
    case 'def-thr': ruSetDefault('thr', n(1, 99)); break;
    case 'limit': RU.rules.limits.dailyML = n(1, 20) * 1000; ruCommit(); break;
  }
}
function ruInput(e) {
  const el = e.target.closest('[data-ru="def-thr"]'); if (!el) return;
  const lbl = $('#ru-thr-val'); if (lbl) lbl.textContent = el.value;
}
document.addEventListener('click', ruClick);
document.addEventListener('change', ruChange);
document.addEventListener('input', ruInput);
