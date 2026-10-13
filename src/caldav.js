import { runtimeFetch, deadline, transportFailure } from './runtime.js';
import { SHANGHAI_ICS } from './ical.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError, fail, boundedBody, xmlEscape } from './common.js';

const ROOT = 'https://caldav.icloud.com/';
// Regional endpoints are off by default. Configuration permits exact numbered
// Apple China CalDAV hosts only; never an arbitrary host or domain wildcard.
export function regionalHosts(env = {}) {
  const raw = env.CALDAV_ALLOWED_REGIONAL_HOSTS;
  if (raw === undefined || raw === '') return Object.freeze([]);
  let hosts;
  try { hosts = JSON.parse(raw); } catch { fail('NOT_CONFIGURED', 'Regional host configuration must be a JSON array.', 503); }
  if (!Array.isArray(hosts) || hosts.length > 20 || hosts.some(host => typeof host !== 'string' || !/^p\d{1,3}-caldav\.icloud\.com\.cn$/.test(host))) {
    fail('NOT_CONFIGURED', 'Regional hosts must be exact numbered Apple China CalDAV hostnames.', 503);
  }
  return Object.freeze([...new Set(hosts)]);
}
const MAX_XML = 4 * 1024 * 1024;
const MAX_ICS = 256 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: false, processEntities: true, isArray: name => ['response', 'propstat', 'comp', 'privilege'].includes(name) });
function array(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function text(value) { return typeof value === 'string' ? value : value?.['#text'] ?? ''; }
function statusCode(value) { const match = /(?:^|\s)([1-5]\d\d)(?:\s|$)/.exec(text(value)); return match ? Number(match[1]) : null; }
export function appleURL(input, base = ROOT, stage = 'resource_validation', allowedRegionalHosts = []) {
  let url;
  const reject = message => {
    // Never include input, href, username, password, pathname, search or hash.
    const diagnostic = { scheme: url?.protocol ?? null, hostname: url?.hostname ?? null, port: url ? (url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '')) : null, stage: /^[a-z_]{1,80}$/.test(stage) ? stage : 'resource_validation' };
    throw new AppError('UNSAFE_URL', message, 400, diagnostic);
  };
  if (typeof input !== 'string' || input.length > 8192 || /[\\\r\n\t]/.test(input)) reject('Invalid iCloud resource URL.');
  try { url = new URL(input, base); } catch { reject('Invalid iCloud resource URL.'); }
  if (url.protocol !== 'https:' || (!/^(?:caldav|p\d{1,3}-caldav)\.icloud\.com$/.test(url.hostname) && !allowedRegionalHosts.includes(url.hostname)) || url.port || url.username || url.password || url.search || url.hash) reject('Only approved iCloud CalDAV HTTPS hosts are allowed.');
  // All other origin, path, query, credential and scope checks remain unchanged.
  let decoded;
  try { decoded = decodeURIComponent(input); } catch { reject('Malformed iCloud resource URL.'); }
  if (/%(?:2e|2f|5c|25)/i.test(input) || /[\\\r\n]/.test(decoded) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(input)) reject('Unsafe iCloud resource path.');
  return url.href;
}
export function within(resource, collection, allowedRegionalHosts = []) {
  const r = new URL(appleURL(resource, ROOT, 'resource_validation', allowedRegionalHosts)), c = new URL(appleURL(collection, ROOT, 'resource_validation', allowedRegionalHosts));
  return r.origin === c.origin && r.pathname.startsWith(c.pathname.endsWith('/') ? c.pathname : `${c.pathname}/`) && r.pathname !== c.pathname;
}
function parseMulti(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) fail('INVALID_DAV_RESPONSE', 'Invalid CalDAV XML response.', 502);
  let doc; try { doc = parser.parse(xml); } catch { fail('INVALID_DAV_RESPONSE', 'Invalid CalDAV XML response.', 502); }
  if (!Object.hasOwn(doc, 'multistatus')) fail('INVALID_DAV_RESPONSE', 'CalDAV multistatus response is missing.', 502);
  return array(doc.multistatus?.response).map(row => {
    const props = Object.assign({}, ...array(row.propstat).filter(p => /\s200(?:\s|$)/.test(text(p.status))).map(p => p.prop || {}));
    // trimValues stays false to preserve calendar text. XML indentation is
    // parser metadata, not a failed DAV property; unexpected text still fails.
    const propstats = array(row.propstat).map(p => ({ status: statusCode(p.status), names: Object.keys(p.prop || {}).filter(name => !(name === '#text' && typeof p.prop[name] === 'string' && /^[\t\r\n ]*$/.test(p.prop[name]))) }));
    return { href: text(row.href), props, status: text(row.status), propstats, failed: propstats.some(p => p.status !== 200) || (Boolean(row.status) && statusCode(row.status) !== 200) };
  });
}
function propfind(properties) { return `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>${properties}</d:prop></d:propfind>`; }
function stamp(value) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

export class CalDAV {
  constructor(env, fetcher = runtimeFetch) {
    if (!env.CALDAV_USERNAME || !env.CALDAV_PASSWORD) fail('NOT_CONFIGURED', 'Server-side iCloud credentials have not been securely configured.', 503);
    if (/[\r\n:]/.test(env.CALDAV_USERNAME) || /[\r\n]/.test(env.CALDAV_PASSWORD)) fail('NOT_CONFIGURED', 'Invalid server-side credential configuration.', 503);
    this.env = env; this.fetcher = (input, init) => fetcher(input, init);
    this.regionalHosts = regionalHosts(env);
    this.url = (input, base = ROOT, stage = 'resource_validation') => appleURL(input, base, stage, this.regionalHosts);
    this.within = (resource, collection) => within(resource, collection, this.regionalHosts);
    const bytes = new TextEncoder().encode(`${env.CALDAV_USERNAME}:${env.CALDAV_PASSWORD}`);
    this.authorization = `Basic ${btoa(String.fromCharCode(...bytes))}`;
    this.allowed = null;
    if (env.CALDAV_ALLOWED_CALENDAR_URLS) {
      try { this.allowed = JSON.parse(env.CALDAV_ALLOWED_CALENDAR_URLS); } catch { fail('NOT_CONFIGURED', 'Calendar scope configuration is invalid.', 503); }
      if (!Array.isArray(this.allowed) || this.allowed.some(value => typeof value !== 'string')) fail('NOT_CONFIGURED', 'Calendar scope configuration is invalid.', 503);
      this.allowed = this.allowed.map(value => this.url(value, ROOT, 'configured_calendar_scope'));
    }
  }
  async request(url, { method = 'GET', body, headers = {}, limit = MAX_XML, scope = null, exact = false, stage = 'resource_request' } = {}) {
    let target = this.url(url, ROOT, stage);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (scope && target !== scope && (exact || !this.within(target, scope))) fail('UNSAFE_REDIRECT', 'The redirect left the selected calendar; no credentials or event data were sent.', 502);
      const timeout = deadline();
      try {
        let response;
        try { response = await this.fetcher(target, { method, body, redirect: 'manual', headers: { Authorization: this.authorization, ...headers }, signal: timeout.signal }); }
        catch (error) { transportFailure(error, method, timeout.signal); }
        if ([301, 302, 307, 308].includes(response.status)) {
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location || redirects === 3) fail('UPSTREAM_REDIRECT', 'iCloud discovery returned an invalid redirect chain.', 502);
          target = this.url(location, target, `${stage}_redirect`); continue;
        }
        if (response.status === 303) { await response.body?.cancel(); fail('UPSTREAM_REDIRECT', 'Unsafe redirect method change was rejected.', 502); }
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); fail('ICLOUD_ACCESS_DENIED', 'iCloud rejected access. Check the secure credential configuration and calendar permissions.', 502); }
        if (response.status === 412 && method === 'PUT') { await response.body?.cancel(); fail('ETAG_CONFLICT', 'The calendar resource changed. Read it again before retrying.', 409); }
        let responseBody;
        try { responseBody = await boundedBody(response, limit); }
        catch (error) { if (error instanceof AppError) throw error; transportFailure(error, method, timeout.signal); }
        return { status: response.status, etag: response.headers.get('etag'), url: target, body: responseBody };
      } finally { timeout.dispose(); }
    }
  }
  async props(url, properties, depth = '0', stage = 'property_discovery') {
    const result = await this.request(url, { method: 'PROPFIND', body: propfind(properties), stage, headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' } });
    if (result.status !== 207) fail('DISCOVERY_FAILED', 'iCloud calendar discovery was not successful.', 502);
    return { rows: parseMulti(result.body), url: result.url };
  }
  async calendars() {
    const principalResult = await this.props(ROOT, '<d:current-user-principal/>', '0', 'principal_discovery');
    const principalHref = principalResult.rows.map(row => text(row.props['current-user-principal']?.href)).find(Boolean);
    if (!principalHref) fail('DISCOVERY_FAILED', 'iCloud did not return the signed-in principal.', 502);
    const principal = this.url(principalHref, principalResult.url, 'principal_href');
    const homeResult = await this.props(principal, '<c:calendar-home-set/>', '0', 'calendar_home_discovery');
    const homeHref = homeResult.rows.map(row => text(row.props['calendar-home-set']?.href)).find(Boolean);
    if (!homeHref) fail('DISCOVERY_FAILED', 'iCloud did not return a calendar home.', 502);
    const home = this.url(homeHref, homeResult.url, 'calendar_home_href');
    const calendarResult = await this.props(home, '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/>', '1', 'calendar_list_discovery');
    const calendars = [];
    for (const row of calendarResult.rows) {
      if (!Object.hasOwn(row.props.resourcetype || {}, 'calendar')) continue;
      const url = this.url(row.href, calendarResult.url, 'calendar_href');
      if (!this.within(url, calendarResult.url)) fail('UNSAFE_DAV_RESPONSE', 'Calendar discovery left the authenticated calendar home.', 502);
      const components = array(row.props['supported-calendar-component-set']?.comp).map(comp => comp['@_name']);
      if (components.length && !components.includes('VEVENT')) continue;
      if (this.allowed && !this.allowed.includes(url)) continue;
      const privileges = row.props['current-user-privilege-set'];
      const canWrite = privileges === undefined ? null : array(privileges.privilege).some(p => ['all', 'write', 'write-content'].some(key => Object.hasOwn(p, key)));
      calendars.push({ calendar_id: url, name: text(row.props.displayname) || 'Calendar', color: text(row.props['calendar-color']) || null, writable: canWrite });
      if (calendars.length > 100) fail('TOO_MANY_CALENDARS', 'Limit the configured calendar scope before retrying.', 413);
    }
    return calendars;
  }
  async calendar(id, write = false) {
    const url = this.url(id);
    const calendar = (await this.calendars()).find(item => item.calendar_id === url);
    if (!calendar) fail('CALENDAR_NOT_ALLOWED', 'This calendar is outside the authenticated account or configured scope.', 403);
    if (write && calendar.writable === false) fail('CALENDAR_READ_ONLY', 'This calendar is read-only.', 403);
    return calendar;
  }
  async query(calendar, range = null, uid = null) {
    const match = uid ? `<c:prop-filter name="UID"><c:text-match collation="i;octet">${xmlEscape(uid)}</c:text-match></c:prop-filter>` : range ? `<c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/>` : '';
    const timezone = `<c:timezone>${xmlEscape('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Private iCloud//EN\r\n' + SHANGHAI_ICS + '\r\nEND:VCALENDAR')}</c:timezone>`;
    const xml = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/><d:resourcetype/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${match}</c:comp-filter></c:comp-filter></c:filter>${timezone}</c:calendar-query>`;
    const stage = uid ? 'uid_query' : range ? 'event_query' : 'uid_fallback_scan';
    const result = await this.request(calendar.calendar_id, { method: 'REPORT', body: xml, stage, scope: calendar.calendar_id, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' } });
    // Some iCloud nodes reject UID prop-filter with 412 before any PUT.
    // Fall back once to the selected calendar's complete VEVENT set; the same
    // byte/resource/row-integrity limits below must pass before any write.
    if (uid && result.status === 412) return this.query(calendar, null, null);
    if (result.status !== 207) fail('QUERY_FAILED', 'The iCloud event query failed; no complete event set was available.', 502);
    return this.eventResources(result, calendar, stage);
  }
  eventResources(result, calendar, stage) {
    const resources = [];
    for (const row of parseMulti(result.body)) {
      const url = this.url(row.href, result.url, 'event_href');
      const isSelectedCollection = url === calendar.calendar_id;
      if (!isSelectedCollection && !this.within(url, calendar.calendar_id)) fail('UNSAFE_DAV_RESPONSE', 'Event query returned a resource outside the selected calendar.', 502);
      const ics = text(row.props['calendar-data']);
      const isCollection = Object.hasOwn(row.props.resourcetype || {}, 'collection');
      const responseOK = !row.status || statusCode(row.status) === 200;
      const onlyMissing = names => row.propstats.every(p => p.status === 200 || (p.status === 404 && p.names.length > 0 && p.names.every(name => names.includes(name))));
      // A proven current-calendar collection is not an event. Never skip an
      // unknown child, an access failure, or a 507/incomplete-result sentinel.
      if (isSelectedCollection && isCollection && !ics && responseOK && onlyMissing(['getetag', 'calendar-data'])) continue;
      // resourcetype is optional for event rows; only its isolated 404 is harmless.
      if (isSelectedCollection || isCollection || !responseOK || !onlyMissing(['resourcetype']) || !ics) {
        throw new AppError('INCOMPLETE_DAV_RESPONSE', 'iCloud returned an unreadable event. No partial results or free-time claim were returned.', 502, {
          stage, response_status: statusCode(row.status), propstat_statuses: [...new Set(row.propstats.map(p => p.status))].slice(0, 10),
          has_calendar_data: Boolean(ics), has_etag: Boolean(text(row.props.getetag)), has_resourcetype: Object.hasOwn(row.props, 'resourcetype'),
          is_collection: isCollection, is_calendar: Object.hasOwn(row.props.resourcetype || {}, 'calendar'), is_selected_collection: isSelectedCollection
        });
      }
      if (new TextEncoder().encode(ics).length > MAX_ICS) fail('UPSTREAM_TOO_LARGE', 'An event exceeds the safe size limit.', 502);
      resources.push({ event_id: url, etag: text(row.props.getetag) || null, ics });
      if (resources.length > 250) fail('TOO_MANY_EVENTS', 'Too many events. Retry with a narrower date range.', 413);
    }
    return resources;
  }
  async multiget(calendar, eventId) {
    const url = this.url(eventId);
    if (!this.within(url, calendar.calendar_id)) fail('EVENT_NOT_ALLOWED', 'The event is outside the selected calendar.', 403);
    // Body and ETag must come from this same resource response. Never attach a
    // separately fetched property ETag to a potentially stale GET body.
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/><d:resourcetype/></d:prop><d:href>${xmlEscape(url)}</d:href></c:calendar-multiget>`;
    const result = await this.request(calendar.calendar_id, { method: 'REPORT', body, stage: 'event_multiget', scope: calendar.calendar_id, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' } });
    if (result.status !== 207) fail('READ_FAILED', 'The exact event and its ETag could not be read together.', 502);
    const resources = this.eventResources(result, calendar, 'event_multiget');
    if (resources.length !== 1 || resources[0].event_id !== url) fail('READ_FAILED', 'The exact event response was missing, duplicated or included another event.', 502);
    return resources[0];
  }
  async get(calendar, eventId) {
    const url = this.url(eventId);
    if (!this.within(url, calendar.calendar_id)) fail('EVENT_NOT_ALLOWED', 'The event is outside the selected calendar.', 403);
    const result = await this.request(url, { limit: MAX_ICS, scope: url, exact: true, stage: 'event_read' });
    if (result.status === 404) fail('EVENT_NOT_FOUND', 'The event no longer exists.', 404);
    if (result.status !== 200 || !this.within(result.url, calendar.calendar_id)) fail('READ_FAILED', 'The event could not be safely read.', 502);
    return { event_id: result.url, etag: result.etag, ics: result.body };
  }
  async put(calendar, eventId, ics, etag) {
    if (!this.within(eventId, calendar.calendar_id)) fail('EVENT_NOT_ALLOWED', 'The event is outside the selected calendar.', 403);
    if (etag !== null && (!etag || /^W\//.test(etag) || !/^"[^"\r\n]*"$/.test(etag))) fail('ETAG_REQUIRED', 'A valid strong ETag from a fresh read is required.', 409);
    if (new TextEncoder().encode(ics).length > MAX_ICS) fail('EVENT_TOO_LARGE', 'The event exceeds the safe size limit.', 413);
    const result = await this.request(eventId, { method: 'PUT', body: ics, stage: 'event_write', limit: MAX_ICS, scope: eventId, exact: true, headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...(etag === null ? { 'If-None-Match': '*' } : { 'If-Match': etag }) } });
    if (![200, 201, 204].includes(result.status) || !this.within(result.url, calendar.calendar_id)) fail('WRITE_FAILED', 'iCloud did not confirm the requested write. Read the UID/resource before retrying.', 502);
    return { event_id: result.url, etag: result.etag };
  }
}
