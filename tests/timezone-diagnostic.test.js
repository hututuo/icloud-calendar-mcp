import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { createICS, canonical, sha256, parseCalendar } from '../src/ical.js';
import { AppError, safeError } from '../src/common.js';
import { ENV, CALENDAR, eventData, mockDAV } from './helpers.js';
const unsupported = ics => ics.replace('TZNAME:CST', 'TZNAME:CST\r\nRRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=11,12,13,14,15,16,17;BYDAY=SU');
const args = { calendar_id: CALENDAR, ...eventData };

test('unrelated unsupported timezone does not block structural UID preflight', async () => {
  const other = unsupported(createICS({ ...eventData, uid: 'unrelated-event' }, 'fixture'));
  assert.equal(parseCalendar(other).uid, 'unrelated-event');
  const mock = mockDAV({ 'unrelated.ics': other });
  const result = await callTool('create_event', args, ENV, mock.fetch);
  assert.equal(result.created, true); assert.equal(mock.writes, 1);
});
test('same-UID unsupported timezone remains blocked with precise existing-UID stage and no write', async () => {
  const mock = mockDAV({ 'existing.ics': unsupported(createICS(eventData, await sha256(canonical(eventData)))) });
  await assert.rejects(() => callTool('create_event', args, ENV, mock.fetch), error => {
    const safe = safeError(error); assert.equal(safe.code, 'UNSUPPORTED_TIMEZONE');
    assert.equal(safe.diagnostic.stage, 'create_existing_uid'); assert.equal(safe.diagnostic.write_confirmed, false);
    assert.equal(safe.diagnostic.tzid, 'Asia/Shanghai'); assert.deepEqual(safe.diagnostic.parts, { BYMONTH: [9], BYMONTHDAY: [11, 12, 13, 14, 15, 16, 17], BYDAY: ['SU'] }); return true;
  });
  assert.equal(mock.writes, 0);
});
test('server timezone rewrite after successful PUT reports write confirmed but validation unknown', async () => {
  const mock = mockDAV(); const fetcher = async (url, options) => {
    const response = await mock.fetch(url, options);
    if (options.method === 'GET' && response.status === 200) return new Response(unsupported(await response.text()), { headers: response.headers });
    return response;
  };
  await assert.rejects(() => callTool('create_event', args, ENV, fetcher), error => {
    const safe = safeError(error); assert.equal(safe.code, 'WRITE_RESULT_UNKNOWN'); assert.equal(safe.diagnostic.stage, 'create_readback'); assert.equal(safe.diagnostic.write_confirmed, true); assert.equal(safe.diagnostic.cause, 'UNSUPPORTED_TIMEZONE'); return true;
  });
  assert.equal(mock.writes, 1); assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1);
});
test('time-range read and target update retain timezone validation without leaking event data', async () => {
  const mock = mockDAV({ 'event.ics': unsupported(createICS({ ...eventData, summary: 'private-event-title', location: 'private-location' }, 'fixture')) });
  const requests = [
    ['list_events', { calendar_id: CALENDAR, start: '2026-10-13T00:00:00Z', end: '2026-10-14T00:00:00Z' }, 'event_query_read'],
    ['update_event', { calendar_id: CALENDAR, event_id: CALENDAR + 'event.ics', expected_etag: '"v1"', scope: 'event', patch: { reminders: [10, 0, -5] } }, 'update_validation']
  ];
  for (const [name, arguments_, stage] of requests) await assert.rejects(() => callTool(name, arguments_, ENV, mock.fetch), error => {
    const safe = safeError(error); assert.equal(safe.code, 'UNSUPPORTED_TIMEZONE'); assert.equal(safe.diagnostic.stage, stage);
    for (const value of ['private-event-title', 'private-location', CALENDAR, ENV.CALDAV_PASSWORD]) assert.ok(!JSON.stringify(safe).includes(value)); return true;
  });
  assert.equal(mock.writes, 0);
});
test('timezone diagnostics expose only known enum and numeric rule values', () => {
  const safe = safeError(new AppError('UNSUPPORTED_TIMEZONE', 'Safe', 422, { tzid: 'https://private.invalid?secret', stage: 'private-stage', frequency: 'private-frequency', interval: 'private-value', parts: { PRIVATE: ['private-data'], BYDAY: ['private-data'], BYMONTH: [9] }, headers: 'secret' }));
  assert.equal(safe.diagnostic.tzid, null); assert.equal(safe.diagnostic.frequency, null); assert.deepEqual(safe.diagnostic.parts, { BYMONTH: [9], BYDAY: [null] }); assert.ok(!JSON.stringify(safe).includes('private'));
});
