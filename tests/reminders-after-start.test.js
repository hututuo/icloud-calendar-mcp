import test from 'node:test';
import assert from 'node:assert/strict';
import { createICS, parseCalendar, resourceView, updateICS } from '../src/ical.js';
import { TOOLS, callTool } from '../src/tools.js';
import { ENV, CALENDAR, eventData, mockDAV } from './helpers.js';
const view = ics => resourceView({ ics, event_id: CALENDAR + 'event.ics', etag: '"v1"' });
const offsets = [10, 0, -5];
const triggers = ['-PT10M', 'PT0S', 'PT5M'];

test('signed reminders serialize DISPLAY alarms and read back start-relative triggers', () => {
  for (const timezone of ['Asia/Shanghai', 'UTC']) {
    const ics = createICS({ ...eventData, timezone, reminders: offsets }, 'fixture');
    assert.deepEqual(view(ics).reminders.map(alarm => [alarm.action, alarm.related, alarm.trigger]), triggers.map(trigger => ['DISPLAY', 'START', trigger]));
    for (const trigger of triggers) assert.ok(ics.includes(`TRIGGER:${trigger}\r\n`));
    assert.deepEqual(parseCalendar(ics).master.getAllSubcomponents('valarm').map(alarm => alarm.getFirstPropertyValue('trigger').toSeconds()), [-600, 0, 300]);
  }
});
test('after-start reminder patch preserves event identity/times and unrelated patch preserves alarms', () => {
  const original = createICS(eventData, 'fixture');
  const changed = updateICS(original, { reminders: [...offsets, -5] }, 'event');
  assert.deepEqual(view(changed).reminders.map(alarm => alarm.trigger), triggers);
  for (const key of ['uid', 'start', 'end', 'summary', 'location']) assert.deepEqual(view(changed)[key], view(original)[key]);
  assert.deepEqual(view(updateICS(changed, { summary: 'Updated' }, 'event')).reminders, view(changed).reminders);
  assert.deepEqual(view(updateICS(changed, { reminders: [] }, 'event')).reminders, []);
});
test('signed reminder bounds and schema match without accepting invalid values', () => {
  const specs = [TOOLS.find(tool => tool.name === 'create_event').inputSchema.properties.reminders, TOOLS.find(tool => tool.name === 'update_event').inputSchema.properties.patch.properties.reminders];
  for (const spec of specs) { assert.equal(spec.items.minimum, -525600); assert.equal(spec.items.maximum, 525600); assert.equal(spec.maxItems, 10); assert.match(spec.description, /negative = after/); }
  assert.equal(view(createICS({ ...eventData, reminders: [-525600, 525600] }, 'fixture')).reminders.length, 2);
  for (const reminders of [[-525601], [525601], [-0.5], ['-5'], [null], Array(11).fill(-5)]) assert.throws(() => createICS({ ...eventData, reminders }, 'fixture'), error => error.code === 'INVALID_ARGUMENT');
});
test('same-event after-start update uses fresh If-Match and returns verified read-back', async () => {
  const mock = mockDAV({ 'event.ics': createICS(eventData, 'fixture') });
  const result = await callTool('update_event', { calendar_id: CALENDAR, event_id: CALENDAR + 'event.ics', expected_etag: '"v1"', scope: 'event', patch: { reminders: offsets } }, ENV, mock.fetch);
  assert.equal(result.updated, true); assert.equal(mock.writes, 1); assert.equal(result.event.uid, eventData.uid);
  assert.deepEqual(result.event.reminders.map(alarm => alarm.trigger), triggers);
  const put = mock.calls.find(call => call.method === 'PUT'); assert.equal(put.url, CALENDAR + 'event.ics'); assert.equal(put.headers['If-Match'], '"v1"');
  assert.equal(mock.calls.at(-1).method, 'GET');
});
