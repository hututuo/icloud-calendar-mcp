import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { xmlEscape } from '../src/common.js';
export const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
export const CALENDAR = 'https://p01-caldav.icloud.com/account/calendars/personal/';
export const ENV = { OWNER_USER_ID: 'fixture-owner', CALDAV_USERNAME: 'fixture@example.invalid', CALDAV_PASSWORD: 'fixture-password-never-real', WRITE_ENABLED: 'true' };
const multi = inner => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`;
const response = (href, props) => `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const xml = body => new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } });
export function mockDAV(initial = {}) {
  const state = { events: new Map(Object.entries(initial).map(([name, ics]) => [CALENDAR + name, { ics, etag: '"v1"' }])), calls: [], writes: 0, failNextPut: false, redirect: null, customQuery: null };
  state.fetch = async (url, options = {}) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Basic ' + btoa(`${ENV.CALDAV_USERNAME}:${ENV.CALDAV_PASSWORD}`));
    state.calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    if (state.redirect && options.method === state.redirect.method) return new Response(null, { status: state.redirect.status || 307, headers: { location: state.redirect.location } });
    if (options.method === 'PROPFIND' && url === 'https://caldav.icloud.com/') return xml(multi(response('/', '<d:current-user-principal><d:href>https://p01-caldav.icloud.com/account/principal/</d:href></d:current-user-principal>')));
    if (options.method === 'PROPFIND' && url === 'https://p01-caldav.icloud.com/account/principal/') return xml(multi(response('/account/principal/', '<c:calendar-home-set><d:href>/account/calendars/</d:href></c:calendar-home-set>')));
    if (options.method === 'PROPFIND' && url === 'https://p01-caldav.icloud.com/account/calendars/') return xml(multi(response(CALENDAR, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Personal fixture</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>')));
    if (options.method === 'REPORT' && url === CALENDAR) {
      if (state.customQuery) return xml(state.customQuery);
      return xml(multi([...state.events].map(([href, event]) => response(href, `<d:getetag>${xmlEscape(event.etag)}</d:getetag><c:calendar-data>${xmlEscape(event.ics)}</c:calendar-data>`)).join('')));
    }
    if (options.method === 'GET') { const event = state.events.get(url); return event ? new Response(event.ics, { headers: { etag: event.etag } }) : new Response('', { status: 404 }); }
    if (options.method === 'PUT') {
      const old = state.events.get(url);
      if (state.failNextPut || (options.headers['If-None-Match'] === '*' && old) || (options.headers['If-Match'] && options.headers['If-Match'] !== old?.etag)) { state.failNextPut = false; return new Response('', { status: 412 }); }
      state.writes++; const etag = `"v${state.writes + 1}"`; state.events.set(url, { ics: options.body, etag }); return new Response(null, { status: old ? 204 : 201, headers: { etag } });
    }
    throw new Error('Unexpected fixture request ' + options.method + ' ' + url);
  };
  return state;
}
export function request(method, params = {}, identity = ENV.OWNER_USER_ID, extra = {}) {
  return new Request('https://fixture.chatgpt.site/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(identity ? { 'oai-authenticated-user-id': identity } : {}), ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
export const eventData = { uid: 'new-event@example.invalid', summary: 'Fixture event', start: '2026-10-13T09:00:00+08:00', end: '2026-10-13T10:00:00+08:00', all_day: false, timezone: 'Asia/Shanghai', reminders: [15, 1440] };
