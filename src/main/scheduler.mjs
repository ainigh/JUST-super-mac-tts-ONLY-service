// Things to do later: the one thing kept in this app rather than in Tool Mac Tool Run, asked of the
// Clock ("@clock") the way Peter is asked. The model sets a task for in so many minutes, or for a
// date and time; when it's due, the character shows itself and the model is given the task, as
// written then, to do now. As many as wanted, each cancellable, kept on disk so they survive a
// restart (one that came due while the app was closed is done as it opens, saying it's late).

import fs from 'node:fs';
import path from 'node:path';

const MAX_DELAY = 2 ** 31 - 1; // setTimeout's limit (about 24.8 days): longer waits are re-armed
const MAX_TASKS = 100;
const STALE_MS = 24 * 60 * 60 * 1000; // missed by more than a day: dropped, not done

export class Scheduler {
  /**
   * @param {object} o
   * @param {string|null} o.file - where they're kept (null: in memory only)
   * @param {(task: object, late: boolean) => void} o.onFire
   * @param {(t: object) => void} [o.onChange]
   * @param {() => number} [o.now]
   */
  constructor({ file = null, onFire, onChange = () => {}, now = Date.now }) {
    this.file = file;
    this.onFire = onFire;
    this.onChange = onChange;
    this.now = now;
    this.tasks = [];
    this.timers = new Map();
    this.next = 1;
  }

  /** Reads what was kept, arms the timers, and does (late) what came due meanwhile. */
  start() {
    let kept = [];
    try {
      if (this.file) kept = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* nothing kept yet */
    }
    const now = this.now();
    this.tasks = (Array.isArray(kept.tasks) ? kept.tasks : []).filter((t) => t && t.id && Number.isFinite(t.due) && t.task && now - t.due < STALE_MS);
    this.next = Math.max(Number(kept.next) || 1, ...this.tasks.map((t) => Number(String(t.id).slice(1)) + 1 || 1));
    for (const t of this.tasks) this.arm(t);
    this.save();
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  list() {
    return [...this.tasks].sort((a, b) => a.due - b.due);
  }

  /** Adds a task: { task, due } (due: ms since 1970). Returns it, or throws with what's wrong. */
  add({ task, due }) {
    const text = String(task ?? '').trim();
    if (!text) throw new Error('Say what to do then (task).');
    if (!Number.isFinite(due)) throw new Error('Say when: in_minutes, or at (a date and time).');
    if (due < this.now() - 60_000) throw new Error(`That time (${longTime(due, this.now())}) has passed.`);
    if (this.tasks.length >= MAX_TASKS) throw new Error(`There are already ${MAX_TASKS} things scheduled: cancel some first.`);
    const t = { id: `s${this.next++}`, task: text.slice(0, 1000), due: Math.max(due, this.now()), created: this.now() };
    this.tasks.push(t);
    this.arm(t);
    this.save();
    this.onChange({ type: 'added', task: t });
    return t;
  }

  /** Cancels one ("s3"), or all ("all"): those cancelled. */
  cancel(id) {
    const key = String(id ?? '').trim().toLowerCase();
    const hit = key === 'all' ? [...this.tasks] : this.tasks.filter((t) => t.id === key || t.id === `s${key}`);
    for (const t of hit) {
      clearTimeout(this.timers.get(t.id));
      this.timers.delete(t.id);
    }
    this.tasks = this.tasks.filter((t) => !hit.includes(t));
    if (hit.length) {
      this.save();
      this.onChange({ type: 'cancelled', ids: hit.map((t) => t.id) });
    }
    return hit;
  }

  arm(t) {
    clearTimeout(this.timers.get(t.id));
    const wait = t.due - this.now();
    if (wait <= 0) {
      // Due already (it came due while the app was closed): done as soon as the app is up.
      this.timers.set(t.id, setTimeout(() => this.fire(t, this.now() - t.due > 60_000), 0));
      return;
    }
    this.timers.set(t.id, setTimeout(() => (t.due - this.now() > 1000 ? this.arm(t) : this.fire(t, false)), Math.min(wait, MAX_DELAY)));
  }

  fire(t, late) {
    this.timers.delete(t.id);
    if (!this.tasks.includes(t)) return;
    this.tasks = this.tasks.filter((x) => x !== t);
    this.save();
    this.onChange({ type: 'fired', task: t });
    this.onFire(t, late);
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ next: this.next, tasks: this.tasks }, null, 2));
    } catch (err) {
      console.error('Super Face: the schedule was not saved:', err.message);
    }
  }
}

// ---------------------------------------------------------------- when

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * When a task is due, from what the model wrote: `in_minutes` (a number), or `at` (local time):
 * "2026-10-24 17:30", "2026-10-24T17:30", "17:30", "5:30 pm", "tomorrow 9am", "friday 8:00",
 * "24 October 17:30". A time of day alone is today, or tomorrow once it has passed.
 * @returns {number} ms since 1970, or NaN
 */
export function dueFrom({ in_minutes, minutes, in_seconds, at, when } = {}, now = Date.now()) {
  const m = in_minutes ?? minutes;
  if (m !== undefined && m !== null && m !== '') {
    const n = Number(m);
    return Number.isFinite(n) && n >= 0 ? now + n * 60_000 : NaN;
  }
  if (in_seconds !== undefined && in_seconds !== null && in_seconds !== '') {
    const n = Number(in_seconds);
    return Number.isFinite(n) && n >= 0 ? now + n * 1000 : NaN;
  }
  return parseAt(at ?? when, now);
}

export function parseAt(input, now = Date.now()) {
  if (input === undefined || input === null) return NaN;
  if (typeof input === 'number') return input > 1e11 ? input : NaN;
  let s = String(input).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return NaN;
  const rel = s.match(/^in (\d+(?:\.\d+)?) ?(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0] === 's' ? 1000 : rel[2][0] === 'm' ? 60_000 : rel[2][0] === 'h' ? 3_600_000 : 86_400_000;
    return now + n * unit;
  }
  // ISO with an offset or Z: exactly that moment.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s.toUpperCase());

  const base = new Date(now);
  let date = null; // [y, m, d]
  let explicitDate = false;
  const take = (re, fn) => {
    const hit = s.match(re);
    if (!hit) return false;
    fn(hit);
    s = (s.slice(0, hit.index) + ' ' + s.slice(hit.index + hit[0].length)).trim();
    return true;
  };
  take(/\b(\d{4})-(\d{1,2})-(\d{1,2})(?=t|\b)/, (h) => ((date = [+h[1], +h[2] - 1, +h[3]]), (explicitDate = true)));
  if (!date) take(/\btoday\b/, () => ((date = [base.getFullYear(), base.getMonth(), base.getDate()]), (explicitDate = true)));
  if (!date)
    take(/\btomorrow\b/, () => {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      date = [d.getFullYear(), d.getMonth(), d.getDate()];
      explicitDate = true;
    });
  if (!date)
    take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS.map((x) => x.slice(0, 3)).join('|')})[a-z]*\\.?(?: (\\d{4}))?\\b`), (h) => {
      date = [h[3] ? +h[3] : base.getFullYear(), MONTHS.findIndex((x) => x.startsWith(h[2])), +h[1]];
      explicitDate = !!h[3];
    });
  if (!date)
    take(new RegExp(`\\b(${MONTHS.map((x) => x.slice(0, 3)).join('|')})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`), (h) => {
      date = [h[3] ? +h[3] : base.getFullYear(), MONTHS.findIndex((x) => x.startsWith(h[1])), +h[2]];
      explicitDate = !!h[3];
    });
  let weekday = -1;
  if (!date) take(new RegExp(`\\b(?:next |this |on )?(${DAYS.map((x) => x.slice(0, 3)).join('|')})[a-z]*\\b`), (h) => (weekday = DAYS.findIndex((x) => x.startsWith(h[1]))));

  let time = null; // [h, m, s]
  s = s.replace(/^t/, '').replace(/\bat\b/g, ' ').trim();
  take(/\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))? ?(a\.?m\.?|p\.?m\.?)(?=\s|$)/, (h) => {
    let hour = +h[1] % 12;
    if (h[4].startsWith('p')) hour += 12;
    time = [hour, +(h[2] || 0), +(h[3] || 0)];
  });
  if (!time) take(/\b(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\b/, (h) => (time = [+h[1], +h[2], +(h[3] || 0)]));
  if (!time) take(/\bnoon|midday\b/, () => (time = [12, 0, 0]));
  if (!time) take(/\bmidnight\b/, () => (time = [0, 0, 0]));
  if (!time && (date || weekday !== -1)) take(/\bmorning\b/, () => (time = [9, 0, 0]));
  if (!time && (date || weekday !== -1)) take(/\bevening\b/, () => (time = [19, 0, 0]));
  if (s.replace(/[,. ]/g, '')) return NaN; // words it didn't understand
  if (!date && weekday === -1 && !time) return NaN;
  if (time && (time[0] > 23 || time[1] > 59 || time[2] > 59)) return NaN;
  const [hh, mm, ss] = time || [9, 0, 0];

  if (weekday !== -1) {
    const d = new Date(now);
    const ahead = (weekday - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + ahead);
    d.setHours(hh, mm, ss, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  if (date) {
    if (date[1] < 0) return NaN;
    const d = new Date(date[0], date[1], date[2], hh, mm, ss, 0);
    if (d.getDate() !== date[2]) return NaN; // 31 February
    // "24 October" with no year, already past this year: next year.
    if (!explicitDate && d.getTime() < now - 60_000) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  const d = new Date(now);
  d.setHours(hh, mm, ss, 0);
  if (d.getTime() <= now - 30_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** "Friday 24 October at 17:30" (with "today" / "tomorrow" when it is). */
export function longTime(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (same(d, n)) return `today at ${time}`;
  if (same(d, tomorrow)) return `tomorrow at ${time}`;
  const day = `${DAYS[d.getDay()][0].toUpperCase()}${DAYS[d.getDay()].slice(1)} ${d.getDate()} ${MONTHS[d.getMonth()][0].toUpperCase()}${MONTHS[d.getMonth()].slice(1)}`;
  return `${day}${d.getFullYear() !== n.getFullYear() ? ` ${d.getFullYear()}` : ''} at ${time}`;
}

/** "in 45 minutes", "in 2 hours and 5 minutes", "in 3 days". */
export function fromNow(ms, now = Date.now()) {
  const min = Math.round((ms - now) / 60_000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return `in ${h} hour${h === 1 ? '' : 's'}${m ? ` and ${m} minute${m === 1 ? '' : 's'}` : ''}`;
  const d = Math.round(h / 24);
  return `in ${d} days`;
}

// ---------------------------------------------------------------- the Clock: the schedule, asked in words

/** What the Clock takes, as the model is shown it (and is answered with when it isn't understood). */
export const CLOCK_FORMS = `Set something for later
- in minutes: {how many minutes from now}
- task: {what to do then, as an instruction to yourself with every detail}
(instead of "in minutes": - at: {a local date and time, like 2026-10-24 17:30, 17:30, tomorrow 9:00, friday 8:00})

what's scheduled

cancel {its id, like s3, or all}`;

const LABELS = {
  in_minutes: ['inminutes', 'minutes', 'in', 'inmins', 'mins', 'fromnow', 'after'],
  at: ['at', 'when', 'time', 'date', 'on', 'due'],
  task: ['task', 'what', 'todo', 'reminder', 'text', 'do', 'then'],
};

/** The labeled lines of a message ("- in minutes: 20"), by what each is for: { in_minutes, at, task }. */
function labeled(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-*]?\s*([A-Za-z][A-Za-z _-]{0,20}?)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/[^a-z]/g, '');
    const field = Object.keys(LABELS).find((k) => LABELS[k].includes(key));
    if (field && m[2].trim()) out[field] = m[2].trim();
  }
  return out;
}

/** When, from what was written after "in minutes" ("20", "20 minutes", "2 hours") or "at". */
function dueOf({ in_minutes, at }, now) {
  if (in_minutes !== undefined) {
    const v = String(in_minutes).trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(v)) return now + Number(v) * 60_000;
    return parseAt(v.startsWith('in ') ? v : `in ${v}`, now);
  }
  return parseAt(at, now);
}

/**
 * What the Clock says to a message from the model: something set for later, what's scheduled, or
 * something cancelled; or, when it can't tell, what it takes.
 */
export function clockSay(scheduler, text, now = Date.now()) {
  const t = String(text ?? '').trim();
  const plain = t.toLowerCase().replace(/[.!?]+$/, '').trim();
  const takes = `The Clock takes:\n\n${CLOCK_FORMS}`;
  if (/^(what'?s|what is|what are|list( the)?|show( me)?)?\s*(scheduled|schedules?|reminders?|coming up|on the clock)$/.test(plain) || plain === 'list') {
    const all = scheduler.list();
    if (!all.length) return 'Nothing is scheduled.';
    return all.map((x) => `${x.id}: ${longTime(x.due, now)} (${fromNow(x.due, now)}): ${x.task}`).join('\n');
  }
  const cancel = plain.match(/^(?:cancel|unschedule|remove|delete|drop)\s+(.+)$/);
  if (cancel) {
    const ids = cancel[1].match(/\ball\b/) ? ['all'] : cancel[1].match(/\bs?\d+\b/g) || [];
    if (!ids.length) return `Say which: its id (like s3), or all. "what's scheduled" lists them.`;
    const gone = ids.flatMap((x) => scheduler.cancel(x));
    if (!gone.length) return `Nothing scheduled has the id ${ids.join(', ')}. "what's scheduled" lists what there is.`;
    return `Cancelled ${gone.map((x) => `${x.id} (${x.task})`).join(', ')}.`;
  }
  let want = labeled(t);
  if (!want.task) {
    // In a line: "in 20 minutes: remind the user…", "at friday 8:00: check the build".
    const rel = t.match(/^in\s+(\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?))[:,]?\s+([\s\S]+)$/i);
    const abs = t.match(/^(?:at|on)\s+(.+?)(?:,|:\s|\s+-\s+)\s*([\s\S]+)$/i);
    if (rel) want = { in_minutes: rel[1], task: rel[2] };
    else if (abs) want = { at: abs[1], task: abs[2] };
  }
  if (!want.task && want.in_minutes === undefined && want.at === undefined) return `I didn't understand that. ${takes}`;
  if (!want.task) return `Say what to do then (task). ${takes}`;
  if (want.in_minutes === undefined && want.at === undefined) return `Say when: in minutes, or at. ${takes}`;
  const due = dueOf(want, now);
  if (!Number.isFinite(due)) {
    return `I couldn't read when ("${want.in_minutes ?? want.at}"). Give in minutes (a number), or at, as a local date and time like 2026-10-24 17:30, or 17:30.`;
  }
  try {
    const x = scheduler.add({ task: want.task, due });
    return `Scheduled ${x.id} for ${longTime(x.due, now)} (${fromNow(x.due, now)}): ${x.task}`;
  } catch (err) {
    return err.message;
  }
}
