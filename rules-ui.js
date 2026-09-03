// rules-ui.js — the Rules screen (the "Baukasten", app/RULES.md §5): three synchronized views of ONE draft —
// Forms (constrained fields) · Text (the rule language, inline errors) · Preview (the next 24 h, simulated).
// Uses app.js globals ($, esc, state, backend, cmd, render, go, potName, chip, toast, sheet, when) and Rules from rules.js.
// The draft lives in RU; Forms edits mutate RU.rules and regenerate the text, Text edits reparse into RU.rules.

const RU = { view: 'forms', text: '', rules: Rules.empty(), errors: [], pot: 0, sentText: null, loaded: false };
const RU_STARTER = 'every day at 07:00 and 19:00: water pots that are dry\nat most 10 L per day in total';
const RU_EXAMPLE = `# two rounds a day, only the pots that need it
every day at 07:00 and 19:00: water pots that are dry
pot 3: threshold 40 %, dose 250 mL, at most 2 doses/day
pots 1, 2 and 5: dose large
pot 12: off
if temperature > 30 °C: dose +30 %
if rain forecast > 60 % in the next 12 h: skip the round
if tank < 20 %: dose -50 %
at most 10 L per day in total`;
const RU_TIMES = ['06:00', '07:00', '08:00', '12:00', '18:00', '19:00', '20:00', '21:00'];
const RU_MOD_DEF = { temp: { if: { k: 'temp', op: '>', v: 30 }, then: { dosePct: 30 } }, rain: { if: { k: 'rain', op: '>', v: 60, h: 12 }, then: { skip: true } }, tank: { if: { k: 'tank', op: '<', v: 20 }, then: { dosePct: -50 } } };
const RU_REASON = { off: 'off', nopca: 'no PCA9685', uncal: 'not calibrated', implausible: 'implausible reading', wet: 'wet', cold: 'too cold', tank: 'tank at the reserve', budget: 'daily budget used' };

// ---------------------------------------------------------------- draft state
function ruLoad() {
  if (RU.loaded) return; RU.loaded = true;
  let t = null;
  try { t = localStorage.getItem('rulesDraft'); RU.view = localStorage.getItem('rulesView') || 'forms'; RU.sentText = localStorage.getItem('rulesSent'); } catch (e) { /* file:// or private mode */ }
  try { const q = new URLSearchParams(location.search).get('view'); if (['forms', 'text', 'preview'].includes(q)) RU.view = q; } catch (e) { /* ignore */ }
  ruSetText(t === null ? RU_STARTER : t);
}
function ruSave() { try { localStorage.setItem('rulesDraft', RU.text); localStorage.setItem('rulesView', RU.view); if (RU.sentText !== null) localStorage.setItem('rulesSent', RU.sentText); } catch (e) { /* ignore */ } }
function ruSetText(t) { RU.text = t; const r = Rules.parse(t); RU.errors = r.errors; if (r.ok) RU.rules = r.rules; }
function ruCommit() { RU.rules = Rules.normalize(RU.rules); RU.text = Rules.toText(RU.rules); RU.errors = []; ruSave(); render(); }
function ruJson() { return Rules.compile(RU.rules); }
function ruStatus() {
  const h = state.telemetry.rulesHash;
  if (RU.errors.length) return { cls: 'implausible', label: `${RU.errors.length} error${RU.errors.length > 1 ? 's' : ''} in the text` };
  if (h === undefined) return { cls: 'uncal', label: 'controller firmware has no rules yet' };
  if (!h) return { cls: 'off', label: 'controller has no rules' };
  if (h === Rules.hash(ruJson())) return { cls: 'info', label: 'controller has this set' };
  return { cls: 'warn', label: 'draft differs from controller' };
}
function ruLine(sched) { return Rules.toText(Object.assign(Rules.empty(), { schedule: [sched] })).split('\n')[0]; }

// ---------------------------------------------------------------- the card on Control
function rulesCard() {
  ruLoad();
  const st = ruStatus(), r = RU.rules;
  const summary = r.schedule.length ? r.schedule.map(ruLine).join(' · ') : (state.telemetry.autoMin ? 'no schedule — the auto interval runs the rounds' : 'no schedule and auto is off — nothing runs on its own');
  return `<div class="card section">
    <div class="row top"><div class="stack"><strong>Rules</strong><span class="faint" style="font-size:14px">${esc(summary)}</span>
      <span class="faint" style="font-size:14px">${Object.keys(r.pots).length} pot setting${Object.keys(r.pots).length === 1 ? '' : 's'} · ${r.modifiers.length} modifier${r.modifiers.length === 1 ? '' : 's'} · at most ${r.limits.dailyML / 1000} L/day</span></div>${chip(st.cls, st.label)}</div>
    <button class="btn block" data-action="go" data-arg="rules">Edit rules</button>
  </div>`;
}

// ---------------------------------------------------------------- the screen
function renderRules() {
  ruLoad();
  const st = ruStatus();
  const tab = (v, label) => `<button role="tab" aria-selected="${RU.view === v}" class="${RU.view === v ? 'active' : ''}" data-ru="view" data-v="${v}">${label}${v === 'text' && RU.errors.length ? `<span class="badge">${RU.errors.length}</span>` : ''}</button>`;
  const body = RU.view === 'text' ? ruTextView() : RU.view === 'preview' ? ruPreviewView() : ruFormsView();
  return `
  <div class="ru-head"><button class="btn sm" data-action="go" data-arg="control" aria-label="Back to Control">‹ Control</button><div class="stack"><h3>Rules</h3><span class="faint" style="font-size:14px">what waters when — the interlocks stay underneath</span></div></div>
  <div class="ru-tabs" role="tablist">${tab('forms', 'Forms')}${tab('text', 'Text')}${tab('preview', 'Preview')}</div>
  ${body}
  <div class="card section" style="margin-top:12px">
    <div class="row"><div class="stack"><strong>Controller</strong><span class="faint mono" style="font-size:14px">draft ${Rules.hash(ruJson())} · controller ${state.telemetry.rulesHash || '—'}</span></div>${chip(st.cls, st.label)}</div>
    <button class="btn primary block" data-ru="send" ${RU.errors.length ? 'disabled' : ''}>Send to controller</button>
    <div class="btn-row"><button class="btn" data-ru="revert" ${RU.sentText === null ? 'disabled' : ''}>Back to what was sent</button><button class="btn" data-ru="clear" ${state.telemetry.rulesHash ? '' : 'disabled'}>Remove rules from controller</button></div>
    <div class="faint" style="font-size:14px">Rules never lift an interlock: sense first · plausibility · one valve at a time · 0.5 s settle · 90 s cap · daily budget · frost · tank reserve.</div>
  </div>`;
}

// ---- Forms
function ruChip(active, ru, v, label, extra) { return `<button class="ru-chip ${active ? 'active' : ''}" aria-pressed="${active}" data-ru="${ru}" data-v="${esc(v)}" ${extra || ''}>${label}</button>`; }
function ruFormsView() {
  const r = RU.rules, s = r.schedule[0];
  const mode = !s ? 'none' : s.everyMin ? 'interval' : s.days === 'all' ? 'all' : s.days.join(',') === '1,2,3,4,5' ? 'weekdays' : s.days.join(',') === '0,6' ? 'weekends' : 'pick';
  const times = s && s.at ? [...new Set([...RU_TIMES, ...s.at])].sort() : RU_TIMES;
  const schedule = `<div class="card section"><h2>When</h2>
    <div class="ru-chips">${ruChip(mode === 'all', 'sched-mode', 'all', 'Every day')}${ruChip(mode === 'weekdays', 'sched-mode', 'weekdays', 'Weekdays')}${ruChip(mode === 'weekends', 'sched-mode', 'weekends', 'Weekends')}${ruChip(mode === 'pick', 'sched-mode', 'pick', 'Pick days')}${ruChip(mode === 'interval', 'sched-mode', 'interval', 'Every N hours')}${ruChip(mode === 'none', 'sched-mode', 'none', 'No schedule')}</div>
    ${mode === 'pick' ? `<div class="ru-chips">${[1, 2, 3, 4, 5, 6, 0].map(d => ruChip(s.days.includes(d), 'sched-day', d, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d])).join('')}</div>` : ''}
    ${mode === 'interval' ? `<div class="ru-line">a round every <select data-ru="sched-interval">${[1, 2, 3, 4, 6, 8, 12, 24, 48].map(h => `<option value="${h}" ${s.everyMin === h * 60 ? 'selected' : ''}>${h} h</option>`).join('')} <span class="faint">— works without the board clock</span></div>` : ''}
    ${mode !== 'none' && mode !== 'interval' ? `<div class="stack"><span class="field"><label>At</label></span><div class="ru-chips">${times.map(t => ruChip(s.at.includes(t), 'sched-time', t, t)).join('')}</div>
      <div class="inline"><div class="field"><label for="ru-time">Other time</label><input id="ru-time" type="time" value="09:30"></div><button class="btn" data-ru="sched-time-add">Add</button></div></div>` : ''}
    ${mode === 'none' ? `<div class="faint" style="font-size:15px">${state.telemetry.autoMin ? `Without a schedule the controller keeps its auto interval (${state.telemetry.autoMin >= 60 ? state.telemetry.autoMin / 60 + ' h' : state.telemetry.autoMin + ' min'}).` : 'Without a schedule nothing runs on its own — only "Run a round" from Control.'}</div>` : ''}
    ${mode !== 'none' ? `<div class="stack"><span class="field"><label>Which pots</label></span><div class="ru-chips">${ruChip(s.pots === 'dry', 'sched-pots', 'dry', 'Every pot that is dry')}${ruChip(s.pots !== 'dry', 'sched-pots', 'pick', 'Only these pots (if dry)')}</div>
      ${s.pots !== 'dry' ? `<div class="ru-chips">${state.pots.map(p => ruChip(s.pots.includes(p.i), 'sched-pot', p.i, `${p.i + 1}`, 'class="ru-chip sm"')).join('')}</div>` : ''}</div>` : ''}
    ${r.schedule.length > 1 ? `<div class="faint" style="font-size:15px">+ ${r.schedule.length - 1} more schedule line${r.schedule.length > 2 ? 's' : ''} — edit in Text: ${r.schedule.slice(1).map(x => `<code>${esc(ruLine(x))}</code>`).join(' · ')}</div>` : ''}
  </div>`;

  const p = state.pots[RU.pot] || state.pots[0], o = r.pots[p.i] || {};
  const thr = o.thr !== undefined ? o.thr : p.thrPct, dose = o.dose !== undefined ? o.dose : p.doseML, max = o.max !== undefined ? o.max : (p.max || 2), on = o.on !== undefined ? o.on : (p.senEn && p.valEn);
  const custom = dose !== 250 && dose !== 900;
  const overrides = Object.keys(r.pots).map(Number).sort((a, b) => a - b);
  const potsCard = `<div class="card section"><h2>Pot settings</h2>
    <div class="field"><label for="ru-pot">Pot</label><select id="ru-pot" data-ru="pot-select">${state.pots.map(q => `<option value="${q.i}" ${q.i === p.i ? 'selected' : ''}>${esc(potName(q.i))}${r.pots[q.i] ? ' •' : ''}</option>`).join('')}</select></div>
    <div class="field"><label>Water below <b id="ru-thr-val">${thr}</b> % moisture <span class="faint">(board: ${p.thrPct} %)</span></label><input class="ru-range" type="range" min="1" max="99" value="${thr}" data-ru="pot-thr" aria-label="threshold percent"></div>
    <div class="stack"><span class="field"><label>Dose <span class="faint">(board: ${p.doseML} mL)</span></label></span><div class="ru-chips">${ruChip(dose === 250, 'pot-dose', 250, 'Small · 250 mL')}${ruChip(dose === 900, 'pot-dose', 900, 'Large · 900 mL')}${ruChip(custom, 'pot-dose', 'custom', 'Custom')}</div>
      ${custom ? `<div class="ru-line"><input type="number" min="10" max="2000" step="10" value="${dose}" data-ru="pot-dose-num" aria-label="dose mL"> mL <span class="faint">10–2000</span></div>` : ''}</div>
    <div class="stack"><span class="field"><label>At most</label></span><div class="ru-chips">${[1, 2, 3, 4].map(n => ruChip(max === n, 'pot-max', n, `${n} dose${n > 1 ? 's' : ''}/day`)).join('')}</div></div>
    <div class="row"><div class="stack"><strong>Pot in the system</strong><span class="faint" style="font-size:14px">off = sensor and valve both switched out</span></div><button class="switch" role="switch" aria-checked="${on}" data-ru="pot-on"></button></div>
    <div class="row"><span class="faint" style="font-size:14px">${o.thr !== undefined || o.dose !== undefined || o.max !== undefined || o.on !== undefined ? 'This pot has its own line in the rules.' : 'No rule line for this pot — it keeps the board settings.'}</span><button class="btn sm" data-ru="pot-reset" ${r.pots[p.i] ? '' : 'disabled'}>Use board settings</button></div>
    ${overrides.length ? `<div class="list">${overrides.map(ch => `<div class="row"><span>${esc(potName(ch))}</span><span class="faint mono" style="font-size:14px">${esc(Rules.toText(Object.assign(Rules.empty(), { pots: { [ch]: r.pots[ch] } })).split('\n')[0].replace(/^pot \d+: /, ''))}</span></div>`).join('')}</div>` : ''}
  </div>`;

  const modRow = (k, title, tpl) => {
    const m = r.modifiers.find(x => x.if.k === k);
    return `<div class="row top"><div class="stack" style="flex:1"><strong>${title}</strong>${m ? tpl(m) : `<span class="faint" style="font-size:14px">${esc(RU_MOD_DEF[k] ? `e.g. ${Rules.toText(Object.assign(Rules.empty(), { modifiers: [RU_MOD_DEF[k]] })).split('\n')[0]}` : '')}</span>`}</div><button class="switch" role="switch" aria-checked="${!!m}" data-ru="mod-on" data-k="${k}"></button></div>`;
  };
  const num = (k, ru, v, min, max, label) => `<input type="number" min="${min}" max="${max}" value="${v}" data-ru="${ru}" data-k="${k}" aria-label="${label}">`;
  const effect = (k, m) => `<select data-ru="mod-effect" data-k="${k}" aria-label="effect"><option value="skip" ${m.then.skip ? 'selected' : ''}>skip the round</option><option value="dose" ${!m.then.skip ? 'selected' : ''}>change the dose</option></select>${!m.then.skip ? `${num(k, 'mod-pct', m.then.dosePct, -80, 100, 'dose change percent')} %` : ''}`;
  const others = r.modifiers.filter((m, i) => r.modifiers.findIndex(x => x.if.k === m.if.k) !== i).length;
  const modsCard = `<div class="card section"><h2>Weather and tank</h2>
    ${modRow('temp', 'Hot day', m => `<div class="ru-line">if temperature ${num('temp', 'mod-v', m.if.v, -20, 60, 'temperature')} °C or more: ${effect('temp', m)}</div>`)}
    ${modRow('rain', 'Rain coming', m => `<div class="ru-line">if rain forecast is over ${num('rain', 'mod-v', m.if.v, 0, 100, 'rain percent')} % in the next ${num('rain', 'mod-h', m.if.h, 1, 48, 'hours')} h: ${effect('rain', m)}</div>`)}
    ${modRow('tank', 'Tank getting low', m => `<div class="ru-line">if the tank is under ${num('tank', 'mod-v', m.if.v, 0, 100, 'tank percent')} %: ${effect('tank', m)}</div>`)}
    ${others ? `<div class="faint" style="font-size:15px">+ ${others} more modifier line${others > 1 ? 's' : ''} — edit in Text.</div>` : ''}
    <div class="faint" style="font-size:14px">Dose changes add up (+30 % and −50 % = −20 %). Without a forecast on the controller the rain rule simply stays off.</div>
  </div>`;

  const limitsCard = `<div class="card section"><h2>Safety net</h2>
    <div class="ru-line">at most <input type="number" min="1" max="20" value="${r.limits.dailyML / 1000}" data-ru="limit" aria-label="litres per day"> L per day in total <span class="faint">(1–20 L; a stuck valve cannot flood the balcony)</span></div>
  </div>`;
  return `<div class="section">${schedule}${potsCard}${modsCard}${limitsCard}</div>`;
}

// ---- Text
function ruErrorsHtml() {
  if (!RU.errors.length) return `<div class="ru-ok">✓ ${RU.text.trim() ? 'All lines understood.' : 'Empty — the controller would run without rules.'}</div>`;
  return RU.errors.map(e => `<div class="ru-err"><b>Line ${e.line}:</b> ${esc(e.msg)}${e.hint ? ` <span class="faint">→ ${esc(e.hint)}</span>` : ''}<code>${esc(e.text)}</code></div>`).join('');
}
function ruTextView() {
  return `<div class="card section"><h2>Rules as text — one rule per line</h2>
    <textarea class="ru-text ${RU.errors.length ? 'bad' : ''}" id="ru-text" data-ru="text" rows="12" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(RU.text)}</textarea>
    <div id="ru-errors">${ruErrorsHtml()}</div>
    <div class="btn-row"><button class="btn" data-ru="example">Insert the example</button><button class="btn" data-ru="tidy" ${RU.errors.length ? 'disabled' : ''}>Tidy up</button></div>
    <details class="ru-cheat"><summary>Cheat sheet</summary>
      <code>every day at 07:00 and 19:00: water pots that are dry</code><br><code>every weekdays at 06:30: water pots 1, 2 and 5</code> · <code>every mon and thu at 20:00: …</code> · <code>every 12 h: …</code><br>
      <code>pot 3: threshold 40 %, dose 250 mL, at most 2 doses/day</code> · <code>pots 1, 2 and 5: dose large</code> · <code>pot 12: off</code><br>
      <code>if temperature &gt; 30 °C: dose +30 %</code> · <code>if rain forecast &gt; 60 % in the next 12 h: skip the round</code> · <code>if tank &lt; 20 %: dose -50 %</code><br>
      <code>at most 10 L per day in total</code> · <code># a comment</code><br>
      Ranges: threshold 1–99 % · dose 10–2000 mL (small = 250, large = 900) · 1–4 doses/day · dose change −80…+100 % · total 1–20 L/day · up to 4 schedule lines, 6 if-lines.
    </details>
  </div>`;
}

// ---- Preview
function ruWorld() {
  const t = state.telemetry, c = state.config, rates = backend.mock ? backend.mock.dryRates() : null;
  const pots = state.pots.map(p => { const o = RU.rules.pots[p.i] || {}; return { i: p.i, name: potName(p.i), pct: p.pct < 0 ? 0 : p.pct, sState: p.sState,
    thrPct: o.thr !== undefined ? o.thr : p.thrPct, doseML: o.dose !== undefined ? o.dose : p.doseML, max: o.max !== undefined ? o.max : (p.max || 2), todayML: p.todayML,
    senEn: o.on !== undefined ? o.on : p.senEn, valEn: o.on !== undefined ? o.on : p.valEn, ratePctPerH: rates ? rates[p.i] : 2 }; });
  return { pots, nFitted: Math.min(t.nSensors, t.nServos), tempC: t.tempEn && t.tempOK ? t.tempC : null, rainPct: t.rainPct === undefined ? null : t.rainPct, rainH: t.rainH || 0,
    tankLeft: t.tankLeft, tankFull: c.tankFull, reserve: c.tankReserve, minTempC: c.minTempC, mlPerSec: t.mlPerSec, maxPumpMs: c.maxPumpMs, autoMin: t.autoMin,
    lastRoundMs: state.lastRound ? state.lastRound.ts : null, havePCA: state.device.havePCA };
}
function ruCond(m) { return Rules.toText(Object.assign(Rules.empty(), { modifiers: [m] })).split('\n')[0].replace(/^if /, '').replace(/: .*$/, ''); }
function ruPreviewView() {
  const w = ruWorld(), sim = Rules.simulate(RU.rules, w, Date.now(), 24);
  const t = state.telemetry;
  const inputs = `now ${w.tempC === null ? 'no temperature' : w.tempC.toFixed(1) + ' °C'} · ${w.rainPct === null ? 'no forecast on the controller' : `rain forecast ${w.rainPct} % in the next ${w.rainH} h`} · tank ${(w.tankLeft / 1000).toFixed(1)} L (${Math.round(100 * w.tankLeft / w.tankFull)} %) · pump ${w.mlPerSec} mL/s`;
  const round = (r) => {
    const head = `<div class="h"><span>${esc(when(r.t))}</span><span class="faint">${r.trigger === 'rule' ? 'scheduled round' : 'auto-interval round'}</span></div>`;
    if (r.skip) return `<div class="ru-round">${head}<div class="skip">▲ skipped — ${esc(ruCond(r.skip))}</div></div>`;
    const wet = r.skipped.filter(x => x.reason === 'wet').length, off = r.skipped.filter(x => x.reason === 'off');
    return `<div class="ru-round">${head}
      ${r.dosePct ? `<div>doses ${r.dosePct > 0 ? '+' : ''}${r.dosePct} % because ${r.fired.filter(m => !m.then.skip).map(m => esc(ruCond(m))).join(' and ')}</div>` : ''}
      ${r.watered.length ? `<div><b>waters</b> ${r.watered.map(x => `${esc(x.name)} ${x.ml} mL (${x.sec} s)`).join(', ')}</div>` : '<div><b>waters nothing</b></div>'}
      <div class="faint" style="font-size:15px">${wet ? `${wet} wet enough` : ''}${off.length ? `${wet ? ' · ' : ''}off: ${off.map(x => x.i + 1).join(', ')}` : ''}${r.refused.length ? `${wet || off.length ? ' · ' : ''}refuses ${r.refused.map(x => `${x.i + 1} (${RU_REASON[x.reason] || x.reason})`).join(', ')}` : ''}</div>
      <div class="faint" style="font-size:15px">tank after: ${(r.tankLeft / 1000).toFixed(2)} L</div></div>`;
  };
  const total = sim.rounds.reduce((s, r) => s + r.watered.reduce((a, x) => a + x.ml, 0), 0);
  return `<div class="card section"><h2>What the board will do — next 24 h</h2>
    <div class="faint" style="font-size:14px">${esc(inputs)}${backend.mock ? ' · drying as fast as the demo pots do' : ' · assumes ~2 % drying per hour'}</div>
    ${sim.notes.map(n => `<div class="ru-note">${esc(n)}</div>`).join('')}
    <div class="list">${sim.rounds.map(round).join('')}</div>
    ${sim.rounds.length ? `<div class="row"><strong>${sim.rounds.length} round${sim.rounds.length > 1 ? 's' : ''} · ${(total / 1000).toFixed(2)} L</strong><span class="faint">next: ${sim.nextT ? esc(when(sim.nextT)) : '—'}</span></div>` : ''}
    ${backend.isMock ? `<div class="ru-line"><span class="faint">Demo forecast:</span><select data-ru="mock-rain" aria-label="demo rain forecast">${[10, 35, 80].map(v => `<option value="${v}" ${t.rainPct === v ? 'selected' : ''}>${v} % rain</option>`).join('')}</select></div>` : ''}
    <details class="ru-cheat"><summary>Exactly what will be sent (${ruJson().length} bytes)</summary><code style="word-break:break-all">${esc(ruJson())}</code></details>
  </div>`;
}

// ---------------------------------------------------------------- actions
function ruSched() { let s = RU.rules.schedule[0]; if (!s) { s = { days: 'all', at: ['07:00'], pots: 'dry' }; RU.rules.schedule.unshift(s); } return s; }
function ruMod(k) { return RU.rules.modifiers.find(m => m.if.k === k); }
function ruPotSet(field, v) { const ch = (state.pots[RU.pot] || state.pots[0]).i; RU.rules.pots[ch] = Object.assign(RU.rules.pots[ch] || {}, { [field]: v }); ruCommit(); }
async function ruSend() {
  if (RU.errors.length) { toast('Fix the errors in the text first'); return; }
  const rec = await cmd('rules', Rules.normalize(RU.rules), 'Rules');
  if (rec && rec.status === 'acked') { RU.sentText = RU.text; ruSave(); render(); }
  else if (rec && rec.result && rec.result.detail) toast(`Controller refused the rules: ${rec.result.detail}`, 5000);
}
function ruClick(e) {
  const el = e.target.closest('[data-ru]'); if (!el || !$('#screen-rules').contains(el)) return;
  const v = el.dataset.v, r = RU.rules;
  switch (el.dataset.ru) {
    case 'view': RU.view = v; ruSave(); render(); break;
    case 'sched-mode': {
      if (v === 'none') { r.schedule.shift(); ruCommit(); break; }
      const s = ruSched();
      if (v === 'interval') { r.schedule[0] = { everyMin: 720, pots: s.pots }; }
      else { const at = s.at && s.at.length ? s.at : ['07:00']; r.schedule[0] = { days: v === 'all' ? 'all' : v === 'weekdays' ? [1, 2, 3, 4, 5] : v === 'weekends' ? [0, 6] : (Array.isArray(s.days) ? s.days : [1]), at, pots: s.pots }; }
      ruCommit(); break;
    }
    case 'sched-day': { const s = ruSched(); const d = +v; const days = s.days === 'all' ? [0, 1, 2, 3, 4, 5, 6] : s.days.slice(); const i = days.indexOf(d); if (i >= 0) { if (days.length > 1) days.splice(i, 1); } else days.push(d); s.days = days.sort((a, b) => a - b); ruCommit(); break; }
    case 'sched-time': { const s = ruSched(); const i = s.at.indexOf(v); if (i >= 0) s.at.splice(i, 1); else if (s.at.length < 4) s.at.push(v); else { toast('At most 4 times per line'); break; } if (!s.at.length) r.schedule.shift(); ruCommit(); break; }
    case 'sched-time-add': { const t = $('#ru-time').value; if (!/^\d\d:\d\d$/.test(t)) { toast('Pick a time first'); break; } const s = ruSched(); if (!s.at.includes(t)) { if (s.at.length >= 4) { toast('At most 4 times per line'); break; } s.at.push(t); } ruCommit(); break; }
    case 'sched-pots': { const s = ruSched(); s.pots = v === 'dry' ? 'dry' : (Array.isArray(s.pots) ? s.pots : [0]); ruCommit(); break; }
    case 'sched-pot': { const s = ruSched(); if (s.pots === 'dry') s.pots = []; const ch = +v, i = s.pots.indexOf(ch); if (i >= 0) { if (s.pots.length > 1) s.pots.splice(i, 1); } else s.pots.push(ch); ruCommit(); break; }
    case 'pot-dose': ruPotSet('dose', v === 'custom' ? 500 : +v); break;
    case 'pot-max': ruPotSet('max', +v); break;
    case 'pot-on': { const p = state.pots[RU.pot] || state.pots[0], o = r.pots[p.i] || {}; ruPotSet('on', !(o.on !== undefined ? o.on : (p.senEn && p.valEn))); break; }
    case 'pot-reset': { delete r.pots[(state.pots[RU.pot] || state.pots[0]).i]; ruCommit(); break; }
    case 'mod-on': { const k = el.dataset.k, i = r.modifiers.findIndex(m => m.if.k === k); if (i >= 0) r.modifiers.splice(i, 1); else if (r.modifiers.length >= Rules.LIM.nMod) { toast('At most 6 if-lines'); break; } else r.modifiers.push(JSON.parse(JSON.stringify(RU_MOD_DEF[k]))); ruCommit(); break; }
    case 'example': ruSetText(RU_EXAMPLE); ruSave(); render(); break;
    case 'tidy': ruCommit(); break;
    case 'revert': if (RU.sentText !== null) { ruSetText(RU.sentText); ruSave(); render(); } break;
    case 'send': ruSend(); break;
    case 'clear': sheet = { type: 'confirm', title: 'Remove the rules from the controller?', body: 'The controller goes back to its auto interval and per-pot settings. Your draft stays here.', ok: 'Remove', run: () => cmd('rules', { clear: true }, 'Rules removed') }; render(); break;
  }
}
function ruChange(e) {
  const el = e.target.closest('[data-ru]'); if (!el || !$('#screen-rules').contains(el)) return;
  const r = RU.rules, k = el.dataset.k, m = k ? ruMod(k) : null;
  const n = (min, max) => Math.max(min, Math.min(max, Math.round(+el.value || 0)));
  switch (el.dataset.ru) {
    case 'sched-interval': ruSched(); r.schedule[0] = { everyMin: +el.value * 60, pots: r.schedule[0].pots }; ruCommit(); break;
    case 'pot-select': RU.pot = +el.value; render(); break;
    case 'pot-thr': ruPotSet('thr', n(1, 99)); break;
    case 'pot-dose-num': ruPotSet('dose', Math.round(n(10, 2000) / 10) * 10); break;
    case 'mod-v': if (m) { m.if.v = n(...(k === 'temp' ? Rules.LIM.temp : k === 'rain' ? Rules.LIM.rain : Rules.LIM.tank)); ruCommit(); } break;
    case 'mod-h': if (m) { m.if.h = n(1, 48); ruCommit(); } break;
    case 'mod-pct': if (m) { m.then = { dosePct: n(-80, 100) }; ruCommit(); } break;
    case 'mod-effect': if (m) { m.then = el.value === 'skip' ? { skip: true } : { dosePct: RU_MOD_DEF[k].then.dosePct || -30 }; ruCommit(); } break;
    case 'limit': r.limits.dailyML = n(1, 20) * 1000; ruCommit(); break;
    case 'mock-rain': backend.mock.setForecast(+el.value); break;
  }
}
function ruInput(e) {
  const el = e.target.closest('[data-ru]'); if (!el) return;
  if (el.dataset.ru === 'text') {                       // reparse on every keystroke; only the error panel re-renders while typing
    ruSetText(el.value); ruSave();
    el.classList.toggle('bad', RU.errors.length > 0);
    const box = $('#ru-errors'); if (box) box.innerHTML = ruErrorsHtml();
    const tab = document.querySelector('.ru-tabs [data-v="text"]'); if (tab) tab.innerHTML = `Text${RU.errors.length ? `<span class="badge">${RU.errors.length}</span>` : ''}`;
    const send = document.querySelector('[data-ru="send"]'); if (send) send.disabled = RU.errors.length > 0;
  } else if (el.dataset.ru === 'pot-thr') { const lbl = $('#ru-thr-val'); if (lbl) lbl.textContent = el.value; }
}
document.addEventListener('click', ruClick);
document.addEventListener('change', ruChange);
document.addEventListener('input', ruInput);
