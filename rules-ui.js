// rules-ui.js — the "Watering plan" screen (app/RULES.md §5): named plans, each pot picks one.
// (Theo, 2026-09-03: "start real simple … settings only"; then: named plans with a default, a safety mode that
// waters every time except when the soil is too wet, and a test button.)
//   Plans      — up to four, one is the default; rename · duplicate · delete · make default
//   When       — times as chips (max 4) or "every N hours"          (per plan)
//   Mode       — When dry (water pots drier than X %) · Every time (water all, skip pots wetter than X %)
//   How much   — small 250 mL / large 900 mL                        (per plan)
//   Daily cap  — litres per day for the pots on the plan            (per plan)
// plus a preview line, Preview (what a round would do right now), Run now, and "Apply on the controller".
// The draft is a `rules v2` object (rules.js) and travels whole as the `rules` command; a pot's plan is chosen in the
// pot sheet / Settings (ruPlanOptions, ruSetPot) and written into pots{}.
// Uses app.js globals ($, esc, state, sheet, backend, cmd, render, potName, chip, toast, when) and Rules from rules.js.

const RU = { rules: null, sel: 'a', loaded: false, pv: {} };   // pv[planId] = { local, ctl, at } — the last Preview
const RU_TIMES = ['07:00', '19:00'];
const RU_WHY = { wet: 'wet', off: 'off', implausible: 'implausible', uncal: 'not calibrated', budget: 'daily budget used', cold: 'frost', tank: 'tank at reserve', nopca: 'no valve driver' };

// ---------------------------------------------------------------- draft state (localStorage; a v1 draft is migrated once)
function ruLoad() {
  if (RU.loaded) return; RU.loaded = true;
  let r = null;
  try {
    const j = localStorage.getItem('planDraft');
    if (j) {
      const res = Rules.fromJSON(j); if (res.ok) r = res.rules;
      if (r && JSON.parse(j).v === 1) {                       // the v1 screen kept its "follow" values next to the draft
        const d = JSON.parse(localStorage.getItem('planDefaults') || 'null');
        if (d && Number.isInteger(d.thr) && Number.isInteger(d.dose)) { r.plans[0].thr = d.thr; r.plans[0].dose = d.dose; }
        localStorage.removeItem('planDefaults'); localStorage.removeItem('rulesDraft');
      }
    }
  } catch (e) { /* file:// or private mode */ }
  RU.rules = r || Rules.empty();
  RU.sel = RU.rules.default;
  ruSave();
}
function ruSave() { try { localStorage.setItem('planDraft', Rules.compile(RU.rules)); } catch (e) { /* ignore */ } }
function ruCommit() { RU.rules = Rules.normalize(RU.rules); RU.pv = {}; ruSave(); render(); }
function ruJson() { return Rules.compile(RU.rules); }
function ruStatus() {
  const h = state.telemetry.rulesHash;
  if (h === undefined) return { cls: 'uncal', label: 'controller cannot take a plan yet' };     // firmware before the watering plan
  if (!h) return { cls: 'off', label: 'controller has no plan' };
  if (h === Rules.hash(ruJson())) return { cls: 'info', label: 'controller uses this plan' };
  return { cls: 'warn', label: 'changes not applied yet' };
}
function ruPlan() { return Rules.planById(RU.rules, RU.sel) || Rules.planById(RU.rules, RU.rules.default); }
function ruFitted() { const t = state.telemetry; return state.pots.filter(p => p.i < Math.max(t.nSensors, t.nServos)); }
function ruPotsOn(id) { return ruFitted().filter(p => Rules.potPlanId(RU.rules, p.i) === id); }
function ruPlanName(i) { ruLoad(); const id = Rules.potPlanId(RU.rules, i); if (id === 'off') return 'off'; const p = Rules.planById(RU.rules, id); return p ? p.name : '?'; }
// A small letter on a pot tile when the pot does not follow the default plan ("" otherwise).
function ruPotTag(i) { ruLoad(); const id = Rules.potPlanId(RU.rules, i); return id === RU.rules.default ? '' : `<span class="pl">${id === 'off' ? 'off' : id.toUpperCase()}</span>`; }
// <option>s for the pot sheet / Settings picker: the default first, the other plans, then Off.
function ruPlanOptions(i) {
  ruLoad();
  const cur = Rules.potPlanId(RU.rules, i), d = RU.rules.default;
  const opts = RU.rules.plans.slice().sort((a, b) => (a.id === d ? -1 : b.id === d ? 1 : 0)).map(p => `<option value="${p.id}" ${cur === p.id ? 'selected' : ''}>${esc(p.name)}${p.id === d ? ' (default)' : ''}</option>`);
  opts.push(`<option value="off" ${cur === 'off' ? 'selected' : ''}>Off — never watered</option>`);
  return opts.join('');
}
function ruSetPot(i, id) {
  ruLoad();
  if (id === RU.rules.default) delete RU.rules.pots[i]; else RU.rules.pots[i] = id;
  ruCommit();
  toast(`${potName(i)} → ${id === 'off' ? 'off' : Rules.planById(RU.rules, id).name}. Apply it on the controller from the watering plan.`, 4000);
}
function ruTimesText(t) { return t.length > 1 ? t.slice(0, -1).join(', ') + ' and ' + t[t.length - 1] : t[0]; }
function ruWhenText(p) { return p.when.everyMin ? `a round every ${p.when.everyMin / 60} h` : `every day at ${ruTimesText(p.when.times)}`; }
function ruModeText(p) { return p.mode === 'dry' ? `pots drier than ${p.thr} % get ${p.dose} mL` : `every pot gets ${p.dose} mL, except pots wetter than ${p.thr} %`; }
// Next round of this plan: the controller's answer to the last Preview when it has one, else computed here.
function ruNextT(p) { const pv = RU.pv[p.id]; if (pv && pv.ctl && pv.ctl.nextAt) return pv.ctl.nextAt; return Rules.nextTrigger(RU.rules, p.id, Date.now(), state.lastRound ? state.lastRound.ts : null); }
// The one preview line: "Next: Tue 19:00 — pots drier than 35 % get 250 mL · 12 pots · today so far 1.2 L of 6 L."
function ruPreviewText(p) {
  const n = ruNextT(p), on = ruPotsOn(p.id), today = on.reduce((s, q) => s + q.todayML, 0);
  return `${n ? `Next: ${when(n)} — ` : 'No round planned — '}${ruModeText(p)} · ${on.length} pot${on.length === 1 ? '' : 's'} · today so far ${(today / 1000).toFixed(1)} L of ${p.dailyML / 1000} L.`;
}
function ruWouldText(pv) {
  const water = pv.would.filter(x => x.action === 'water'), skip = pv.would.filter(x => x.action === 'skip');   // n = 0-based ch, like pots{}
  const w = water.length ? `Would water: ${water.map(x => esc(potName(x.n)) + (x.ml ? ` (${x.ml} mL)` : '')).join(', ')}` : 'Would water nothing right now';
  return `${w}${skip.length ? ` · would skip: ${skip.map(x => `${x.n + 1} (${RU_WHY[x.why] || esc(x.why)})`).join(', ')}` : ''}.`;
}

// ---------------------------------------------------------------- the card on Control
function rulesCard() {
  ruLoad();
  const st = ruStatus(), d = Rules.planById(RU.rules, RU.rules.default), n = RU.rules.plans.length;
  return `<div class="card section">
    <div class="row top"><div class="stack"><strong>Watering plan</strong><span class="faint" style="font-size:14px">${n > 1 ? `${n} plans · default "${esc(d.name)}": ` : ''}${esc(ruWhenText(d))} · ${esc(ruModeText(d))}</span></div>${chip(st.cls, st.label)}</div>
    <button class="btn block" data-action="go" data-arg="rules">Edit the watering plan</button>
  </div>`;
}

// ---------------------------------------------------------------- the screen
function ruChip(active, ru, v, label, extra) { return `<button class="ru-chip ${active ? 'active' : ''}" aria-pressed="${active}" data-ru="${ru}" data-v="${esc(v)}" ${extra || ''}>${label}</button>`; }
function renderRules() {
  ruLoad();
  const st = ruStatus(), r = RU.rules, p = ruPlan(), isDef = p.id === r.default, on = ruPotsOn(p.id), pv = RU.pv[p.id];
  const times = p.when.everyMin ? RU_TIMES : [...new Set([...RU_TIMES, ...p.when.times])].sort();
  const whenBody = p.when.everyMin
    ? `<div class="ru-line">a round every <select data-ru="sched-interval" aria-label="hours between rounds">${[1, 2, 3, 4, 6, 8, 12, 24, 48].map(h => `<option value="${h}" ${p.when.everyMin === h * 60 ? 'selected' : ''}>${h} h</option>`).join('')}</select> <span class="faint">counted from the last round</span></div>
       <div class="ru-chips">${ruChip(false, 'sched-mode', 'fixed', 'Fixed times instead')}</div>`
    : `<div class="ru-chips">${times.map(t => ruChip(p.when.times.includes(t), 'sched-time', t, t)).join('')}</div>
       <div class="inline"><div class="field"><label for="ru-time">Add a time</label><input id="ru-time" type="time" value="12:00"></div><button class="btn" data-ru="sched-time-add" ${p.when.times.length >= 4 ? 'disabled' : ''}>Add</button></div>
       <div class="ru-chips">${ruChip(false, 'sched-mode', 'interval', 'Every N hours instead')}</div>`;
  const doses = [250, 900].includes(p.dose) ? [250, 900] : [250, 900, p.dose];
  const src = pv ? (pv.ctl ? `the controller's answer, ${when(pv.at)}` : st.cls === 'info' ? (backend.lan ? 'from the last reading; the controller prints its own list on the serial console' : 'from the last reading — asking the controller…') : 'from the last reading — apply the plan to ask the controller') : '';
  return `
  <div class="ru-head"><button class="btn sm" data-action="go" data-arg="control" aria-label="Back to Control">‹ Control</button><div class="stack"><h3>Watering plan</h3><span class="faint" style="font-size:14px">plans · each pot picks one</span></div></div>
  <div class="section">
    <div class="card section"><h2>Plans</h2>
      <div class="ru-chips" role="tablist" aria-label="Plans">${r.plans.map(q => `<button class="ru-chip ${q.id === p.id ? 'active' : ''}" role="tab" aria-selected="${q.id === p.id}" data-ru="plan-sel" data-v="${q.id}">${esc(q.name)}${q.id === r.default ? ' <small>★ default</small>' : ''}</button>`).join('')}${r.plans.length < Rules.LIM.nPlans ? ruChip(false, 'plan-new', '', '+ New plan') : ''}</div>
      <div class="inline"><div class="field"><label for="ru-name">Name</label><input id="ru-name" type="text" maxlength="16" value="${esc(p.name)}" data-ru="plan-name"></div>
        <div class="btn-row">${isDef ? '' : '<button class="btn" data-ru="plan-default">Make default</button>'}${r.plans.length < Rules.LIM.nPlans ? '<button class="btn" data-ru="plan-dup">Duplicate</button>' : ''}${isDef ? '' : '<button class="btn danger-outline" data-ru="plan-del">Delete</button>'}</div></div>
      <div class="faint" style="font-size:14px">${isDef ? 'The default: every pot without its own choice follows it.' : 'Pots choose this plan in the pot sheet or in Settings.'} On this plan${on.length ? ` (${on.length}): ${on.map(q => esc(potName(q.i))).join(', ')}` : ': no pot yet'}.</div>
    </div>
    <div class="card section"><h2>When</h2>${whenBody}</div>
    <div class="card section"><h2>Watering mode</h2>
      <div class="ru-modes" role="radiogroup" aria-label="Watering mode">
        <button class="ru-mode ${p.mode === 'dry' ? 'active' : ''}" role="radio" aria-checked="${p.mode === 'dry'}" data-ru="mode" data-v="dry"><b>When dry</b><span>only pots below the moisture line get water</span></button>
        <button class="ru-mode ${p.mode === 'always' ? 'active' : ''}" role="radio" aria-checked="${p.mode === 'always'}" data-ru="mode" data-v="always"><b>Every time</b><span>every pot gets water — except pots above the line</span></button>
      </div>
      <div class="field"><label>${p.mode === 'dry' ? 'Water pots drier than' : 'Skip pots wetter than'} <b id="ru-thr-val">${p.thr}</b> %</label><input class="ru-range" type="range" min="1" max="99" value="${p.thr}" data-ru="thr" aria-label="moisture line percent"></div>
    </div>
    <div class="card section"><h2>How much</h2>
      <div class="ru-chips">${doses.map(d => ruChip(p.dose === d, 'dose', d, d === 250 ? 'Small · 250 mL' : d === 900 ? 'Large · 900 mL' : `${d} mL`)).join('')}</div>
      <div class="faint" style="font-size:14px">Per pot and round. A pot never gets more than twice this in a day.</div>
    </div>
    <div class="card section"><h2>Daily cap</h2>
      <div class="ru-line">At most <input type="number" min="0.5" max="20" step="0.5" value="${p.dailyML / 1000}" data-ru="limit" aria-label="litres per day"> L per day for the pots on this plan</div>
      <div class="faint" style="font-size:14px">Whatever happens, this plan stops watering for the day at this amount (0.5–20 L).</div>
    </div>
    <div class="card section">
      <div class="ru-preview">${esc(ruPreviewText(p))}</div>
      <div class="btn-row"><button class="btn" data-ru="preview">Preview</button><button class="btn" data-ru="run">Run now</button></div>
      ${pv ? `<div class="ru-would">${ruWouldText(pv.ctl || pv.local)}<div class="faint" style="font-size:13px;margin-top:4px">${esc(src)}</div></div>` : ''}
      <div class="row"><strong>Controller</strong>${chip(st.cls, st.label)}</div>
      <button class="btn primary block" data-ru="send">Apply on the controller</button>
      <div class="faint" style="font-size:14px">All plans and every pot's choice go together. A plan never lifts a safety interlock: sense first · plausibility · one valve at a time · 0.5 s settle · 90 s pump cap · frost · tank reserve.</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- actions
async function ruSend() {
  const rec = await cmd('rules', Rules.normalize(RU.rules), 'Watering plan');
  if (rec && rec.status === 'failed' && rec.result && rec.result.detail) toast(`The controller refused the plan: ${rec.result.detail}`, 5000);
}
async function ruPreview() {
  const p = ruPlan(), id = p.id;
  RU.pv[id] = { local: Rules.preview(RU.rules, id, Rules.worldFrom(state)), ctl: null, at: Date.now() }; render();
  if (ruStatus().cls !== 'info' || backend.lan) return;                  // the controller has another plan (or none) — its answer would be about that one
  const rec = await cmd('plan_preview', { id }, `Preview "${p.name}"`);
  if (rec && rec.status === 'acked' && rec.result && Array.isArray(rec.result.would) && RU.pv[id]) {
    const r = rec.result; RU.pv[id].ctl = { plan: r.plan, would: r.would, nextAt: r.nextAt > 0 ? r.nextAt * 1000 : null }; RU.pv[id].at = Date.now(); render();   // nextAt: epoch seconds on the wire
  }
}
function ruRun() {
  const p = ruPlan();
  if (ruStatus().cls !== 'info') { toast('Apply the plan on the controller first — Run now uses the plan the controller holds.', 4500); return; }
  sheet = { type: 'confirm', title: `Run "${p.name}" now?`, body: `This waters now. A round of this plan: ${ruModeText(p)} — through every interlock, one valve at a time.`, ok: 'Water now', run: () => cmd('plan_run', { id: p.id }, `Run "${p.name}"`) };
  render();
}
function ruDelete() {
  const p = ruPlan(), n = ruPotsOn(p.id).length, d = Rules.planById(RU.rules, RU.rules.default);
  sheet = { type: 'confirm', danger: true, title: `Delete "${p.name}"?`, body: n ? `${n} pot${n > 1 ? 's' : ''} on it go back to the default plan "${d.name}".` : 'No pot is on it.', ok: 'Delete plan',
    run: () => { RU.rules.plans = RU.rules.plans.filter(q => q.id !== p.id); Object.keys(RU.rules.pots).forEach(k => { if (RU.rules.pots[k] === p.id) delete RU.rules.pots[k]; }); RU.sel = RU.rules.default; ruCommit(); } };
  render();
}
function ruAddPlan(from) {
  const id = Rules.nextId(RU.rules); if (!id) { toast('At most 4 plans'); return; }
  const q = from ? Object.assign(JSON.parse(JSON.stringify(from)), { id, name: `${from.name} 2`.slice(0, Rules.LIM.nameLen) }) : Rules.defaultPlan(id, `Plan ${id.toUpperCase()}`);
  RU.rules.plans.push(q); RU.sel = id; ruCommit();
  setTimeout(() => { const el = $('#ru-name'); if (el) { el.focus(); el.select(); } }, 0);
}
function ruClick(e) {
  const el = e.target.closest('[data-ru]'); if (!el || !$('#screen-rules').contains(el)) return;
  const ae = document.activeElement; if (ae && ae !== el && /^(INPUT|SELECT)$/.test(ae.tagName)) ae.blur();   // a tap on a chip ends the edit (render() never clobbers a focused field)
  const v = el.dataset.v, p = ruPlan();
  switch (el.dataset.ru) {
    case 'plan-sel': RU.sel = v; render(); break;
    case 'plan-new': ruAddPlan(null); break;
    case 'plan-dup': ruAddPlan(p); break;
    case 'plan-default': RU.rules.default = p.id; ruCommit(); toast(`"${p.name}" is the default now — pots without their own choice follow it.`, 4000); break;
    case 'plan-del': ruDelete(); break;
    case 'sched-time': { if (p.when.everyMin) break; const i = p.when.times.indexOf(v); if (i >= 0) { if (p.when.times.length === 1) { toast('Keep at least one time, or switch to "Every N hours"'); break; } p.when.times.splice(i, 1); } else if (p.when.times.length < 4) p.when.times.push(v); else { toast('At most 4 times a day'); break; } ruCommit(); break; }
    case 'sched-time-add': { const t = $('#ru-time').value; if (!/^\d\d:\d\d$/.test(t)) { toast('Pick a time first'); break; } if (p.when.everyMin) break; if (!p.when.times.includes(t)) { if (p.when.times.length >= 4) { toast('At most 4 times a day'); break; } p.when.times.push(t); } ruCommit(); break; }
    case 'sched-mode': p.when = v === 'interval' ? { everyMin: 720 } : { times: RU_TIMES.slice() }; ruCommit(); break;
    case 'mode': p.mode = v === 'always' ? 'always' : 'dry'; ruCommit(); break;
    case 'dose': p.dose = +v; ruCommit(); break;
    case 'preview': ruPreview(); break;
    case 'run': ruRun(); break;
    case 'send': ruSend(); break;
  }
}
function ruChange(e) {
  const el = e.target.closest('[data-ru]'); if (!el || !$('#screen-rules').contains(el)) return;
  const p = ruPlan(), n = (min, max) => Math.max(min, Math.min(max, Math.round(+el.value || 0)));
  switch (el.dataset.ru) {
    case 'plan-name': { const name = el.value.trim().slice(0, Rules.LIM.nameLen); if (!name) { toast('A plan needs a name'); el.value = p.name; break; } p.name = name; ruCommit(); break; }
    case 'sched-interval': p.when = { everyMin: +el.value * 60 }; ruCommit(); break;
    case 'thr': p.thr = n(1, 99); ruCommit(); break;
    case 'limit': p.dailyML = Math.max(500, Math.min(20000, Math.round((+el.value || 0) * 2) * 500)); ruCommit(); break;
  }
}
function ruInput(e) {
  const el = e.target.closest('[data-ru="thr"]'); if (!el) return;
  const lbl = $('#ru-thr-val'); if (lbl) lbl.textContent = el.value;
}
document.addEventListener('click', ruClick);
document.addEventListener('change', ruChange);
document.addEventListener('input', ruInput);
