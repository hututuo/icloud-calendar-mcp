import ICAL from 'ical.js';
import { AppError, fail, string, boundedText, keys, validISO } from './common.js';
import { safeOccurrences } from './recurrence.js';

export const SHANGHAI_ICS = 'BEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nBEGIN:STANDARD\r\nDTSTART:19920101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nTZNAME:CST\r\nEND:STANDARD\r\nEND:VTIMEZONE';
const shanghaiZone = new ICAL.Timezone({ component: new ICAL.Component(ICAL.parse(SHANGHAI_ICS)), tzid: 'Asia/Shanghai' });
ICAL.TimezoneService.register('Asia/Shanghai', shanghaiZone);
const TIME_KEYS = ['start', 'end', 'all_day', 'timezone'];
const PATCH_KEYS = ['summary', 'description', 'location', ...TIME_KEYS, 'reminders', 'recurrence'];
const MAX_OCCURRENCES = 2000;
const MAX_ITERATIONS = 20000;

export function parseCalendar(ics) {
  try {
    const root = new ICAL.Component(ICAL.parse(ics));
    if (root.name !== 'vcalendar') fail('INVALID_ICS', 'Expected one VCALENDAR resource.', 502);
    function validateRaw(component) {
      for (const prop of component.getAllProperties()) {
        const raw = prop.toJSON();
        if (raw[2] === 'date' || raw[2] === 'date-time') for (const value of raw.slice(3)) {
          const candidate = raw[2] === 'date' ? `${value}T00:00:00Z` : value.endsWith('Z') ? value : `${value}Z`;
          if (!validISO(candidate)) fail('INVALID_ICS', 'The resource contains a nonexistent date or invalid time.', 502);
        }
        if (raw[2] === 'recur') for (const value of raw.slice(3)) if (value.until) {
          const until = value.until;
          const candidate = until.length === 10 ? `${until}T00:00:00Z` : until.endsWith('Z') ? until : `${until}Z`;
          if (!validISO(candidate)) fail('INVALID_ICS', 'The resource contains an invalid recurrence UNTIL.', 502);
        }
      }
      for (const child of component.getAllSubcomponents()) validateRaw(child);
    }
    validateRaw(root);
    const components = root.getAllSubcomponents('vevent');
    const masters = components.filter(c => !c.hasProperty('recurrence-id'));
    if (masters.length !== 1 || components.length > 200) fail('UNSUPPORTED_ICS', 'Expected one event series per calendar resource.', 422);
    const uid = masters[0].getFirstPropertyValue('uid');
    if (!uid || components.some(c => c.getFirstPropertyValue('uid') !== uid)) fail('INVALID_ICS', 'Calendar resource has missing or inconsistent UIDs.', 502);
    return { root, master: masters[0], components, uid };
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail('INVALID_ICS', 'The calendar resource could not be safely parsed.', 502);
  }
}
function boundedWeekWindow(rule, observance) {
  const parts = rule.parts, days = parts.BYMONTHDAY;
  if (rule.freq !== 'YEARLY' || rule.interval !== 1 || rule.count != null || Object.keys(parts).some(key => !['BYMONTH', 'BYMONTHDAY', 'BYDAY'].includes(key))) return false;
  if (parts.BYMONTH?.length !== 1 || !Number.isInteger(parts.BYMONTH[0]) || parts.BYMONTH[0] < 1 || parts.BYMONTH[0] > 12 || parts.BYDAY?.length !== 1 || !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(parts.BYDAY[0])) return false;
  if (!Array.isArray(days) || days.length !== 7 || days.some(day => !Number.isInteger(day) || day < 1 || day > 28)) return false;
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.some((day, index) => day !== sorted[0] + index)) return false;
  const start = observance.getFirstPropertyValue('dtstart'), until = rule.until;
  if (!start || start.isDate || start.zone !== ICAL.Timezone.localTimezone || !until || until.isDate || until.zone !== ICAL.Timezone.utcTimezone || until.year < start.year || until.year - start.year > 200) return false;
  if (start.month !== parts.BYMONTH[0] || !days.includes(start.day) || ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay()] !== parts.BYDAY[0]) return false;
  // Exactly seven consecutive valid dates contain the chosen weekday exactly
  // once every year. The finite <=200-year horizon bounds the pinned iterator;
  // no impossible intersection, skipped-year search or unbounded rule is added.
  return true;
}
function validateZones(root) {
  // ical.js also expands RRULE inside VTIMEZONE. Keep that independent iterator
  // on a conservative, guaranteed-progress grammar before any UTC conversion.
  for (const zone of root.getAllSubcomponents('vtimezone')) for (const observance of zone.getAllSubcomponents()) {
    if (!['standard', 'daylight'].includes(observance.name)) fail('UNSUPPORTED_TIMEZONE', 'Unsupported timezone observance.', 422);
    for (const prop of observance.getAllProperties('rrule')) {
      const rule = prop.getFirstValue();
      const parts = rule.parts;
      if (!boundedWeekWindow(rule, observance) && (rule.freq !== 'YEARLY' || rule.interval !== 1 || Object.keys(parts).some(key => !['BYMONTH', 'BYMONTHDAY', 'BYDAY'].includes(key)) || (parts.BYMONTH && (parts.BYMONTH.length !== 1 || parts.BYMONTH[0] < 1 || parts.BYMONTH[0] > 12)) || (parts.BYMONTHDAY && (parts.BYMONTHDAY.length !== 1 || parts.BYMONTHDAY[0] === 0 || Math.abs(parts.BYMONTHDAY[0]) > 28)) || (parts.BYDAY && (parts.BYDAY.length !== 1 || !/^[+-]?[1-4](MO|TU|WE|TH|FR|SA|SU)$/.test(parts.BYDAY[0]))) || (parts.BYDAY && parts.BYMONTHDAY) || ((parts.BYDAY || parts.BYMONTHDAY) && !parts.BYMONTH))) {
        throw new AppError('UNSUPPORTED_TIMEZONE', 'The embedded timezone has an unsupported recurrence definition.', 422, {
          tzid: zone.getFirstPropertyValue('tzid'), observance: observance.name, frequency: rule.freq, interval: rule.interval,
          count: rule.count, until: rule.until?.toString() ?? null, parts
        });
      }
      const dtstart = observance.getFirstPropertyValue('dtstart');
      if (!dtstart || (!parts.BYDAY && !parts.BYMONTHDAY && dtstart.day > 28)) fail('UNSUPPORTED_TIMEZONE', 'The timezone transition needs a safer explicit recurrence definition.', 422);
    }
  }
  function walk(component) {
    if (component.name === 'vtimezone') return;
    for (const prop of component.getAllProperties()) {
      const tzid = prop.getParameter('tzid');
      if (!tzid || tzid === 'UTC') continue;
      if (!root.getTimeZoneByID(tzid) && tzid !== 'Asia/Shanghai') fail('UNSUPPORTED_TIMEZONE', 'The event references a timezone without its VTIMEZONE definition. It was not treated as UTC.', 422);
      if (tzid === 'Asia/Shanghai' && !root.getTimeZoneByID(tzid)) {
        for (const value of prop.getValues()) if (value.year && value.year < 1992) fail('UNSUPPORTED_TIMEZONE', 'Historical Shanghai dates require an embedded VTIMEZONE definition.', 422);
      }
    }
    for (const child of component.getAllSubcomponents()) walk(child);
  }
  walk(root);
}
function zoneOffsetAt(zone, epoch) {
  // Pinned ical.js 2.2.1 exposes UTC transition records in Timezone.changes.
  // Its local-time offset lookup chooses the second fall-fold occurrence and
  // cannot be used for UTC-to-local round trips. Read the UTC transition table
  // after the conservative observance-rule checks above have run.
  zone.utcOffset(ICAL.Time.fromJSDate(new Date(epoch), true));
  const changes = zone.changes;
  if (!changes?.length) fail('UNSUPPORTED_TIMEZONE', 'The embedded timezone has no usable transition records.', 422);
  let offset = changes[0].prevUtcOffset;
  for (const change of changes) {
    const at = Date.UTC(change.year, change.month - 1, change.day, change.hour, change.minute, change.second);
    if (at > epoch) break;
    offset = change.utcOffset;
  }
  return offset;
}
const resolvedEpochs = new WeakMap();
function timeFromMillis(epoch, zone) {
  if (zone === ICAL.Timezone.utcTimezone) return ICAL.Time.fromJSDate(new Date(epoch), true);
  if (zone === ICAL.Timezone.localTimezone) zone = shanghaiZone;
  const date = new Date(epoch + zoneOffsetAt(zone, epoch) * 1000);
  const time = new ICAL.Time({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() }, zone);
  resolvedEpochs.set(time, epoch);
  return time;
}
function timeMillis(time) {
  if (resolvedEpochs.has(time)) return resolvedEpochs.get(time);
  let zone = time.zone;
  if (time.isDate || zone === ICAL.Timezone.localTimezone) {
    if (time.year < 1992) fail('UNSUPPORTED_TIMEZONE', 'Historical floating or all-day times require an explicit timezone definition.', 422);
    zone = shanghaiZone;
  }
  const local = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  if (zone === ICAL.Timezone.utcTimezone) return local;
  zoneOffsetAt(zone, local);
  const offsets = new Set(zone.changes.flatMap(change => [change.utcOffset, change.prevUtcOffset]));
  const matches = [];
  for (const offset of offsets) { const candidate = local - offset * 1000; if (zoneOffsetAt(zone, candidate) === offset) matches.push(candidate); }
  if (!matches.length) fail('NONEXISTENT_LOCAL_TIME', 'The event falls in a timezone clock-change gap.', 422);
  return Math.min(...matches);
}
function actualEnd(event, start = event.startDate, recurringMaster = false) {
  if (event.component.hasProperty('duration')) {
    const duration = event.duration;
    if (duration.isNegative) fail('INVALID_ICS', 'Negative event duration is invalid.', 502);
    const nominal = start.clone(); nominal.addDuration(new ICAL.Duration({ weeks: duration.weeks, days: duration.days }));
    const seconds = duration.hours * 3600 + duration.minutes * 60 + duration.seconds;
    if (start.isDate) {
      if (seconds) fail('INVALID_ICS', 'All-day duration must use whole days or weeks.', 502);
      return nominal;
    }
    return timeFromMillis(timeMillis(nominal) + seconds * 1000, start.zone);
  }
  if (recurringMaster && event.component.hasProperty('dtend') && !start.isDate) {
    const duration = timeMillis(event.endDate) - timeMillis(event.startDate);
    return timeFromMillis(timeMillis(start) + duration, start.zone);
  }
  return recurringMaster ? start.clone() : event.endDate;
}
function timeView(time) {
  return { value: time.toString(), all_day: time.isDate, timezone: time.isDate ? null : (time.zone?.tzid === 'floating' ? 'Asia/Shanghai (floating-time interpretation)' : time.zone?.tzid), utc: new Date(timeMillis(time)).toISOString() };
}
function alarmViews(component) {
  return component.getAllSubcomponents('valarm').map(alarm => {
    const prop = alarm.getFirstProperty('trigger');
    return { action: alarm.getFirstPropertyValue('action'), trigger: prop?.getFirstValue()?.toString() || null, related: prop?.getParameter('related') || 'START', description: alarm.getFirstPropertyValue('description') || null };
  });
}
function participantViews(component) {
  return component.getAllProperties('attendee').map(prop => ({ address: prop.getFirstValue(), name: prop.getParameter('cn') || null, participation: prop.getParameter('partstat') || null, role: prop.getParameter('role') || null }));
}
function componentView(event) {
  if (!event.startDate || !event.endDate || event.startDate.isDate !== event.endDate.isDate || timeMillis(actualEnd(event)) < timeMillis(event.startDate)) fail('INVALID_ICS', 'The event has missing, mismatched, or negative-duration dates.', 502);
  return { uid: event.uid, summary: event.summary || '', description: event.description || '', location: event.location || '', start: timeView(event.startDate), end: timeView(actualEnd(event)), status: event.component.getFirstPropertyValue('status') || null, transparency: event.component.getFirstPropertyValue('transp') || 'OPAQUE', reminders: alarmViews(event.component), participants: participantViews(event.component), organizer: event.component.getFirstPropertyValue('organizer') || null };
}
export function resourceView(resource) {
  const parsed = parseCalendar(resource.ics); validateZones(parsed.root);
  const event = new ICAL.Event(parsed.master, { strictExceptions: true });
  return { event_id: resource.event_id, etag: resource.etag, ...componentView(event), recurring: event.isRecurring(), recurrence: parsed.master.getAllProperties('rrule').map(p => p.getFirstValue().toString()), recurrence_exceptions: parsed.components.length - 1 };
}
export function expandResource(resource, range, budget) {
  const parsed = parseCalendar(resource.ics); validateZones(parsed.root);
  const event = new ICAL.Event(parsed.master, { strictExceptions: true });
  componentView(event);
  const output = []; const seen = new Set();
  function add(item, start, end, recurrenceId = null) {
    componentView(item);
    if (item.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    const from = timeMillis(start), to = timeMillis(end);
    if (!(from < range.to && (to > range.from || (to === from && from >= range.from)))) return;
    const key = recurrenceId ? `${recurrenceId.isDate ? 'D:' : 'T:'}${timeMillis(recurrenceId)}` : 'single'; if (seen.has(key)) return; seen.add(key);
    output.push({ ...componentView(item), event_id: resource.event_id, etag: resource.etag, start: timeView(start), end: timeView(end), recurrence_id: recurrenceId?.toString() || null, recurring: event.isRecurring() });
    if (output.length > MAX_OCCURRENCES) fail('TOO_MANY_OCCURRENCES', 'Too many recurring instances. Use a narrower date range.', 413);
  }
  if (!event.isRecurring()) add(event, event.startDate, actualEnd(event));
  else {
    if (parsed.components.some(c => c.getFirstProperty('recurrence-id')?.getParameter('range'))) fail('UNSUPPORTED_RECURRENCE', 'RANGE=THISANDFUTURE recurrence expansion is not supported in this version.', 422);
    const occurrenceKey = value => `${value.isDate ? 'D:' : 'T:'}${timeMillis(value)}`;
    const exceptionMap = new Map(parsed.components.filter(c => c.hasProperty('recurrence-id')).map(c => { const e = new ICAL.Event(c); return [occurrenceKey(e.recurrenceId), e]; }));
    for (const occurrence of safeOccurrences(event, range, timeMillis, budget)) {
      const exception = exceptionMap.get(occurrenceKey(occurrence));
      if (exception) add(exception, exception.startDate, actualEnd(exception), occurrence);
      else {
        let end;
        if (event.startDate.isDate) { end = occurrence.clone(); end.addDuration(event.duration); }
        else end = actualEnd(event, occurrence, true);
        add(event, occurrence, end, occurrence);
      }
    }
    // Detached exceptions can be moved into this window from outside the master window.
    for (const component of parsed.components.filter(c => c.hasProperty('recurrence-id'))) {
      const exception = new ICAL.Event(component);
      add(exception, exception.startDate, actualEnd(exception), exception.recurrenceId);
    }
  }
  return output;
}
function validateDate(value, name) {
  string(value, name, 10);
  if (!validISO(`${value}T00:00:00Z`)) fail('INVALID_ARGUMENT', `${name} requires a valid YYYY-MM-DD date.`);
  return ICAL.Time.fromDateString(value);
}
function dateTime(value, zone) {
  if (!validISO(value) || value.includes('.')) fail('INVALID_ARGUMENT', 'Timed events require ISO timestamps with explicit offsets and second precision.');
  const date = new Date(value);
  if (date.getUTCFullYear() < 1992 || date.getUTCFullYear() > 2100) fail('INVALID_ARGUMENT', 'New timed event dates must be between 1992 and 2100.');
  const utc = ICAL.Time.fromJSDate(date, true);
  return zone === 'UTC' ? utc : utc.convertToZone(shanghaiZone);
}
function setTimes(root, master, data) {
  if (typeof data.all_day !== 'boolean') fail('INVALID_ARGUMENT', 'all_day must be explicitly true or false when setting event times.');
  let start, end;
  if (data.all_day) {
    if (data.timezone && !['Asia/Shanghai', 'UTC'].includes(data.timezone)) fail('INVALID_ARGUMENT', 'All-day dates do not carry a timezone.');
    start = validateDate(data.start, 'start'); end = validateDate(data.end, 'end');
    if (start.year < 1992 || end.year > 2100) fail('INVALID_ARGUMENT', 'New all-day dates must be between 1992 and 2100.');
  } else {
    const zone = data.timezone || 'Asia/Shanghai';
    if (!['Asia/Shanghai', 'UTC'].includes(zone)) fail('UNSUPPORTED_TIMEZONE', 'New event times support Asia/Shanghai or UTC; existing embedded timezones are preserved.');
    start = dateTime(data.start, zone); end = dateTime(data.end, zone);
    if (zone === 'Asia/Shanghai' && !root.getTimeZoneByID(zone)) root.addSubcomponent(new ICAL.Component(ICAL.parse(SHANGHAI_ICS)));
  }
  if (timeMillis(end) <= timeMillis(start)) fail('INVALID_ARGUMENT', 'Event end must be after its start; all-day end dates are exclusive.');
  master.removeAllProperties('duration');
  const event = new ICAL.Event(master); event.startDate = start; event.endDate = end;
}
function setReminders(master, reminders) {
  if (!Array.isArray(reminders) || reminders.length > 10) fail('INVALID_ARGUMENT', 'reminders must be an array of at most 10 signed minute offsets.');
  if (reminders.some(value => !Number.isInteger(value) || value < -525600 || value > 525600)) fail('INVALID_ARGUMENT', 'Each reminder must be an integer from -525600 to 525600: positive before start, zero at start, negative after start.');
  master.removeAllSubcomponents('valarm');
  for (const minutes of [...new Set(reminders)]) {
    const alarm = new ICAL.Component('valarm');
    alarm.addPropertyWithValue('action', 'DISPLAY'); alarm.addPropertyWithValue('description', 'Calendar reminder');
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-minutes * 60));
    alarm.addPropertyWithValue('x-wr-alarmuid', crypto.randomUUID());
    master.addSubcomponent(alarm);
  }
}
function setRecurrence(master, value) {
  master.removeAllProperties('rrule');
  if (value === null || value === '') return;
  string(value, 'recurrence', 1000);
  // Keep recurrence creation deliberately narrow; preserve richer existing rules untouched.
  if (!/^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;(?:INTERVAL=[1-9]\d{0,2}|COUNT=[1-9]\d{0,3}|UNTIL=\d{8}(?:T\d{6}Z)?|BYDAY=(?:[+-]?[1-5])?(?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:[+-]?[1-5])?(?:MO|TU|WE|TH|FR|SA|SU))*|BYMONTHDAY=-?[1-9]\d?(?:,-?[1-9]\d?)*|BYMONTH=(?:[1-9]|1[0-2])(?:,(?:[1-9]|1[0-2]))*))*$/.test(value) || (value.includes('COUNT=') && value.includes('UNTIL='))) fail('INVALID_ARGUMENT', 'Use a supported RFC5545 DAILY, WEEKLY, MONTHLY or YEARLY rule with valid COUNT or UNTIL.');
  const until = /(?:^|;)UNTIL=(\d{8})(?:T(\d{6})Z)?(?:;|$)/.exec(value);
  if (until) { const d = until[1], t = until[2] || '000000'; if (!validISO(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}Z`)) fail('INVALID_ARGUMENT', 'UNTIL must contain a real date and time.'); }
  const parts = value.split(';').map(part => part.split('=')[0]); if (new Set(parts).size !== parts.length) fail('INVALID_ARGUMENT', 'Duplicate recurrence rule fields are not allowed.');
  if (!value.includes('COUNT=') && !value.includes('UNTIL=')) fail('INVALID_ARGUMENT', 'New or replaced recurrence rules require COUNT or UNTIL.');
  let recur; try { recur = ICAL.Recur.fromString(value); } catch { fail('INVALID_ARGUMENT', 'Invalid recurrence rule.'); }
  if (recur.parts.BYMONTHDAY?.some(day => day === 0 || day < -31 || day > 31)) fail('INVALID_ARGUMENT', 'Invalid BYMONTHDAY value.');
  const start = master.getFirstPropertyValue('dtstart');
  if (recur.until && recur.until.isDate !== start.isDate) fail('INVALID_ARGUMENT', 'UNTIL must be a date for all-day events, and a UTC datetime for timed events.');
  master.addPropertyWithValue('rrule', recur);
  const event = new ICAL.Event(master);
  safeOccurrences(event, { to: timeMillis(start) + 86400000 }, timeMillis, { remaining: 4 });
}
function editFields(root, master, data) {
  for (const key of ['summary', 'description', 'location']) if (Object.hasOwn(data, key)) master.updatePropertyWithValue(key, boundedText(data[key], key, key === 'description' ? 20000 : 2000));
  if (TIME_KEYS.some(key => Object.hasOwn(data, key))) setTimes(root, master, data);
  if (Object.hasOwn(data, 'reminders')) setReminders(master, data.reminders);
  if (Object.hasOwn(data, 'recurrence')) setRecurrence(master, data.recurrence);
}
export function createICS(data, fingerprint) {
  keys(data, ['uid', ...PATCH_KEYS]); string(data.uid, 'uid', 200);
  if (!/^[A-Za-z0-9._@-]+$/.test(data.uid)) fail('INVALID_ARGUMENT', 'uid may contain only letters, digits, dot, underscore, @ and hyphen.');
  string(data.summary, 'summary', 2000);
  if (!Object.hasOwn(data, 'start') || !Object.hasOwn(data, 'end')) fail('INVALID_ARGUMENT', 'start and end are required.');
  const root = new ICAL.Component('vcalendar'); root.addPropertyWithValue('version', '2.0'); root.addPropertyWithValue('prodid', '-//Private iCloud Calendar Site//EN'); root.addPropertyWithValue('calscale', 'GREGORIAN');
  const master = new ICAL.Component('vevent'); root.addSubcomponent(master); master.addPropertyWithValue('uid', data.uid);
  master.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true)); master.addPropertyWithValue('sequence', 0); master.addPropertyWithValue('x-private-icloud-create-fingerprint', fingerprint);
  editFields(root, master, data);
  return root.toString();
}
export function updateICS(ics, patch, scope) {
  keys(patch, PATCH_KEYS); if (!Object.keys(patch).length) fail('INVALID_ARGUMENT', 'patch cannot be empty.');
  if (!['event', 'series'].includes(scope)) fail('INVALID_ARGUMENT', 'scope must be event or series; occurrence edits are unsupported.');
  const { root, master, components } = parseCalendar(ics);
  const recurring = master.hasProperty('rrule') || master.hasProperty('rdate') || components.length > 1;
  if (recurring && scope !== 'series') fail('SERIES_SCOPE_REQUIRED', 'This is a recurring event. Explicit scope=series is required; occurrence edits are not implemented.');
  if (recurring && [...TIME_KEYS, 'recurrence'].some(key => Object.hasOwn(patch, key))) fail('UNSUPPORTED_RECURRENCE_EDIT', 'Changing a recurring series schedule is not supported in this version. Existing rules and exceptions were left unchanged.');
  editFields(root, master, patch);
  // Series metadata/reminder edits apply to the master only; detached exceptions remain unchanged.
  master.updatePropertyWithValue('sequence', Number(master.getFirstPropertyValue('sequence') || 0) + 1);
  master.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true)); master.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(), true));
  return root.toString();
}
export function creationFingerprint(ics) { return parseCalendar(ics).master.getFirstPropertyValue('x-private-icloud-create-fingerprint'); }
export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
