import { runtimeFetch } from '../src/runtime.js';
import { AppError, fail, boundedBody, safeError } from '../src/common.js';
import { TOOLS, callTool } from '../src/tools.js';
import { PAGE, SCRIPT } from '../src/page.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18'];
const SECURITY = {
  'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://chatgpt.com; img-src 'self' data:",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8' } }); }
function rpc(id, result) { return json({ jsonrpc: '2.0', id, result }); }
function rpcError(id, code, message, status = 200, data) { return json({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }, status); }
export function authenticatedUser(request, env, requireBound = true) {
  // Trust only Sites dispatch's injected identity. Never mount this Worker on a bypass origin.
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id || id.length > 512 || /[\r\n]/.test(id)) fail('UNAUTHENTICATED', 'Sign in through this private Site’s ChatGPT connection.', 401);
  if (env.OWNER_USER_ID && id !== env.OWNER_USER_ID) fail('FORBIDDEN', 'This calendar connection is restricted to its configured owner.', 403);
  if (requireBound && !env.OWNER_USER_ID) fail('OWNER_NOT_CONFIGURED', 'The Site owner identity has not been securely bound.', 503);
  return id;
}
function isValidId(id) { return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)); }
export function createWorker(fetcher = runtimeFetch) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/mcp') {
          const origin = request.headers.get('origin');
          if (origin && origin !== url.origin) return json({ error: 'Cross-origin browser requests are not permitted.' }, 403);
          if (request.method !== 'POST') return json({ error: 'Only stateless POST is supported.' }, 405);
          if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return rpcError(null, -32600, 'Use application/json.', 415);
          const requestedVersion = request.headers.get('mcp-protocol-version');
          if (requestedVersion && !PROTOCOLS.includes(requestedVersion)) return rpcError(null, -32600, 'Unsupported MCP protocol version.', 400);
          let message;
          try { message = JSON.parse(await boundedBody(request, 64 * 1024)); }
          catch (error) { return rpcError(null, error instanceof AppError ? -32600 : -32700, 'Invalid or oversized JSON request.', 400); }
          if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(null, -32600, 'Invalid JSON-RPC request.', 400);
          const hasId = Object.hasOwn(message, 'id');
          if (hasId && !isValidId(message.id)) return rpcError(null, -32600, 'A request ID must be a string or finite number.', 400);
          if (!hasId) {
            if (message.method.startsWith('notifications/')) return new Response(null, { status: 202, headers: SECURITY });
            return rpcError(null, -32600, 'A request ID is required.', 400);
          }
          const { id, method } = message;
          if (method === 'initialize') {
            const requested = message.params?.protocolVersion;
            return rpc(id, { protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'icloud-calendar-mcp', version: '0.2.0' }, instructions: 'Owner-only iCloud calendar adapter. Server credentials are configured securely outside tool calls. Read first; writes default off. Reuse create_event UID on retries. Never silently convert an occurrence edit into a series edit.' });
          }
          if (method === 'ping') return rpc(id, {});
          if (method === 'tools/list') return rpc(id, { tools: TOOLS });
          if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found.');
          try {
            authenticatedUser(request, env, true);
            if (!message.params || typeof message.params.name !== 'string') return rpcError(id, -32602, 'Tool name is required.');
            const result = await callTool(message.params.name, message.params.arguments ?? {}, env, fetcher);
            return rpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
          } catch (error) {
            if (error instanceof AppError && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code)) return rpcError(id, -32001, error.message, error.status, { code: error.code });
            const detail = safeError(error);
            return rpc(id, { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }], structuredContent: { error: detail } });
          }
        }
        if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
        if (['/', '/api/status', '/app.js'].includes(url.pathname)) {
          const userId = authenticatedUser(request, env, false);
          if (url.pathname === '/api/status') return json({ authenticated_subject: userId, owner_bound: Boolean(env.OWNER_USER_ID), credentials_configured: Boolean(env.CALDAV_USERNAME && env.CALDAV_PASSWORD), configured: Boolean(env.OWNER_USER_ID && env.CALDAV_USERNAME && env.CALDAV_PASSWORD), write_enabled: env.WRITE_ENABLED === 'true', calendar_scope_configured: Boolean(env.CALDAV_ALLOWED_CALENDAR_URLS), live_icloud_verified: false });
          return new Response(url.pathname === '/' ? PAGE : SCRIPT, { headers: { ...SECURITY, 'Content-Type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' } });
        }
        return json({ error: 'Not found.' }, 404);
      } catch (error) {
        const detail = safeError(error);
        return json({ error: detail }, error instanceof AppError ? error.status : 500);
      }
    }
  };
}
export default createWorker();
