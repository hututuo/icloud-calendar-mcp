import { CalDAV } from './caldav.js';
import { AppError, fail, keys, string, object, windowBounds } from './common.js';
import { resourceView, expandResource, parseCalendar, creationFingerprint, createICS, updateICS, sha256, canonical } from './ical.js';

const str = { type: 'string' };
const calendar = { ...str, description: 'calendar_id returned by list_calendars.' };
const range = { start: { ...str, description: 'Inclusive ISO timestamp with explicit UTC offset.' }, end: { ...str, description: 'Exclusive ISO timestamp. Maximum 366-day range.' } };
const eventFields = {
  summary: { ...str, maxLength: 2000 }, description: { ...str, maxLength: 20000 }, location: { ...str, maxLength: 2000 },
  start: { ...str, description: 'ISO timestamp with UTC offset, or YYYY-MM-DD for all-day.' },
  end: { ...str, description: 'Exclusive end; same format as start.' }, all_day: { type: 'boolean' },
  timezone: { type: 'string', enum: ['Asia/Shanghai', 'UTC'], default: 'Asia/Shanghai' },
  reminders: { type: 'array', items: { type: 'integer', minimum: -525600, maximum: 525600 }, maxItems: 10, description: 'Signed minutes relative to event start: positive = before, 0 = at start, negative = after (for example -5 means 5 minutes after start). [] removes reminders. Omit on update to preserve every existing VALARM.' },
  recurrence: { type: ['string', 'null'], description: 'RFC5545 RRULE with finite COUNT or UNTIL. Creation only; recurring schedule changes are rejected.' }
};
function tool(name, description, properties, required, readOnly = true) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: true } };
}
export const TOOLS = [
  tool('list_calendars', 'List the authenticated owner’s iCloud calendars inside the configured scope. Requires server-side credential and owner setup.', {}, []),
  tool('list_events', 'Read bounded event instances, including supported recurring exceptions, reminders and participants. Floating/all-day times use Asia/Shanghai for range interpretation. Returns resources with ETags for safe edits. Narrow the range if a safety limit is reached.', { calendar_id: calendar, ...range }, ['calendar_id', 'start', 'end']),
  tool('freebusy', 'Compute merged busy UTC intervals without titles from the selected calendar. Transparent and cancelled events are excluded. This reflects calendar events, not invitations awaiting user action.', { calendar_id: calendar, ...range }, ['calendar_id', 'start', 'end']),
  tool('create_event', 'Create an iCloud event with optional DISPLAY reminders. Writes are disabled until WRITE_ENABLED=true is securely configured. Always reuse the same caller-chosen uid for retries; mismatched content under that UID is rejected. No attendee invitations are created.', { calendar_id: calendar, uid: { ...str, description: 'Stable unique UID for this exact intended event; reuse it on retry.' }, ...eventFields }, ['calendar_id', 'uid', 'summary', 'start', 'end', 'all_day'], false),
  tool('update_event', 'Patch an existing event in place using expected_etag. Omitted fields, attendees, alarms, Apple properties and timezone components are preserved. Recurring events require scope=series, affect only the master, and preserve detached exceptions; time/rule changes and single-occurrence edits are rejected. Existing participant events are rejected to avoid unintended scheduling messages.', { calendar_id: calendar, event_id: { ...str, description: 'Resource URL returned by list_events.' }, expected_etag: str, scope: { type: 'string', enum: ['event', 'series'] }, patch: { type: 'object', properties: eventFields, additionalProperties: false } }, ['calendar_id', 'event_id', 'expected_etag', 'scope', 'patch'], false)
];
function requireWrite(env) { if (env.WRITE_ENABLED !== 'true') fail('WRITES_DISABLED', 'Writes are disabled. Complete read-only acceptance and explicit runtime write authorization first.', 403); }
function exactMatches(resources, uid) { return resources.filter(resource => parseCalendar(resource.ics).uid === uid); }
function strongEtag(value) { return typeof value === 'string' && /^"[^"\r\n]*"$/.test(value); }
function etagDiagnostic(expected, get, report = null, reportAttempted = false, reportError = null) {
  return { stage: 'update_etag', expected_has: Boolean(expected), expected_weak: /^W\//.test(expected || ''), get_has: Boolean(get), get_matches: get === expected, get_weak: /^W\//.test(get || ''), report_attempted: reportAttempted, report_has: Boolean(report?.etag), report_matches: Boolean(report && report.etag === expected), report_weak: /^W\//.test(report?.etag || ''), report_error: reportError };
}
function timezoneContext(stage, writeConfirmed, fn) {
  try { return fn(); }
  catch (error) {
    if (error instanceof AppError && error.code === 'UNSUPPORTED_TIMEZONE') {
      const diagnostic = { ...error.diagnostic, stage, write_confirmed: writeConfirmed };
      if (writeConfirmed) throw new AppError('WRITE_RESULT_UNKNOWN', 'iCloud accepted the write, but its returned timezone could not be validated. Do not create another UID or blindly repeat the write.', 502, { ...diagnostic, cause: 'UNSUPPORTED_TIMEZONE' });
      error.diagnostic = diagnostic;
    }
    throw error;
  }
}
export async function callTool(name, args, env, fetcher) {
  const spec = TOOLS.find(tool => tool.name === name);
  if (!spec) fail('UNKNOWN_TOOL', 'Unknown tool. Deletion and single-occurrence writes are intentionally unavailable.');
  keys(args, Object.keys(spec.inputSchema.properties));
  if (name === 'create_event' || name === 'update_event') requireWrite(env);
  const dav = new CalDAV(env, fetcher);
  if (name === 'list_calendars') return { calendars: await dav.calendars() };
  string(args.calendar_id, 'calendar_id', 8192);
  if (name === 'list_events' || name === 'freebusy') {
    const range = windowBounds(args.start, args.end);
    const calendar = await dav.calendar(args.calendar_id);
    const resources = await dav.query(calendar, range);
    const instances = []; const budget = { remaining: 100000 };
    for (const resource of resources) {
      instances.push(...timezoneContext('event_query_read', false, () => expandResource(resource, range, budget)));
      if (instances.length > 2000) fail('TOO_MANY_OCCURRENCES', 'Too many event instances. Use a narrower date range.', 413);
    }
    instances.sort((a, b) => a.start.utc.localeCompare(b.start.utc));
    if (name === 'list_events') return { calendar_id: calendar.calendar_id, interpretation_timezone: 'Asia/Shanghai', instances, truncated: false };
    const intervals = instances.filter(event => event.transparency !== 'TRANSPARENT' && event.status !== 'CANCELLED').map(event => [Math.max(range.from, Date.parse(event.start.utc)), Math.min(range.to, Date.parse(event.end.utc))]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    const busy = [];
    for (const [start, end] of intervals) {
      const last = busy.at(-1); if (last && start <= last[1]) last[1] = Math.max(last[1], end); else busy.push([start, end]);
    }
    return { calendar_id: calendar.calendar_id, busy: busy.map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() })), truncated: false };
  }
  if (name === 'create_event') {
    const { calendar_id, ...data } = args;
    const fingerprint = await sha256(canonical(data));
    const ics = createICS(data, fingerprint); // Validate before making any data request.
    const calendar = await dav.calendar(calendar_id, true);
    const existing = exactMatches(await dav.query(calendar, null, data.uid), data.uid);
    if (existing.length > 1) fail('DUPLICATE_UID', 'Multiple events share that UID. Resolve the duplicate before writing.', 409);
    if (existing.length) {
      if (creationFingerprint(existing[0].ics) !== fingerprint) fail('UID_CONFLICT', 'That UID already exists with a different creation request. It was not changed.', 409);
      return { created: false, idempotent_replay: true, event: timezoneContext('create_existing_uid', false, () => resourceView(existing[0])) };
    }
    const eventId = new URL(`dot-${await sha256(data.uid)}.ics`, calendar.calendar_id.endsWith('/') ? calendar.calendar_id : `${calendar.calendar_id}/`).href;
    try { await dav.put(calendar, eventId, ics, null); }
    catch (error) {
      if (error.code !== 'ETAG_CONFLICT') throw error;
      let current;
      try { current = await dav.get(calendar, eventId); }
      catch (readError) {
        if (readError.code === 'EVENT_NOT_FOUND') fail('CREATE_PRECONDITION_FAILED', 'iCloud rejected the create-only PUT but the exact resource was absent. No unconditional write was attempted. Keep the same UID and investigate before retrying.', 409);
        throw readError;
      }
      if (parseCalendar(current.ics).uid !== data.uid || creationFingerprint(current.ics) !== fingerprint) fail('UID_CONFLICT', 'The deterministic event resource already exists with different content.', 409);
      return { created: false, idempotent_replay: true, event: timezoneContext('create_existing_resource', false, () => resourceView(current)) };
    }
    let stored;
    try { stored = await dav.get(calendar, eventId); } catch { fail('WRITE_RESULT_UNKNOWN', 'iCloud accepted the write but read-back did not complete. Reuse this same UID to check before retrying.', 502); }
    if (parseCalendar(stored.ics).uid !== data.uid) fail('WRITE_RESULT_UNKNOWN', 'The write could not be matched to its UID. Read it again before any retry.', 502);
    return { created: true, event: timezoneContext('create_readback', true, () => resourceView(stored)) };
  }
  const calendar = await dav.calendar(args.calendar_id, true);
  string(args.event_id, 'event_id', 8192); string(args.expected_etag, 'expected_etag', 256); object(args.patch, 'patch');
  if (!['event', 'series'].includes(args.scope)) fail('INVALID_ARGUMENT', 'Use scope=event or scope=series. Single-occurrence editing is unsupported.');
  if (!strongEtag(args.expected_etag)) throw new AppError('ETAG_REQUIRED', 'A valid strong ETag from a fresh read is required.', 409, etagDiagnostic(args.expected_etag, null));
  let current = await dav.get(calendar, args.event_id);
  if (!strongEtag(current.etag) || current.etag !== args.expected_etag) {
    const getResource = current, getEtag = current.etag;
    let verification = etagDiagnostic(args.expected_etag, getEtag, null, true);
    try { current = await dav.multiget(calendar, args.event_id); }
    catch (error) {
      if (!['READ_FAILED', 'INCOMPLETE_DAV_RESPONSE'].includes(error.code)) throw error;
      verification = { ...verification, report_error: error.code, report_diagnostic: error.diagnostic, scan_attempted: true };
      // Some nodes do not supply a complete multiget response. Use the same
      // complete, bounded collection query already used for UID discovery.
      // Its entire result must pass integrity limits before selecting our URL.
      let resources;
      try { resources = await dav.query(calendar, null, null); }
      catch (scanError) {
        if (!['QUERY_FAILED', 'INCOMPLETE_DAV_RESPONSE', 'TOO_MANY_EVENTS', 'UPSTREAM_TOO_LARGE'].includes(scanError.code)) throw scanError;
        throw new AppError('ETAG_CONFLICT', 'The bounded fallback could not verify the complete current event. No update was attempted.', 409, { ...verification, scan_error: scanError.code, scan_diagnostic: scanError.diagnostic });
      }
      const matches = resources.filter(resource => resource.event_id === getResource.event_id);
      if (matches.length !== 1) throw new AppError('ETAG_CONFLICT', 'The exact event was missing or duplicated in the bounded fallback. No update was attempted.', 409, { ...verification, scan_error: 'EXACT_RESOURCE_REQUIRED' });
      current = matches[0];
    }
    verification = { ...verification, ...etagDiagnostic(args.expected_etag, getEtag, current, true, verification.report_error), scan_attempted: verification.scan_attempted === true };
    if (!strongEtag(current.etag) || current.etag !== args.expected_etag) throw new AppError('ETAG_CONFLICT', 'The event changed or has no strong ETag. Read it again before retrying.', 409, verification);
    if (parseCalendar(current.ics).uid !== parseCalendar(getResource.ics).uid) throw new AppError('ETAG_CONFLICT', 'The resource UID changed between reads. No update was attempted.', 409, { ...verification, scan_error: 'UID_MISMATCH' });
  }
  const parsed = parseCalendar(current.ics);
  if (parsed.components.some(component => component.hasProperty('attendee') || component.hasProperty('organizer'))) fail('SCHEDULING_SIDE_EFFECT_BLOCKED', 'This event has participants or an organizer. Editing it could send scheduling messages, so this version leaves it unchanged.', 403);
  const next = updateICS(current.ics, args.patch, args.scope);
  timezoneContext('update_validation', false, () => resourceView({ ...current, ics: next })); // Validate before mutating the upstream.
  await dav.put(calendar, current.event_id, next, current.etag);
  let stored;
  try { stored = await dav.get(calendar, current.event_id); } catch { fail('WRITE_RESULT_UNKNOWN', 'iCloud accepted the update but read-back did not complete. Read the event again before retrying.', 502); }
  return { updated: true, event: timezoneContext('update_readback', true, () => resourceView(stored)) };
}
