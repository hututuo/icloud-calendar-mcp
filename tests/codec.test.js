import test from 'node:test';
import assert from 'node:assert/strict';
import { createICS, updateICS, resourceView, parseCalendar, expandResource } from '../src/ical.js';
import { windowBounds, validISO } from '../src/common.js';
import { fixture, eventData } from './helpers.js';
const resource = ics => ({ ics, event_id: 'https://p01-caldav.icloud.com/account/calendars/personal/a.ics', etag: '"a"' });
const range = windowBounds('2026-10-12T00:00:00Z', '2026-10-30T00:00:00Z');
function errors(fn, code) { assert.throws(fn, error => error.code === code); }

test('create Shanghai datetime and two reminders', () => {
  const ics = createICS(eventData, 'fixture'); const view = resourceView(resource(ics));
  assert.equal(view.start.value, '2026-10-13T09:00:00'); assert.equal(view.start.utc, '2026-10-13T01:00:00.000Z');
  assert.equal(view.start.timezone, 'Asia/Shanghai'); assert.equal(view.reminders.length, 2); assert.ok(ics.includes('BEGIN:VTIMEZONE'));
});
test('create UTC time', () => {
  const view = resourceView(resource(createICS({ ...eventData, timezone: 'UTC' }, 'fixture')));
  assert.equal(view.start.value, '2026-10-13T01:00:00Z'); assert.equal(view.start.timezone, 'UTC');
});
test('all-day dates are exclusive and use Shanghai for busy interpretation', () => {
  const view = resourceView(resource(createICS({ ...eventData, all_day: true, start: '2026-10-13', end: '2026-10-14' }, 'fixture')));
  assert.equal(view.start.value, '2026-10-13'); assert.equal(view.start.all_day, true); assert.equal(view.end.utc, '2026-10-13T16:00:00.000Z');
});
test('summary patch preserves all alarms, unknown properties, timezone, attendees, and exceptions', async () => {
  const source = await fixture('preserved-series.ics'); const before = parseCalendar(source);
  const patched = updateICS(source, { summary: 'Updated title' }, 'series'); const after = parseCalendar(patched);
  for (const name of ['attendee', 'organizer', 'rrule', 'exdate', 'x-apple-structured-location', 'x-unknown-vevent']) assert.deepEqual(after.master.getAllProperties(name).map(p => p.toJSON()), before.master.getAllProperties(name).map(p => p.toJSON()));
  assert.deepEqual(after.master.getAllSubcomponents('valarm').map(p => p.toJSON()), before.master.getAllSubcomponents('valarm').map(p => p.toJSON()));
  assert.deepEqual(after.components[1].toJSON(), before.components[1].toJSON());
  assert.deepEqual(after.root.getFirstSubcomponent('vtimezone').toJSON(), before.root.getFirstSubcomponent('vtimezone').toJSON());
  assert.equal(after.master.getFirstPropertyValue('sequence'), 4); assert.equal(after.root.getFirstPropertyValue('x-unknown-root'), 'keep-root');
});
test('explicit reminder replacement and clear work; omitted reminders stay untouched', () => {
  const ics = createICS(eventData, 'fixture');
  assert.equal(resourceView(resource(updateICS(ics, { reminders: [5] }, 'event'))).reminders.length, 1);
  assert.equal(resourceView(resource(updateICS(ics, { reminders: [] }, 'event'))).reminders.length, 0);
});
test('EXDATE and moved recurrence exceptions expand correctly', async () => {
  const values = expandResource(resource(await fixture('preserved-series.ics')), range);
  assert.equal(values.length, 4); assert.ok(!values.some(v => v.start.value.startsWith('2026-10-14')));
  assert.equal(values.find(v => v.summary === 'Moved instance').start.value, '2026-10-15T11:00:00');
});
test('equivalent UTC recurrence IDs do not duplicate moved exceptions', async () => {
  const ics = (await fixture('preserved-series.ics')).replace('RECURRENCE-ID;TZID=Asia/Shanghai:20261015T090000', 'RECURRENCE-ID:20261015T010000Z');
  assert.equal(expandResource(resource(ics), range).length, 4);
});
test('embedded Berlin timezone retains wall time across DST boundary', async () => {
  const values = expandResource(resource(await fixture('berlin-dst.ics')), windowBounds('2026-10-18T00:00:00Z', '2026-11-03T00:00:00Z'));
  assert.deepEqual(values.map(v => v.start.utc), ['2026-10-19T07:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-11-02T08:00:00.000Z']);
});
test('single occurrence and recurring schedule edits fail explicitly', async () => {
  const ics = await fixture('preserved-series.ics');
  errors(() => updateICS(ics, { summary: 'No' }, 'occurrence'), 'INVALID_ARGUMENT');
  errors(() => updateICS(ics, { summary: 'No' }, 'event'), 'SERIES_SCOPE_REQUIRED');
  errors(() => updateICS(ics, { start: eventData.start }, 'series'), 'UNSUPPORTED_RECURRENCE_EDIT');
});
test('unknown timezone never silently becomes UTC', async () => {
  const ics = createICS(eventData, 'fixture').replace(/Asia\/Shanghai/g, 'Unknown/Zone').replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r?\n?/, '');
  errors(() => resourceView(resource(ics)), 'UNSUPPORTED_TIMEZONE');
});
test('invalid dates, times, offsets, and empty durations rejected', () => {
  for (const input of ['2026-02-30T09:00:00Z', '2026-10-13T24:00:00Z', '2026-10-13T09:60:00Z', '2026-10-13T09:00:00+14:30']) assert.equal(validISO(input), false);
  errors(() => createICS({ ...eventData, start: '2026-02-30T09:00:00Z' }, 'fixture'), 'INVALID_ARGUMENT');
  errors(() => createICS({ ...eventData, end: eventData.start }, 'fixture'), 'INVALID_ARGUMENT');
  errors(() => createICS({ ...eventData, all_day: true, start: '2026-02-30', end: '2026-03-02' }, 'fixture'), 'INVALID_ARGUMENT');
  errors(() => windowBounds('2026-02-30T00:00:00Z', '2026-03-02T00:00:00Z'), 'INVALID_ARGUMENT');
});
test('bounded simple repeated creation and ordinal DAILY hang pattern rejection', () => {
  const ics = createICS({ ...eventData, recurrence: 'FREQ=DAILY;COUNT=3' }, 'fixture');
  assert.equal(expandResource(resource(ics), range).length, 3);
  errors(() => createICS({ ...eventData, recurrence: 'FREQ=DAILY;COUNT=2;BYDAY=1MO' }, 'fixture'), 'UNSUPPORTED_RECURRENCE');
  errors(() => createICS({ ...eventData, recurrence: 'FREQ=DAILY;UNTIL=20260230T000000Z' }, 'fixture'), 'INVALID_ARGUMENT');
  errors(() => createICS({ ...eventData, recurrence: 'FREQ=DAILY' }, 'fixture'), 'INVALID_ARGUMENT');
});
test('unsupported timezone recurrence rejected before ICAL internal iteration', async () => {
  const ics = (await fixture('berlin-dst.ics')).replace('FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'FREQ=DAILY;BYDAY=1MO');
  errors(() => expandResource(resource(ics), range), 'UNSUPPORTED_TIMEZONE');
});
test('bounded recurrence scanning fails closed instead of returning partial instances', () => {
  const ics = createICS({ ...eventData, recurrence: 'FREQ=DAILY;COUNT=100' }, 'fixture');
  errors(() => expandResource(resource(ics), range, { remaining: 1 }), 'RECURRENCE_LIMIT');
});

test('spring DST nonexistent generated times are skipped without consuming COUNT', async () => {
  const ics = (await fixture('berlin-dst.ics')).replace('20261019T090000', '20260328T023000').replace('20261019T100000', '20260328T033000').replace('FREQ=WEEKLY;COUNT=3', 'FREQ=DAILY;COUNT=3');
  const values = expandResource(resource(ics), windowBounds('2026-03-27T00:00:00Z', '2026-04-02T00:00:00Z'));
  assert.deepEqual(values.map(event => event.start.value.slice(0, 10)), ['2026-03-28', '2026-03-30', '2026-03-31']);
});
test('fall DST repeated local time uses the first occurrence', async () => {
  const ics = (await fixture('berlin-dst.ics')).replace('20261019T090000', '20261025T023000').replace('20261019T100000', '20261025T033000');
  assert.equal(resourceView(resource(ics)).start.utc, '2026-10-25T00:30:00.000Z');
});
test('DTEND-based recurring events preserve exact duration across spring DST', async () => {
  const ics = (await fixture('berlin-dst.ics')).replace('20261019T090000', '20260328T013000').replace('20261019T100000', '20260328T033000').replace('FREQ=WEEKLY;COUNT=3', 'FREQ=DAILY;COUNT=3');
  const values = expandResource(resource(ics), windowBounds('2026-03-27T00:00:00Z', '2026-04-02T00:00:00Z'));
  assert.deepEqual(values.map(event => Date.parse(event.end.utc) - Date.parse(event.start.utc)), [7200000, 7200000, 7200000]);
});
test('invalid inbound dates and negative-duration resources rejected', () => {
  const original = createICS(eventData, 'fixture');
  errors(() => resourceView(resource(original.replace('20261013T090000', '20260230T090000'))), 'INVALID_ICS');
  errors(() => expandResource(resource(original.replace('20261013T100000', '20261013T080000')), range), 'INVALID_ICS');
});

test('synthetic recurring ends retain the second fold instant and positive exact duration', async () => {
  const source = (await fixture('berlin-dst.ics')).replace('20261019T090000', '20261024T023000').replace('20261019T100000', '20261024T033000').replace('FREQ=WEEKLY;COUNT=3', 'FREQ=DAILY;COUNT=3');
  const query = windowBounds('2026-10-23T00:00:00Z', '2026-10-28T00:00:00Z');
  for (const ics of [source, source.replace('DTEND;TZID=Europe/Berlin:20261024T033000', 'DURATION:PT1H')]) {
    const values = expandResource(resource(ics), query);
    assert.deepEqual(values.map(event => Date.parse(event.end.utc) - Date.parse(event.start.utc)), [3600000, 3600000, 3600000]);
    assert.equal(values[1].end.utc, '2026-10-25T01:30:00.000Z');
  }
});
test('timed recurrence without DTEND or DURATION yields point instances at each start', () => {
  const ics = createICS({ ...eventData, timezone: 'UTC', recurrence: 'FREQ=DAILY;COUNT=3' }, 'fixture').replace(/DTEND:[^\r\n]+\r?\n/, '');
  const values = expandResource(resource(ics), windowBounds('2026-10-14T00:00:00Z', '2026-10-17T00:00:00Z'));
  assert.equal(values.length, 2); assert.ok(values.every(value => value.start.utc === value.end.utc));
});
