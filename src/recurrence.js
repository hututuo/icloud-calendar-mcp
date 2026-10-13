import ICAL from 'ical.js';
import { fail } from './common.js';
const DAY = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const SUPPORTED_PARTS = ['BYDAY', 'BYMONTHDAY', 'BYMONTH'];
function civil(time) { return Date.UTC(time.year, time.month - 1, time.day); }
function makeTime(start, day) {
  const date = new Date(day);
  return new ICAL.Time({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: start.hour, minute: start.minute, second: start.second, isDate: start.isDate }, start.zone);
}
function matchingDay(day, start, rule) {
  const date = new Date(day); const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, monthday = date.getUTCDate(), weekday = date.getUTCDay();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = Math.round((day - civil(start)) / DAY), months = (year - start.year) * 12 + month - start.month;
  const interval = rule.interval || 1;
  if (rule.freq === 'DAILY' && days % interval) return false;
  if (rule.freq === 'MONTHLY' && months % interval) return false;
  if (rule.freq === 'YEARLY' && (year - start.year) % interval) return false;
  if (rule.freq === 'WEEKLY') {
    const wkst = (rule.wkst || 2) - 1;
    const weekStart = day - ((weekday - wkst + 7) % 7) * DAY;
    const startDay = civil(start); const startWeek = startDay - ((new Date(startDay).getUTCDay() - wkst + 7) % 7) * DAY;
    if (Math.round((weekStart - startWeek) / (7 * DAY)) % interval) return false;
  }
  const bymonth = rule.parts.BYMONTH, bymonthday = rule.parts.BYMONTHDAY, byday = rule.parts.BYDAY;
  if (bymonth && !bymonth.includes(month)) return false;
  if (bymonthday && !bymonthday.some(value => (value > 0 ? value : lastDay + value + 1) === monthday)) return false;
  if (byday && !byday.some(value => {
    const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value);
    if (WEEKDAYS[weekday] !== match[2]) return false;
    if (!match[1]) return true;
    const ordinal = Number(match[1]); return ordinal > 0 ? Math.floor((monthday - 1) / 7) + 1 === ordinal : -(Math.floor((lastDay - monthday) / 7) + 1) === ordinal;
  })) return false;
  if (rule.freq === 'WEEKLY' && !byday && weekday !== new Date(civil(start)).getUTCDay()) return false;
  if (rule.freq === 'MONTHLY' && !byday && !bymonthday && monthday !== start.day) return false;
  if (rule.freq === 'YEARLY') {
    if (!bymonth && month !== start.month) return false;
    if (!byday && !bymonthday && monthday !== start.day) return false;
  }
  return true;
}
function checkRule(rule) {
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) || Object.keys(rule.parts).some(key => !SUPPORTED_PARTS.includes(key))) fail('UNSUPPORTED_RECURRENCE', 'This recurrence uses unsupported frequency or BY fields; no partial result was returned.', 422);
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 366 || (rule.count && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 10000))) fail('UNSUPPORTED_RECURRENCE', 'The recurrence interval or count exceeds supported limits.', 422);
  if (rule.parts.BYMONTH?.some(value => !Number.isInteger(value) || value < 1 || value > 12) || rule.parts.BYMONTHDAY?.some(value => !Number.isInteger(value) || value === 0 || Math.abs(value) > 31)) fail('UNSUPPORTED_RECURRENCE', 'The recurrence contains invalid month or day values.', 422);
  for (const value of rule.parts.BYDAY || []) {
    const match = /^([+-]?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value);
    if (!match || (match[1] && !['MONTHLY', 'YEARLY'].includes(rule.freq)) || (match[1] && rule.freq === 'YEARLY' && !rule.parts.BYMONTH)) fail('UNSUPPORTED_RECURRENCE', 'Ordinal BYDAY is supported only for monthly rules or yearly rules with BYMONTH.', 422);
  }
  if (rule.freq === 'WEEKLY' && rule.parts.BYMONTHDAY) fail('UNSUPPORTED_RECURRENCE', 'BYMONTHDAY is invalid for weekly recurrences.', 422);
  if (rule.freq === 'YEARLY' && !rule.parts.BYMONTH && (rule.parts.BYDAY || rule.parts.BYMONTHDAY)) fail('UNSUPPORTED_RECURRENCE', 'Yearly BYDAY/BYMONTHDAY requires explicit BYMONTH in this version.', 422);
}
export function safeOccurrences(event, range, millis, budget = { remaining: 100000 }) {
  const component = event.component; const rules = component.getAllProperties('rrule');
  if (rules.length > 1 || component.hasProperty('exrule')) fail('UNSUPPORTED_RECURRENCE', 'Multiple RRULEs and EXRULE are not supported in this version.', 422);
  const start = event.startDate; const values = [start];
  const key = time => `${time.isDate ? 'D:' : 'T:'}${millis(time)}`;
  if (rules.length) {
    const rule = rules[0].getFirstValue(); checkRule(rule);
    if (!matchingDay(civil(start), start, rule)) fail('UNSUPPORTED_RECURRENCE', 'DTSTART does not match its recurrence rule; no ambiguous expansion was returned.', 422);
    let count = 0;
    const lastScanDay = Math.min(range.to + 2 * DAY, rule.until ? millis(rule.until) + 2 * DAY : Infinity);
    for (let day = civil(start); day <= lastScanDay; day += DAY) {
      if (--budget.remaining < 0) fail('RECURRENCE_LIMIT', 'Recurrence expansion exceeded the bounded scan budget. Narrow the scope or use a more recent series.', 413);
      if (!matchingDay(day, start, rule)) continue;
      const time = makeTime(start, day);
      let candidateMillis;
      try { candidateMillis = millis(time); } catch (error) { if (error.code === 'NONEXISTENT_LOCAL_TIME') continue; throw error; }
      if (rule.until && candidateMillis > millis(rule.until)) break;
      count++; if (rule.count && count > rule.count) break;
      if (candidateMillis >= range.to) break;
      values.push(time);
    }
  }
  for (const prop of component.getAllProperties('rdate')) for (const value of prop.getValues()) {
    if (!(value instanceof ICAL.Time)) fail('UNSUPPORTED_RECURRENCE', 'RDATE periods are not supported in this version.', 422);
    values.push(value);
  }
  const excluded = new Set(component.getAllProperties('exdate').flatMap(prop => prop.getValues()).map(key));
  const unique = new Map(values.map(value => [key(value), value]));
  return [...unique].filter(([id]) => !excluded.has(id)).map(([, value]) => value).sort((a, b) => millis(a) - millis(b));
}
