import test from 'node:test';
import assert from 'node:assert/strict';
import { CalDAV, regionalHosts } from '../src/caldav.js';
import { ENV } from './helpers.js';

const host = 'p42-caldav.icloud.com.cn';
const env = { ...ENV, CALDAV_ALLOWED_REGIONAL_HOSTS: JSON.stringify([host]) };
test('regional configuration defaults empty and accepts exact numbered hosts only', () => {
  assert.deepEqual(regionalHosts(), []);
  assert.deepEqual(regionalHosts({ CALDAV_ALLOWED_REGIONAL_HOSTS: '' }), []);
  assert.deepEqual(regionalHosts({ CALDAV_ALLOWED_REGIONAL_HOSTS: '[]' }), []);
  assert.deepEqual(regionalHosts({ CALDAV_ALLOWED_REGIONAL_HOSTS: JSON.stringify([host, host]) }), [host]);
  for (const value of ['null', '{}', 'true', '"p42-caldav.icloud.com.cn"', 'not-json', '[42]', JSON.stringify(Array(21).fill(host)), ...['*', '*.icloud.com.cn', 'caldav.icloud.com.cn', 'evil.invalid', 'p0042-caldav.icloud.com.cn', host + '.evil.invalid', 'https://' + host, host + ':443', ' ' + host, host.toUpperCase()].map(v => JSON.stringify([v]))]) {
    assert.throws(() => regionalHosts({ CALDAV_ALLOWED_REGIONAL_HOSTS: value }), e => e.code === 'NOT_CONFIGURED');
  }
});
test('invalid regional configuration fails before network and does not expose raw config', () => {
  let calls = 0;
  assert.throws(() => new CalDAV({ ...ENV, CALDAV_ALLOWED_REGIONAL_HOSTS: '["secret.example.invalid"]' }, () => { calls++; }), e => e.code === 'NOT_CONFIGURED' && !e.message.includes('secret.example.invalid'));
  assert.equal(calls, 0);
});
test('regional allowlists are request-local and maintain calendar scope', () => {
  const enabled = new CalDAV(env), disabled = new CalDAV(ENV);
  assert.equal(enabled.url(`https://${host}/fixture/`), `https://${host}/fixture/`);
  assert.throws(() => disabled.url(`https://${host}/fixture/`), e => e.code === 'UNSAFE_URL');
  assert.equal(enabled.within(`https://${host}/fixture/a.ics`, `https://${host}/fixture/`), true);
  assert.equal(enabled.within(`https://${host}/other/a.ics`, `https://${host}/fixture/`), false);
  assert.equal(enabled.within('https://p01-caldav.icloud.com/fixture/a.ics', `https://${host}/fixture/`), false);
});
test('configured regional calendar URLs require the matching explicit regional host', () => {
  const config = JSON.stringify([`https://${host}/fixture/`]);
  assert.throws(() => new CalDAV({ ...ENV, CALDAV_ALLOWED_CALENDAR_URLS: config }), e => e.code === 'UNSAFE_URL');
  assert.deepEqual(new CalDAV({ ...env, CALDAV_ALLOWED_CALENDAR_URLS: config }).allowed, [`https://${host}/fixture/`]);
});
test('regional redirects stay inside the configured exact host allowlist', async () => {
  let calls = 0;
  const dav = new CalDAV(env, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://p43-caldav.icloud.com.cn/fixture/' } }); });
  await assert.rejects(() => dav.request(`https://${host}/fixture/`, { method: 'PROPFIND' }), e => e.code === 'UNSAFE_URL');
  assert.equal(calls, 1);
});
