export class AppError extends Error {
  constructor(code, message, status = 400, diagnostic) { super(message); this.code = code; this.status = status; if (diagnostic) this.diagnostic = diagnostic; }
}
export const fail = (code, message, status) => { throw new AppError(code, message, status); };
export function object(value, name = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', `${name} must be an object.`);
  return value;
}
export function keys(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENT', 'Unrecognized argument.');
}
export function string(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000\u000b\u000c]/.test(value)) fail('INVALID_ARGUMENT', `${name} is required and must be valid text.`);
  return value;
}
export function boundedText(value, name, max = 10000) {
  if (typeof value !== 'string' || value.length > max || /[\u0000\u000b\u000c]/.test(value)) fail('INVALID_ARGUMENT', `${name} must be valid text.`);
  return value;
}
export function validISO(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59 || (m[8] !== 'Z' && (Number(m[10]) > 14 || Number(m[11]) > 59 || (Number(m[10]) === 14 && Number(m[11]) !== 0)))) return false;
  return Number.isFinite(Date.parse(value));
}
export function windowBounds(start, end) {
  for (const value of [start, end]) if (!validISO(value)) fail('INVALID_ARGUMENT', 'Range boundaries require ISO timestamps with Z or an explicit UTC offset.');
  const from = Date.parse(start), to = Date.parse(end);
  if (to <= from || to - from > 366 * 86400000) fail('INVALID_ARGUMENT', 'Range must be positive and at most 366 days.');
  return { from, to, start: new Date(from).toISOString(), end: new Date(to).toISOString() };
}
export async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) fail('UPSTREAM_TOO_LARGE', 'Response exceeds the safe size limit.', 502);
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); fail('UPSTREAM_TOO_LARGE', 'Response exceeds the safe size limit.', 502); }
    chunks.push(value);
  }
  const combined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}
export const xmlEscape = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
export function safeError(error) {
  if (!(error instanceof AppError)) return { code: 'INTERNAL_ERROR', message: 'The operation failed safely. No credentials or calendar contents were logged.' };
  const result = { code: error.code, message: error.message };
  if (error.code === 'UNSAFE_URL' && error.diagnostic) {
    // Copy an exact allowlist of non-secret URL metadata, never arbitrary details.
    const { scheme, hostname, port, stage } = error.diagnostic;
    result.diagnostic = { scheme, hostname, port, stage };
  }
  if (error.code === 'INCOMPLETE_DAV_RESPONSE' && error.diagnostic) {
    const d = error.diagnostic;
    const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
    result.diagnostic = {
      stage: ['uid_query', 'event_query', 'uid_fallback_scan', 'event_multiget'].includes(d.stage) ? d.stage : 'event_query',
      response_status: status(d.response_status), propstat_statuses: Array.isArray(d.propstat_statuses) ? d.propstat_statuses.slice(0, 10).map(status) : [],
      has_calendar_data: d.has_calendar_data === true, has_etag: d.has_etag === true, has_resourcetype: d.has_resourcetype === true,
      is_collection: d.is_collection === true, is_calendar: d.is_calendar === true, is_selected_collection: d.is_selected_collection === true
    };
  }
  if (['ETAG_CONFLICT', 'ETAG_REQUIRED'].includes(error.code) && error.diagnostic?.stage === 'update_etag') {
    const d = error.diagnostic;
    result.diagnostic = { stage: 'update_etag' };
    for (const key of ['expected_has', 'expected_weak', 'get_has', 'get_matches', 'get_weak', 'report_attempted', 'report_has', 'report_matches', 'report_weak', 'scan_attempted']) result.diagnostic[key] = d[key] === true;
    result.diagnostic.report_error = ['READ_FAILED', 'INCOMPLETE_DAV_RESPONSE'].includes(d.report_error) ? d.report_error : null;
    result.diagnostic.scan_error = ['QUERY_FAILED', 'INCOMPLETE_DAV_RESPONSE', 'TOO_MANY_EVENTS', 'UPSTREAM_TOO_LARGE', 'EXACT_RESOURCE_REQUIRED', 'UID_MISMATCH'].includes(d.scan_error) ? d.scan_error : null;
    for (const key of ['report_diagnostic', 'scan_diagnostic']) if (d[key]) result.diagnostic[key] = safeError(new AppError('INCOMPLETE_DAV_RESPONSE', '', 502, d[key])).diagnostic;
  }
  if (error.diagnostic && (error.code === 'UNSUPPORTED_TIMEZONE' || (error.code === 'WRITE_RESULT_UNKNOWN' && error.diagnostic.cause === 'UNSUPPORTED_TIMEZONE'))) {
    const d = error.diagnostic;
    const number = value => Number.isInteger(value) && Math.abs(value) <= 999999 ? value : null;
    const parts = {};
    for (const key of ['BYMONTH', 'BYMONTHDAY', 'BYDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS', 'BYHOUR', 'BYMINUTE', 'BYSECOND']) {
      if (Array.isArray(d.parts?.[key])) parts[key] = d.parts[key].slice(0, 32).map(value => typeof value === 'string' && /^[+-]?\d{0,2}(?:MO|TU|WE|TH|FR|SA|SU)$/.test(value) ? value : number(value));
    }
    result.diagnostic = {
      stage: ['event_query_read', 'create_existing_uid', 'create_existing_resource', 'create_readback', 'update_validation', 'update_readback'].includes(d.stage) ? d.stage : 'timezone_validation',
      write_confirmed: d.write_confirmed === true, cause: 'UNSUPPORTED_TIMEZONE',
      tzid: typeof d.tzid === 'string' && /^[A-Za-z0-9_+\/-]{1,128}$/.test(d.tzid) ? d.tzid : null,
      observance: ['standard', 'daylight'].includes(d.observance) ? d.observance : null,
      frequency: ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'].includes(d.frequency) ? d.frequency : null,
      interval: number(d.interval), count: number(d.count), until: typeof d.until === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z?)?$/.test(d.until) ? d.until : null, parts
    };
  }
  return result;
}
