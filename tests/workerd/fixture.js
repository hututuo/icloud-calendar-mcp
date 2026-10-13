const wrap = body => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/fixture/</d:href><d:propstat><d:prop>${body}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
export default {
  fetch(request) {
    if (request.method !== 'PROPFIND') throw new Error('Fixture is read-only.');
    const path = new URL(request.url).pathname;
    let body;
    if (path === '/') body = wrap('<d:current-user-principal><d:href>https://p01-caldav.icloud.com/fixture/principal/</d:href></d:current-user-principal>');
    else if (path === '/fixture/principal/') body = wrap('<c:calendar-home-set><d:href>https://p42-caldav.icloud.com.cn:443/fixture/calendars/</d:href></c:calendar-home-set>');
    else if (path === '/fixture/calendars/') body = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/fixture/calendars/personal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Runtime fixture</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
    else throw new Error('Unexpected fixture route.');
    return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } });
  }
};
