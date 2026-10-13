import { fail } from './common.js';

// Workers native fetch validates its receiver. Do not store the raw global
// function on an application object and invoke it as an instance method.
export const runtimeFetch = (input, init) => globalThis.fetch(input, init);

export function deadline(milliseconds = 20000) {
  // AbortController avoids relying on the optional AbortSignal.timeout static API.
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, dispose: () => globalThis.clearTimeout(timer) };
}

export function transportFailure(error, method, signal) {
  // Inspect only for fixed-category matching. Never return/log raw messages,
  // stacks, causes, URLs, headers, or account information.
  const name = typeof error?.name === 'string' ? error.name : '';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 1024) : '';
  const causeCode = typeof error?.cause?.code === 'string' ? error.cause.code : '';
  let code = 'UPSTREAM_CONNECTION_FAILED';
  let explanation = 'The secure connection to iCloud could not be completed.';
  if (/illegal invocation|incorrect this|incompatible receiver/i.test(message)) {
    code = 'RUNTIME_FETCH_BINDING'; explanation = 'The Worker runtime rejected the fetch receiver before a usable response.';
  } else if (/not a function|not defined|not implemented|unsupported.*(?:api|method)/i.test(message) || name === 'ReferenceError') {
    code = 'RUNTIME_UNSUPPORTED_API'; explanation = 'The Worker runtime does not support a required request API.';
  } else if (signal?.aborted || ['AbortError', 'TimeoutError'].includes(name)) {
    code = 'UPSTREAM_TIMEOUT'; explanation = 'The iCloud request exceeded its deadline or was aborted.';
  } else if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(causeCode + ' ' + message)) {
    code = 'UPSTREAM_DNS_ERROR'; explanation = 'The Worker could not resolve the approved iCloud host.';
  } else if (/CERT_|TLS|SSL|certificate/i.test(causeCode + ' ' + message)) {
    code = 'UPSTREAM_TLS_ERROR'; explanation = 'The secure TLS connection to iCloud could not be established.';
  } else if (/invalid.*(?:header|method|request)|not a valid.*(?:header|method)/i.test(message)) {
    code = 'RUNTIME_FETCH_ARGUMENT'; explanation = 'The Worker rejected a request argument before a usable response.';
  }
  if (method === 'PUT') fail('WRITE_RESULT_UNKNOWN', `The write result is unknown (${code}). Read the same UID/resource before retrying.`, 502);
  fail(code, explanation, 502);
}
