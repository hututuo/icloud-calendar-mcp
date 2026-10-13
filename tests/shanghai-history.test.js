import test from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { fixture, ENV, CALENDAR, eventData, mockDAV } from './helpers.js';
import { parseCalendar, resourceView, updateICS, createICS, canonical, sha256 } from '../src/ical.js';
import { callTool } from '../src/tools.js';
const source = await fixture('shanghai-historical-dst.ics');
const resource = ics => ({ ics, event_id: CALENDAR + 'event.ics', etag: '"v1"' });
const at = stamp => source.replace('20261013T231300', stamp).replace('20261013T232800', stamp);

test('observed Apple Shanghai historical rule reads 2026 as UTC+8', () => {
  const view = resourceView(resource(source));
  assert.equal(view.start.utc, '2026-10-13T15:13:00.000Z'); assert.equal(view.end.utc, '2026-10-13T15:28:00.000Z');
  assert.deepEqual(view.reminders.map(alarm => alarm.trigger), ['-PT10M', 'PT0S']);
});
test('Shanghai historical winter/summer and 1988/1991 transition offsets are exact', () => {
  const cases = [
    ['19880115T120000', '1988-01-15T04:00:00.000Z'],
    ['19880715T120000', '1988-07-15T03:00:00.000Z'],
    ['19880417T015900', '1988-04-16T17:59:00.000Z'],
    ['19880417T030000', '1988-04-16T18:00:00.000Z'],
    ['19880911T005900', '1988-09-10T15:59:00.000Z'],
    ['19880911T020000', '1988-09-10T18:00:00.000Z'],
    ['19910414T030000', '1991-04-13T18:00:00.000Z'],
    ['19910915T020000', '1991-09-14T18:00:00.000Z'],
    ['19920715T120000', '1992-07-15T04:00:00.000Z']
  ];
  for (const [local, utc] of cases) assert.equal(resourceView(resource(at(local))).start.utc, utc, local);
  assert.throws(() => resourceView(resource(at('19880417T023000'))), error => error.code === 'NONEXISTENT_LOCAL_TIME');
  assert.equal(resourceView(resource(at('19910915T013000'))).start.utc, '1991-09-14T16:30:00.000Z');
});
test('signed reminder update preserves historical VTIMEZONE and exact event time', () => {
  const before = parseCalendar(source).root.getFirstSubcomponent('vtimezone').toJSON();
  const updated = updateICS(source, { reminders: [10, 0, -5] }, 'event');
  assert.deepEqual(parseCalendar(updated).root.getFirstSubcomponent('vtimezone').toJSON(), before);
  const view = resourceView(resource(updated)); assert.equal(view.start.utc, '2026-10-13T15:13:00.000Z');
  assert.deepEqual(view.reminders.map(alarm => alarm.trigger), ['-PT10M', 'PT0S', 'PT5M']);
});
test('same-UID server-rewritten timezone replay and ETag reminder update need no second create', async () => {
  const generated = createICS(eventData, await sha256(canonical(eventData)));
  const zone = parseCalendar(source).root.getFirstSubcomponent('vtimezone').toString();
  const stored = generated.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/, zone);
  const mock = mockDAV({ 'server-event.ics': stored });
  const replay = await callTool('create_event', { calendar_id: CALENDAR, ...eventData }, ENV, mock.fetch);
  assert.equal(replay.idempotent_replay, true); assert.equal(mock.writes, 0);
  const result = await callTool('update_event', { calendar_id: CALENDAR, event_id: replay.event.event_id, expected_etag: replay.event.etag, scope: 'event', patch: { reminders: [10, 0, -5] } }, ENV, mock.fetch);
  assert.equal(mock.writes, 1); assert.deepEqual(result.event.reminders.map(alarm => alarm.trigger), ['-PT10M', 'PT0S', 'PT5M']);
  assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-Match'], '"v1"');
  assert.deepEqual(parseCalendar(mock.events.get(replay.event.event_id).ics).root.getFirstSubcomponent('vtimezone').toJSON(), parseCalendar(stored).root.getFirstSubcomponent('vtimezone').toJSON());
});
test('historical week-window grammar rejects unbounded or impossible intersections', () => {
  const original = 'FREQ=YEARLY;UNTIL=19910914T170000Z;BYMONTH=9;BYMONTHDAY=11,12,13,14,15,16,17;BYDAY=SU';
  const invalid = [
    original.replace(';UNTIL=19910914T170000Z', ''),
    original.replace('19910914', '22010914'),
    original.replace('BYDAY=SU', 'BYDAY=2SU'),
    original.replace('11,12,13,14,15,16,17', '11,12,13,14,15,16'),
    original.replace('11,12,13,14,15,16,17', '11,12,13,14,15,16,18'),
    original.replace('11,12,13,14,15,16,17', '11,12,13,14,15,16,16'),
    original.replace('11,12,13,14,15,16,17', '25,26,27,28,29,30,31'),
    original + ';BYSETPOS=1', original + ';INTERVAL=2', original + ';COUNT=3'
  ];
  for (const rule of invalid) assert.throws(() => resourceView(resource(source.replace(original, rule))), error => error.code === 'UNSUPPORTED_TIMEZONE', rule);
});


test('new week-window expansion remains bounded at its 200-year limit', () => {
  const originalNext = ICAL.RecurIterator.prototype.next; let iterations = 0;
  ICAL.RecurIterator.prototype.next = function(...args) { if (++iterations > 450) throw new Error('Timezone iteration budget exceeded'); return originalNext.apply(this, args); };
  try {
    const extended = source.replace('19910413T180000Z', '21870414T180000Z').replace('19910914T170000Z', '21860914T170000Z').replace('20261013T231300', '21851013T231300').replace('20261013T232800', '21851013T232800');
    assert.equal(resourceView(resource(extended)).start.utc, '2185-10-13T15:13:00.000Z');
    assert.ok(iterations > 350 && iterations < 450);
  } finally { ICAL.RecurIterator.prototype.next = originalNext; }
});
