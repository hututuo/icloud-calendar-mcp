import worker from './app.js';
export default {
  async test() {
    // Exact pre-fix calling convention, tested against real native workerd fetch.
    const oldClient = { fetcher: fetch }; let reproduced = false;
    try { await oldClient.fetcher('https://caldav.icloud.com/', { method: 'PROPFIND' }); }
    catch (error) { reproduced = /illegal invocation/i.test(error.message); }
    if (!reproduced) throw new Error('Old native-fetch receiver defect was not reproduced.');
    const request = new Request('https://fixture.chatgpt.site/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'runtime-fixture-owner' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_calendars', arguments: {} } })
    });
    const response = await worker.fetch(request, { OWNER_USER_ID: 'runtime-fixture-owner', CALDAV_USERNAME: 'runtime-fixture@example.invalid', CALDAV_PASSWORD: 'runtime-fixture-not-a-real-password', CALDAV_ALLOWED_REGIONAL_HOSTS: '["p42-caldav.icloud.com.cn"]' });
    const result = await response.json();
    if (response.status !== 200 || result.result?.isError || result.result.structuredContent.calendars[0]?.name !== 'Runtime fixture' || new URL(result.result.structuredContent.calendars[0].calendar_id).hostname !== 'p42-caldav.icloud.com.cn') throw new Error('Fixed Worker did not complete native-fetch mocked discovery.');
    console.log('PASS: old native fetch receiver failure reproduced; fixed bundled Worker completed read-only fixture discovery. External network disabled.');
  }
};
