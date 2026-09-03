// rules.js — the rule language (app/RULES.md): parse text → rules v1 object → canonical JSON,
// and back to text; validation; the FNV hash the board reports; the round planner shared by
// the mock and the Preview; a 24 h simulation. Plain script: `window.Rules` in the browser,
// `module.exports` in node (rules.test.js). No libraries, no DOM.
(function (root) {
'use strict';

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_FULL = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const LIM = { thr: [1, 99], dose: [10, 2000], max: [1, 4], pot: [1, 16], temp: [-20, 60], rain: [0, 100], rainH: [1, 48], tank: [0, 100],
  dosePct: [-80, 100], dailyL: [1, 20], everyH: [1, 168], nSched: 4, nMod: 6, bytes: 2048 };
const DEF = { thr: 35, dose: 250, max: 2, dailyML: 10000, rainH: 12 };
const DOSE_WORD = { small: 250, large: 900 };
const N_CH = 16;

function empty() { return { v: 1, schedule: [], pots: {}, modifiers: [], limits: { dailyML: DEF.dailyML } }; }
function inRange(v, r) { return Number.isInteger(v) && v >= r[0] && v <= r[1]; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function hhmm(min) { return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60); }

// ---------------------------------------------------------------- tokenizer
// Tokens: numbers, words, and the symbols the grammar uses. `°` is dropped so "30 °C" and "30 C" read the same.
function tokenize(line) {
  const out = []; const re = /\s*(\d+|[a-zA-ZäöüÄÖÜ]+|>=|<=|>|<|:|,|%|\/|\+|-|°|#)/y; let m, pos = 0;
  while (pos < line.length) {
    re.lastIndex = pos; m = re.exec(line);
    if (!m) { if (/^\s*$/.test(line.slice(pos))) break; throw { msg: `unexpected "${line.slice(pos).trim()[0]}"`, hint: 'only letters, numbers, : , % / + - are used' }; }
    pos = re.lastIndex;
    const t = m[1];
    if (t === '#') break;                                     // trailing comment
    if (t === '°') continue;
    out.push(/^\d+$/.test(t) ? { n: +t, s: t } : { w: t.toLowerCase(), s: t });
  }
  return out;
}

// ---------------------------------------------------------------- parser (one line)
function Parser(tokens) { this.t = tokens; this.i = 0; }
Parser.prototype = {
  peek(k) { return this.t[this.i + (k || 0)]; },
  next() { return this.t[this.i++]; },
  done() { return this.i >= this.t.length; },
  isWord(w, k) { const t = this.peek(k); return !!t && t.w === w; },
  isNum(k) { const t = this.peek(k); return !!t && t.n !== undefined; },
  fail(msg, hint) { throw { msg, hint }; },
  word(w, hint) { if (!this.isWord(w)) this.fail(`expected "${w}"${this.peek() ? ` but found "${this.peek().s}"` : ''}`, hint); return this.next(); },
  words(list, hint) { list.forEach(w => this.word(w, hint)); },
  num(what, range, hint) {
    if (!this.isNum()) this.fail(`expected a number for ${what}${this.peek() ? ` but found "${this.peek().s}"` : ''}`, hint);
    const v = this.next().n;
    if (range && !inRange(v, range)) this.fail(`${what} ${v} out of range`, `${range[0]}–${range[1]}`);
    return v;
  },
  sym(s, hint) { const t = this.peek(); if (!t || t.w !== s) this.fail(`expected "${s}"${t ? ` but found "${t.s}"` : ''}`, hint); return this.next(); },
  sep() { if (this.isWord(',') || this.isWord('and')) { this.next(); if (this.isWord('and')) this.next(); return true; } return false; },
  end() { if (!this.done()) this.fail(`unexpected "${this.peek().s}" at the end of the rule`, 'one rule per line'); },
  optWord(w) { if (this.isWord(w)) { this.next(); return true; } return false; },
};

function parsePotList(p) {
  const list = [];
  do { const n = p.num('pot number', LIM.pot, 'pots are 1–16'); if (!list.includes(n - 1)) list.push(n - 1); } while (p.sep() && p.isNum());
  return list.sort((a, b) => a - b);
}
function parseTime(p) {
  if (!p.isNum()) p.fail(`expected a time like 07:00${p.peek() ? ` but found "${p.peek().s}"` : ''}`, 'HH:MM, 0:00–23:59');
  const h = p.next().n;
  if (!p.isWord(':') || !p.isNum(1)) p.fail(`time ${h} needs minutes`, `e.g. ${h}:00`);
  p.next(); const m = p.next().n;
  if (h > 23 || m > 59) p.fail(`time ${h}:${pad2(m)} is not on the clock`, 'use 0:00–23:59');
  return h * 60 + m;
}
function parseSchedule(p) {
  p.word('every');
  const s = { days: 'all', at: [], pots: 'dry' };
  if (p.isNum()) {                                             // every 12 h
    const n = p.num('interval', LIM.everyH, '1–168 h');
    if (!p.optWord('h') && !p.optWord('hours') && !p.optWord('hour')) p.fail('expected "h" after the interval', 'e.g. every 12 h');
    s.everyMin = n * 60; delete s.days; delete s.at;
  } else {
    if (p.optWord('day')) s.days = 'all';
    else if (p.optWord('weekdays')) s.days = [1, 2, 3, 4, 5];
    else if (p.optWord('weekends')) s.days = [0, 6];
    else {
      const days = [];
      do {
        const t = p.peek(); const d = t && t.w !== undefined ? (DAY.indexOf(t.w.slice(0, 3)) >= 0 && (t.w.length === 3 || DAY_FULL[t.w] !== undefined) ? DAY.indexOf(t.w.slice(0, 3)) : -1) : -1;
        if (d < 0) p.fail(`expected "day", a weekday or a number after "every"${t ? ` but found "${t.s}"` : ''}`, 'every day at 07:00 · every mon and thu at 07:00 · every 12 h');
        p.next(); if (!days.includes(d)) days.push(d);
      } while (p.sep());
      s.days = days.sort((a, b) => a - b);
      if (s.days.length === 7) s.days = 'all';
    }
    if (!p.optWord('at')) p.fail(`expected "at HH:MM" after "every ${s.days === 'all' ? 'day' : '…'}"`, 'e.g. every day at 07:00');
    do { const t = parseTime(p); if (!s.at.includes(t)) s.at.push(t); } while (p.sep());
    s.at.sort((a, b) => a - b);
    if (s.at.length > 4) p.fail('more than 4 times in one schedule', 'split into two lines');
  }
  p.sym(':', 'a colon separates when from what');
  p.word('water', 'e.g. …: water pots that are dry');
  if (p.optWord('pot')) { s.pots = parsePotList(p); }
  else {
    p.word('pots', 'e.g. …: water pots that are dry');
    if (p.isWord('that')) { p.words(['that', 'are', 'dry'], '"pots that are dry"'); s.pots = 'dry'; }
    else { s.pots = parsePotList(p); if (p.optWord('that')) p.words(['are', 'dry'], '"that are dry"'); }
  }
  if (s.everyMin) return { everyMin: s.everyMin, pots: s.pots };
  return { days: s.days, at: s.at.map(hhmm), pots: s.pots };
}
function parsePotRule(p) {
  let list;
  if (p.optWord('pot')) list = [p.num('pot number', LIM.pot, 'pots are 1–16') - 1];
  else { p.word('pots'); list = parsePotList(p); }
  p.sym(':', 'e.g. pot 3: threshold 40 %');
  const set = {};
  do {
    if (p.optWord('threshold')) { set.thr = p.num('threshold', LIM.thr, '1–99 %'); p.optWord('%'); }
    else if (p.optWord('dose')) {
      const t = p.peek();
      if (t && DOSE_WORD[t.w]) { p.next(); set.dose = DOSE_WORD[t.w]; }
      else { set.dose = p.num('dose', LIM.dose, '10–2000 mL, or small / large'); if (!p.optWord('ml')) p.optWord('milliliters'); }
    }
    else if (p.isWord('at') && p.isWord('most', 1)) {
      p.next(); p.next(); set.max = p.num('doses per day', LIM.max, '1–4 doses/day');
      if (!p.optWord('dose')) p.word('doses', 'e.g. at most 2 doses/day');
      if (p.optWord('/')) p.word('day'); else if (p.optWord('per')) p.word('day'); else if (p.optWord('a')) p.word('day'); else p.fail('expected "/day" after the doses', 'e.g. at most 2 doses/day');
    }
    else if (p.optWord('off')) set.on = false;
    else if (p.optWord('on')) set.on = true;
    else p.fail(`unknown pot setting${p.peek() ? ` "${p.peek().s}"` : ''}`, 'threshold N % · dose N mL · at most N doses/day · off · on');
  } while (p.optWord(','));
  return { list, set };
}
function parseOp(p) {
  const t = p.peek();
  if (!t || !['>', '<', '>=', '<='].includes(t.w)) p.fail(`expected > < >= or <=${t ? ` but found "${t.s}"` : ''}`, 'e.g. temperature > 30 °C');
  return p.next().w;
}
function parseModifier(p) {
  p.word('if');
  const c = {};
  if (p.optWord('temperature')) { c.k = 'temp'; c.op = parseOp(p); c.v = p.num('temperature', LIM.temp, '−20–60 °C'); p.optWord('c'); }
  else if (p.isWord('rain')) {
    p.next(); p.optWord('forecast'); c.k = 'rain'; c.op = parseOp(p); c.v = p.num('rain forecast', LIM.rain, '0–100 %'); p.optWord('%');
    c.h = DEF.rainH;
    if (p.optWord('in')) { p.words(['the', 'next'], 'e.g. in the next 12 h'); c.h = p.num('forecast window', LIM.rainH, '1–48 h'); if (!p.optWord('h')) p.optWord('hours'); }
  }
  else if (p.optWord('tank')) { c.k = 'tank'; c.op = parseOp(p); c.v = p.num('tank level', LIM.tank, '0–100 %'); p.optWord('%'); }
  else p.fail(`unknown condition${p.peek() ? ` "${p.peek().s}"` : ''}`, 'temperature · rain forecast · tank');
  p.sym(':', 'a colon separates the condition from the effect');
  const e = {};
  if (p.optWord('dose')) {
    const sign = p.peek(); if (!sign || (sign.w !== '+' && sign.w !== '-')) p.fail('expected + or - after "dose"', 'e.g. dose +30 %');
    p.next(); const n = p.num('dose change', [0, 100], '−80 … +100 %');
    e.dosePct = sign.w === '-' ? -n : n;
    if (!inRange(e.dosePct, LIM.dosePct)) p.fail(`dose change ${e.dosePct} % out of range`, '−80 … +100 %');
    p.optWord('%');
  }
  else if (p.optWord('skip')) { p.words(['the', 'round'], '"skip the round"'); e.skip = true; }
  else p.fail(`unknown effect${p.peek() ? ` "${p.peek().s}"` : ''}`, 'dose +N % · dose -N % · skip the round');
  return { if: c, then: e };
}
function parseLimit(p) {
  p.words(['at', 'most']);
  const n = p.num('daily total', LIM.dailyL, '1–20 L');
  if (!p.optWord('l') && !p.optWord('litres') && !p.optWord('liters')) p.fail('expected "L" after the daily total', 'e.g. at most 10 L per day in total');
  if (p.optWord('/')) p.word('day'); else if (p.optWord('per')) p.word('day'); else p.fail('expected "per day"', 'e.g. at most 10 L per day in total');
  if (p.optWord('in')) p.word('total');
  return n * 1000;
}

// parse(text) → { ok, rules, errors:[{line, text, msg, hint}] }. `rules` is built from the lines that parsed.
function parse(text) {
  const rules = empty(); const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    let toks;
    try { toks = tokenize(raw); } catch (e) { errors.push({ line, text: raw, msg: e.msg, hint: e.hint }); return; }
    if (!toks.length) return;
    const p = new Parser(toks);
    try {
      const first = toks[0].w;
      if (first === 'every') { const s = parseSchedule(p); p.end(); if (rules.schedule.length >= LIM.nSched) p.fail('more than 4 schedule lines', 'combine times on one line'); rules.schedule.push(s); }
      else if (first === 'pot' || first === 'pots') { const r = parsePotRule(p); p.end(); r.list.forEach(ch => { rules.pots[ch] = Object.assign(rules.pots[ch] || {}, r.set); }); }
      else if (first === 'if') { const m = parseModifier(p); p.end(); if (rules.modifiers.length >= LIM.nMod) p.fail('more than 6 modifiers', 'keep the six that matter'); rules.modifiers.push(m); }
      else if (first === 'at' && toks[1] && toks[1].w === 'most') { rules.limits.dailyML = parseLimit(p); p.end(); }
      else p.fail(`a rule starts with every · pot · pots · if · at most, not "${toks[0].s}"`, 'see the examples');
    } catch (e) { if (e && e.msg) errors.push({ line, text: raw, msg: e.msg, hint: e.hint }); else throw e; }
  });
  return { ok: errors.length === 0, rules, errors };
}

// ---------------------------------------------------------------- text ← rules
function listText(nums) { const a = nums.map(String); return a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0] || ''; }
function daysText(days) {
  if (days === 'all') return 'day';
  const s = days.join(',');
  if (s === '1,2,3,4,5') return 'weekdays';
  if (s === '0,6') return 'weekends';
  return listText(days.map(d => DAY[d]));
}
function potsText(pots) { return pots === 'dry' ? 'pots that are dry' : (pots.length === 1 ? 'pot ' : 'pots ') + listText(pots.map(c => c + 1)) + ' that are dry'; }
function scheduleText(s) {
  return (s.everyMin ? `every ${s.everyMin / 60} h` : `every ${daysText(s.days)} at ${listText(s.at)}`) + ': water ' + potsText(s.pots);
}
function condText(c) {
  if (c.k === 'temp') return `temperature ${c.op} ${c.v} °C`;
  if (c.k === 'rain') return `rain forecast ${c.op} ${c.v} %${c.h !== DEF.rainH ? ` in the next ${c.h} h` : ''}`;
  return `tank ${c.op} ${c.v} %`;
}
function effectText(e) { return e.skip ? 'skip the round' : `dose ${e.dosePct >= 0 ? '+' : '-'}${Math.abs(e.dosePct)} %`; }
function modifierText(m) { return `if ${condText(m.if)}: ${effectText(m.then)}`; }
function potText(ch, s) {
  const parts = [];
  if (s.thr !== undefined) parts.push(`threshold ${s.thr} %`);
  if (s.dose !== undefined) parts.push(`dose ${s.dose} mL`);
  if (s.max !== undefined) parts.push(`at most ${s.max} dose${s.max === 1 ? '' : 's'}/day`);
  if (s.on === false) parts.push('off'); else if (s.on === true) parts.push('on');
  return `pot ${ch + 1}: ${parts.join(', ')}`;
}
function toText(rules) {
  const r = normalize(rules);
  const out = [];
  r.schedule.forEach(s => out.push(scheduleText(s)));
  Object.keys(r.pots).map(Number).sort((a, b) => a - b).forEach(ch => { if (Object.keys(r.pots[ch]).length) out.push(potText(ch, r.pots[ch])); });
  r.modifiers.forEach(m => out.push(modifierText(m)));
  out.push(`at most ${r.limits.dailyML / 1000} L per day in total`);
  return out.join('\n');
}

// ---------------------------------------------------------------- validate · normalize · compile · hash
// validate(obj) → null when fine, else an error string in the board's `detail` style ("modifiers[2]: …").
function validate(o) {
  if (!o || typeof o !== 'object') return 'not an object';
  if (o.v !== 1) return 'v: must be 1';
  if (!Array.isArray(o.schedule)) return 'schedule: must be a list';
  if (o.schedule.length > LIM.nSched) return `schedule: more than ${LIM.nSched}`;
  for (let i = 0; i < o.schedule.length; i++) {
    const s = o.schedule[i], at = `schedule[${i}]`;
    if (s.everyMin !== undefined) { if (!inRange(s.everyMin, [60, LIM.everyH[1] * 60]) || s.everyMin % 60) return `${at}.everyMin: 60–${LIM.everyH[1] * 60}, whole hours`; }
    else {
      if (!(s.days === 'all' || (Array.isArray(s.days) && s.days.length && s.days.every(d => inRange(d, [0, 6]))))) return `${at}.days: "all" or 0–6`;
      if (!Array.isArray(s.at) || !s.at.length || s.at.length > 4 || !s.at.every(t => /^\d\d:\d\d$/.test(t) && +t.slice(0, 2) < 24 && +t.slice(3) < 60)) return `${at}.at: 1–4 times HH:MM`;
    }
    if (!(s.pots === 'dry' || (Array.isArray(s.pots) && s.pots.length && s.pots.every(c => inRange(c, [0, N_CH - 1]))))) return `${at}.pots: "dry" or ch 0–15`;
  }
  if (!o.pots || typeof o.pots !== 'object' || Array.isArray(o.pots)) return 'pots: must be an object';
  for (const k of Object.keys(o.pots)) {
    const ch = +k, s = o.pots[k], at = `pots.${k}`;
    if (!inRange(ch, [0, N_CH - 1])) return `${at}: ch 0–15`;
    if (s.thr !== undefined && !inRange(s.thr, LIM.thr)) return `${at}.thr: 1–99`;
    if (s.dose !== undefined && !inRange(s.dose, LIM.dose)) return `${at}.dose: 10–2000`;
    if (s.max !== undefined && !inRange(s.max, LIM.max)) return `${at}.max: 1–4`;
    if (s.on !== undefined && typeof s.on !== 'boolean') return `${at}.on: true/false`;
    for (const f of Object.keys(s)) if (!['thr', 'dose', 'max', 'on'].includes(f)) return `${at}.${f}: unknown key`;
  }
  if (!Array.isArray(o.modifiers)) return 'modifiers: must be a list';
  if (o.modifiers.length > LIM.nMod) return `modifiers: more than ${LIM.nMod}`;
  for (let i = 0; i < o.modifiers.length; i++) {
    const m = o.modifiers[i], at = `modifiers[${i}]`;
    if (!m.if || !m.then) return `${at}: needs if and then`;
    if (!['temp', 'rain', 'tank'].includes(m.if.k)) return `${at}.if.k: temp · rain · tank`;
    if (!['>', '<', '>=', '<='].includes(m.if.op)) return `${at}.if.op: > < >= <=`;
    const r = { temp: LIM.temp, rain: LIM.rain, tank: LIM.tank }[m.if.k];
    if (!inRange(m.if.v, r)) return `${at}.if.v: ${r[0]}–${r[1]}`;
    if (m.if.k === 'rain' && m.if.h !== undefined && !inRange(m.if.h, LIM.rainH)) return `${at}.if.h: 1–48`;
    if (m.then.skip !== undefined && m.then.skip !== true) return `${at}.then.skip: true`;
    if (m.then.dosePct !== undefined && !inRange(m.then.dosePct, LIM.dosePct)) return `${at}.then.dosePct: −80…100`;
    if ((m.then.skip === undefined) === (m.then.dosePct === undefined)) return `${at}.then: exactly one of skip / dosePct`;
  }
  if (!o.limits || typeof o.limits !== 'object') return 'limits: must be an object';
  if (o.limits.dailyML !== undefined && !inRange(o.limits.dailyML, [LIM.dailyL[0] * 1000, LIM.dailyL[1] * 1000])) return 'limits.dailyML: 1000–20000';
  return null;
}
// A fresh object in canonical shape and key order (deterministic JSON).
function normalize(o) {
  const r = empty();
  (o.schedule || []).forEach(s => {
    const pots = s.pots === 'dry' ? 'dry' : [...new Set(s.pots)].sort((a, b) => a - b);
    if (s.everyMin) r.schedule.push({ everyMin: s.everyMin, pots });
    else r.schedule.push({ days: s.days === 'all' ? 'all' : [...new Set(s.days)].sort((a, b) => a - b), at: [...new Set(s.at)].sort(), pots });
  });
  Object.keys(o.pots || {}).map(Number).sort((a, b) => a - b).forEach(ch => {
    const s = o.pots[ch], t = {};
    if (s.thr !== undefined) t.thr = s.thr; if (s.dose !== undefined) t.dose = s.dose; if (s.max !== undefined) t.max = s.max; if (s.on !== undefined) t.on = s.on;
    if (Object.keys(t).length) r.pots[ch] = t;
  });
  (o.modifiers || []).forEach(m => {
    const c = { k: m.if.k, op: m.if.op, v: m.if.v }; if (m.if.k === 'rain') c.h = m.if.h === undefined ? DEF.rainH : m.if.h;
    r.modifiers.push({ if: c, then: m.then.skip ? { skip: true } : { dosePct: m.then.dosePct } });
  });
  r.limits.dailyML = (o.limits && o.limits.dailyML !== undefined) ? o.limits.dailyML : DEF.dailyML;
  return r;
}
function compile(rules) { return JSON.stringify(normalize(rules)); }
// fromJSON(string|object) → { ok, rules, error }
function fromJSON(src) {
  let o = src;
  if (typeof src === 'string') { try { o = JSON.parse(src); } catch (e) { return { ok: false, error: 'not JSON: ' + e.message }; } }
  const err = validate(o);
  return err ? { ok: false, error: err } : { ok: true, rules: normalize(o) };
}
// FNV-1a 32-bit over the string's bytes (the canonical JSON is ASCII) → 8 hex digits.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
function isEmpty(rules) { const r = normalize(rules); return !r.schedule.length && !Object.keys(r.pots).length && !r.modifiers.length && r.limits.dailyML === DEF.dailyML; }

// ---------------------------------------------------------------- planning (shared by mock, preview, and the firmware spec)
function cmp(a, op, b) { return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b; }
// roundPlan(rules, ctx) → { skip: null | modifier that skipped, dosePct, fired:[modifier], unknown:[k] }
// ctx = { tempC: number|null, rainPct: number|null, rainH: number, tankPct: number }. Unknown input → the condition is false.
function roundPlan(rules, ctx) {
  const r = rules ? normalize(rules) : empty();
  let dosePct = 0, skip = null; const fired = [], unknown = [];
  for (const m of r.modifiers) {
    const c = m.if; let val = null;
    if (c.k === 'temp') val = (ctx.tempC === null || ctx.tempC === undefined) ? null : ctx.tempC;
    else if (c.k === 'rain') val = (ctx.rainPct === null || ctx.rainPct === undefined || (ctx.rainH || 0) < c.h) ? null : ctx.rainPct;
    else val = ctx.tankPct;
    if (val === null) { unknown.push(c.k); continue; }
    if (!cmp(val, c.op, c.v)) continue;
    fired.push(m);
    if (m.then.skip) { if (!skip) skip = m; }
    else dosePct += m.then.dosePct;
  }
  dosePct = Math.max(LIM.dosePct[0], Math.min(LIM.dosePct[1], dosePct));
  return { skip, dosePct, fired, unknown };
}
function scaleDose(doseML, dosePct) { return Math.max(10, Math.round(doseML * (100 + dosePct) / 100 / 10) * 10); }
// Which pots a schedule (or a manual run: sched = null) considers, ascending ch.
function targets(sched, nFitted) {
  const all = []; for (let i = 0; i < nFitted; i++) all.push(i);
  if (!sched || sched.pots === 'dry') return all;
  return sched.pots.filter(c => c < nFitted);
}
// Schedule triggers in (fromMs, toMs]: [{ t, sched, idx }] in time order. lastRoundMs feeds the interval form.
function triggersBetween(rules, fromMs, toMs, lastRoundMs) {
  const r = rules ? normalize(rules) : empty(); const out = [];
  r.schedule.forEach((s, idx) => {
    if (s.everyMin) {
      let t = (lastRoundMs || fromMs) + s.everyMin * 60e3;
      while (t <= toMs) { if (t > fromMs) out.push({ t, sched: s, idx }); t += s.everyMin * 60e3; }
      return;
    }
    const d0 = new Date(fromMs); d0.setHours(0, 0, 0, 0);
    for (let day = d0.getTime(); day <= toMs; day += 86400e3) {
      const dt = new Date(day);
      if (s.days !== 'all' && !s.days.includes(dt.getDay())) continue;
      s.at.forEach(hm => { const t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), +hm.slice(0, 2), +hm.slice(3)).getTime(); if (t > fromMs && t <= toMs) out.push({ t, sched: s, idx }); });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- simulation ("what the board will do")
// world = { pots:[{ i, name, pct, sState(1 ok,2 implausible,3 uncal), thrPct, doseML, max, todayML, senEn, valEn, ratePctPerH }],
//           nFitted, tempC|null, rainPct|null, rainH, tankLeft, tankFull, reserve, minTempC, mlPerSec, maxPumpMs, autoMin, lastRoundMs, havePCA }
// → { rounds:[{ t, trigger, skip, dosePct, watered:[{i,name,ml,sec}], skipped:[{i,name,reason}], refused:[{i,name,reason}], tankLeft }], notes:[], nextT }
function simulate(rules, world, fromMs, hours) {
  const r = rules ? normalize(rules) : empty();
  const toMs = fromMs + (hours || 24) * 3600e3;
  const pots = world.pots.map(p => Object.assign({}, p));
  let tank = world.tankLeft, dayTotal = pots.reduce((s, p) => s + (p.todayML || 0), 0);
  let trig;
  if (r.schedule.length) trig = triggersBetween(r, fromMs, toMs, world.lastRoundMs).map(x => ({ t: x.t, sched: x.sched, trigger: 'rule' }));
  else if (world.autoMin > 0) { trig = []; let t = (world.lastRoundMs || fromMs) + world.autoMin * 60e3; while (t <= toMs) { if (t > fromMs) trig.push({ t, sched: null, trigger: 'auto' }); t += world.autoMin * 60e3; } }
  else trig = [];
  const notes = [];
  if (!trig.length) notes.push(r.schedule.length ? 'No round falls in the next 24 h.' : 'No schedule and auto is off — nothing runs on its own. Add a line like "every day at 07:00: water pots that are dry".');
  const rounds = []; let lastT = fromMs; let dayMark = new Date(fromMs).getDate();
  for (const tr of trig) {
    const hoursPassed = (tr.t - lastT) / 3600e3; lastT = tr.t;
    pots.forEach(p => { p.pct = Math.max(0, p.pct - (p.ratePctPerH || 0) * hoursPassed); });
    if (new Date(tr.t).getDate() !== dayMark) { dayMark = new Date(tr.t).getDate(); pots.forEach(p => p.todayML = 0); dayTotal = 0; }
    const plan = roundPlan(r, { tempC: world.tempC, rainPct: world.rainPct, rainH: world.rainH, tankPct: 100 * tank / world.tankFull });
    const round = { t: tr.t, trigger: tr.trigger, skip: plan.skip, dosePct: plan.dosePct, fired: plan.fired, watered: [], skipped: [], refused: [], tankLeft: tank };
    rounds.push(round);
    if (plan.skip) continue;
    for (const i of targets(tr.sched, world.nFitted)) {
      const p = pots[i]; const name = p.name || `Pot ${i + 1}`;
      const refuse = (reason) => (['wet', 'off'].includes(reason) ? round.skipped : round.refused).push({ i, name, reason });
      if (!p.valEn || !p.senEn) { refuse('off'); continue; }
      if (!world.havePCA) { refuse('nopca'); continue; }
      if (p.sState === 3) { refuse('uncal'); continue; }
      if (p.sState === 2) { refuse('implausible'); continue; }
      if (p.pct >= p.thrPct) { refuse('wet'); continue; }
      if (world.tempC !== null && world.tempC !== undefined && world.tempC < world.minTempC) { refuse('cold'); continue; }
      let ml = scaleDose(p.doseML, plan.dosePct);
      const maxMs = world.maxPumpMs || 90000;
      if (1000 * ml / world.mlPerSec > maxMs) ml = Math.floor(maxMs / 1000 * world.mlPerSec / 10) * 10;
      if (tank - ml < world.reserve) { refuse('tank'); continue; }
      if ((p.todayML || 0) + ml > (p.max || DEF.max) * p.doseML) { refuse('budget'); continue; }
      if (dayTotal + ml > r.limits.dailyML) { refuse('budget'); continue; }
      tank -= ml; p.todayML = (p.todayML || 0) + ml; dayTotal += ml; p.pct = Math.min(95, p.pct + 45);
      round.watered.push({ i, name, ml, sec: +(ml / world.mlPerSec).toFixed(1), pct: Math.round(p.pct - 45) });
    }
    round.tankLeft = tank;
  }
  if (world.rainPct === null || world.rainPct === undefined) { if (r.modifiers.some(m => m.if.k === 'rain')) notes.push('No weather forecast has reached the controller yet — rain rules stay off until the app pushes one.'); }
  if (world.tempC === null || world.tempC === undefined) { if (r.modifiers.some(m => m.if.k === 'temp')) notes.push('No temperature reading — temperature rules stay off.'); }
  return { rounds, notes, nextT: trig.length ? trig[0].t : null };
}

const Rules = { LIM, DEF, DAY, DOSE_WORD, empty, parse, toText, validate, normalize, compile, fromJSON, hash, isEmpty,
  roundPlan, scaleDose, targets, triggersBetween, simulate, tokenize, hhmm };
if (typeof module !== 'undefined' && module.exports) module.exports = Rules; else root.Rules = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
