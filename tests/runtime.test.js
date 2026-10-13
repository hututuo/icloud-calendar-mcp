import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import { CalDAV } from '../src/caldav.js';
import { deadline } from '../src/runtime.js';
import { ENV, mockDAV, request, CALENDAR } from './helpers.js';

// The receiver check models the native WorkerGlobalScope fetch brand check,
// which Node's own fetch and ordinary arrow mocks do not enforce.
test('default Worker path invokes native fetch with the global receiver', async () => {
  const previous = globalThis.fetch; const mock = mockDAV(); let calls = 0;
  globalThis.fetch = function(input, init) {
    if (this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect this reference');
    calls++; return mock.fetch(input, init);
  };
  try {
    const worker = createWorker();
    const body = await (await worker.fetch(request('tools/call', { name: 'list_calendars' }), ENV)).json();
    assert.equal(body.result.isError, false); assert.equal(body.result.structuredContent.calendars[0].calendar_id, CALENDAR); assert.equal(calls, 3);
  } finally { globalThis.fetch = previous; }
});
test('CalDAV default fetch works independently of the Worker wrapper', async () => {
  const previous = globalThis.fetch; const mock = mockDAV();
  globalThis.fetch = function(input, init) { assert.equal(this, globalThis); return mock.fetch(input, init); };
  try { assert.equal((await new CalDAV(ENV).calendars()).length, 1); }
  finally { globalThis.fetch = previous; }
});
test('requests do not rely on AbortSignal.timeout and dispose timers', async () => {
  const previous = AbortSignal.timeout; AbortSignal.timeout = undefined;
  try { const mock = mockDAV(); assert.equal((await new CalDAV(ENV, mock.fetch).calendars()).length, 1); }
  finally { AbortSignal.timeout = previous; }
  const timer = deadline(1); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(timer.signal.aborted, true); timer.dispose();
});
test('runtime and network failures expose only fixed safe categories', async () => {
  const marker = 'DO_NOT_EXPOSE_fixture_credential_or_resource';
  const cases = [
    [new TypeError('Illegal invocation ' + marker), 'RUNTIME_FETCH_BINDING'],
    [new TypeError('AbortSignal.timeout is not a function ' + marker), 'RUNTIME_UNSUPPORTED_API'],
    [Object.assign(new Error(marker), { name: 'TimeoutError' }), 'UPSTREAM_TIMEOUT'],
    [new Error('DNS ENOTFOUND ' + marker), 'UPSTREAM_DNS_ERROR'],
    [new Error('TLS certificate failure ' + marker), 'UPSTREAM_TLS_ERROR'],
    [new TypeError('Invalid request header ' + marker), 'RUNTIME_FETCH_ARGUMENT'],
    [new Error(marker), 'UPSTREAM_CONNECTION_FAILED']
  ];
  for (const [error, expected] of cases) {
    const worker = createWorker(async () => { throw error; });
    const body = await (await worker.fetch(request('tools/call', { name: 'list_calendars' }), ENV)).json();
    assert.equal(body.result.structuredContent.error.code, expected);
    assert.ok(!JSON.stringify(body).includes(marker)); assert.ok(!JSON.stringify(body).includes(ENV.CALDAV_PASSWORD));
  }
});
test('write transport failure remains unknown and never auto-retries', async () => {
  let calls = 0; const dav = new CalDAV(ENV, async () => { calls++; throw new TypeError('Illegal invocation'); });
  await assert.rejects(() => dav.put({ calendar_id: CALENDAR }, CALENDAR + 'fixture.ics', 'fixture', '"v1"'), error => error.code === 'WRITE_RESULT_UNKNOWN' && error.message.includes('RUNTIME_FETCH_BINDING'));
  assert.equal(calls, 1);
});
test('response body transport failures are classified safely too', async () => {
  const dav = new CalDAV(ENV, async () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('private body detail'), { name: 'TimeoutError' })); } }), { status: 207 }));
  await assert.rejects(() => dav.calendars(), error => error.code === 'UPSTREAM_TIMEOUT' && !error.message.includes('private body'));
});
