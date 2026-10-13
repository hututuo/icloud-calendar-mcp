import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { createICS, canonical, sha256 } from '../src/ical.js';
import { AppError, safeError, xmlEscape } from '../src/common.js';
import { createWorker } from '../worker/index.js';
import { ENV, CALENDAR, eventData, mockDAV, request } from './helpers.js';
const multi = rows => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`;
const propstat = (props, status) => `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`;
const row = (href, props, status = '') => `<d:response><d:href>${xmlEscape(href)}</d:href>${status ? `<d:status>HTTP/1.1 ${status}</d:status>` : ''}${props}</d:response>`;
const marker = '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>';
const collection = row(CALENDAR, propstat(marker, '200 OK') + propstat('<d:getetag/><c:calendar-data/>', '404 Not Found'));
function setup(rows) {
  const mock = mockDAV(); const calls = [];
  const fetcher = async (url, options) => {
    calls.push(options);
    if (options.method === 'REPORT') {
      if (options.body.includes('prop-filter name="UID"')) return new Response('', { status: 412 });
      return new Response(multi(rows), { status: 207 });
    }
    return mock.fetch(url, options);
  };
  return { mock, fetcher, calls };
}
const args = { calendar_id: CALENDAR, ...eventData };

test('proven exact calendar collection row is not mistaken for unreadable event', async () => {
  const { mock, fetcher, calls } = setup(collection);
  const result = await callTool('create_event', args, ENV, fetcher);
  assert.equal(result.created, true); assert.equal(mock.writes, 1);
  assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-None-Match'], '*');
  assert.ok(calls.filter(call => call.method === 'REPORT').every(call => call.body.includes('<d:resourcetype/>')));
});
test('collection metadata is skipped without skipping a same-UID event', async () => {
  const ics = createICS(eventData, await sha256(canonical(eventData)));
  const event = row(CALENDAR + 'server-name.ics', propstat(`<d:getetag>"v1"</d:getetag><c:calendar-data>${xmlEscape(ics)}</c:calendar-data>`, '200 OK') + propstat('<d:resourcetype/>', '404 Not Found'));
  const { mock, fetcher } = setup(collection + event);
  const result = await callTool('create_event', args, ENV, fetcher);
  assert.equal(result.idempotent_replay, true); assert.equal(result.event.event_id, CALENDAR + 'server-name.ics'); assert.equal(mock.writes, 0);
});
test('unproven, denied, truncated or child collection rows still prevent writes', async () => {
  const cases = [
    row(CALENDAR, propstat('<d:getetag/><c:calendar-data/>', '404 Not Found')),
    row(CALENDAR, propstat(marker, '200 OK') + propstat('<c:calendar-data/>', '403 Forbidden')),
    row(CALENDAR, propstat(marker, '200 OK'), '507 Insufficient Storage'),
    row(CALENDAR + 'child/', propstat(marker, '200 OK')),
    row(CALENDAR + 'event.ics', propstat('<d:getetag/>', '200 OK') + propstat('<c:calendar-data/>', '404 Not Found'))
  ];
  for (const body of cases) {
    const { mock, fetcher } = setup(body);
    await assert.rejects(() => callTool('create_event', args, ENV, fetcher), error => error.code === 'INCOMPLETE_DAV_RESPONSE'); assert.equal(mock.writes, 0);
  }
});
test('collection marker does not bypass URL scope or event failures', async () => {
  const outside = setup(row('https://p01-caldav.icloud.com/another-calendar/', propstat(marker, '200 OK')));
  await assert.rejects(() => callTool('create_event', args, ENV, outside.fetcher), error => error.code === 'UNSAFE_DAV_RESPONSE'); assert.equal(outside.mock.writes, 0);
  const invalid = setup(collection + row(CALENDAR + 'bad.ics', propstat('<c:calendar-data>private-invalid-ics</c:calendar-data>', '200 OK') + propstat('<d:getetag/>', '403 Forbidden')));
  await assert.rejects(() => callTool('create_event', args, ENV, invalid.fetcher), error => error.code === 'INCOMPLETE_DAV_RESPONSE'); assert.equal(invalid.mock.writes, 0);
});
test('authenticated unreadable-row diagnostic exposes numeric statuses and booleans only', async () => {
  const { mock, fetcher } = setup(row(CALENDAR + 'private-event-name.ics', propstat('<d:getetag>private-etag</d:getetag>', '200 private-status-text') + propstat('<c:calendar-data/>', '403 private-error-text')));
  const body = await (await createWorker(fetcher).fetch(request('tools/call', { name: 'create_event', arguments: args }), ENV)).json();
  const error = body.result.structuredContent.error;
  assert.deepEqual(error.diagnostic, { stage: 'uid_fallback_scan', response_status: null, propstat_statuses: [200, 403], has_calendar_data: false, has_etag: true, has_resourcetype: false, is_collection: false, is_calendar: false, is_selected_collection: false });
  for (const secret of ['private-event-name', 'private-etag', 'private-status-text', 'private-error-text', ENV.CALDAV_USERNAME, ENV.CALDAV_PASSWORD, CALENDAR]) assert.ok(!JSON.stringify(body).includes(secret));
  assert.equal(mock.writes, 0);
});
test('diagnostic allowlist strips arbitrary upstream values and unknown fields', () => {
  const error = safeError(new AppError('INCOMPLETE_DAV_RESPONSE', 'Safe', 502, { stage: 'private-stage', response_status: 'private-status', propstat_statuses: [403, 'private-value'], has_etag: 'private-etag', href: 'private-href' }));
  assert.equal(error.diagnostic.stage, 'event_query'); assert.deepEqual(error.diagnostic.propstat_statuses, [403, null]);
  assert.equal(error.diagnostic.response_status, null); assert.equal(error.diagnostic.has_etag, false); assert.ok(!JSON.stringify(error).includes('private'));
});

test('formatted collection propstat ignores only XML whitespace with a present ETag', async () => {
  const formatted = row(CALENDAR, propstat(`\n  <d:getetag>"calendar-etag"</d:getetag>\n  ${marker}\n`, '200 OK') + propstat('\n  <c:calendar-data/>\n', '404 Not Found'));
  const { mock, fetcher } = setup(formatted);
  const result = await callTool('create_event', args, ENV, fetcher);
  assert.equal(result.created, true); assert.equal(mock.writes, 1);
  assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-None-Match'], '*');
});
test('formatted event optional property fallback keeps full UID replay and calendar text', async () => {
  const data = { ...eventData, summary: '  Spaces retained  ', description: 'First line\n Second line' };
  const ics = createICS(data, await sha256(canonical(data)));
  const event = row(CALENDAR + 'formatted-event.ics', propstat(`\n  <d:getetag>"v1"</d:getetag>\n  <c:calendar-data>${xmlEscape(ics)}</c:calendar-data>\n`, '200 OK') + propstat('\n  <d:resourcetype/>\n', '404 Not Found'));
  const { mock, fetcher } = setup(collection + event);
  const result = await callTool('create_event', { calendar_id: CALENDAR, ...data }, ENV, fetcher);
  assert.equal(result.idempotent_replay, true); assert.equal(result.event.summary, data.summary); assert.equal(result.event.description, data.description); assert.equal(mock.writes, 0);
});
test('non-whitespace mixed content or unknown failed property is never silently ignored', async () => {
  for (const props of ['unexpected-content<c:calendar-data/>', '\n <c:calendar-data/><d:unknown-property/>\n']) {
    const { mock, fetcher } = setup(row(CALENDAR, propstat(marker, '200 OK') + propstat(props, '404 Not Found')));
    await assert.rejects(() => callTool('create_event', args, ENV, fetcher), error => error.code === 'INCOMPLETE_DAV_RESPONSE'); assert.equal(mock.writes, 0);
  }
});
