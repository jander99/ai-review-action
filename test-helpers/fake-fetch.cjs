/**
 * Scripted `globalThis.fetch` stub shared by adapter conformance tests.
 *
 * Each script entry answers one call, in order; the last entry repeats.
 * `'hang'` never settles unless the caller aborts (via `init.signal`), which
 * is how the timeout case is exercised.
 */

function installFakeFetch(script) {
  const calls = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    const entry = script[Math.min(i, script.length - 1)];
    i++;
    const headers = {};
    const raw = init.headers;
    if (typeof Headers !== 'undefined' && raw instanceof Headers) {
      raw.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) headers[k.toLowerCase()] = v;
    } else if (raw) {
      for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : String(init.body ?? ''),
    });
    if (entry === 'hang') {
      return new Promise((_, reject) => {
        const signal = init.signal;
        const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
    return new Response(body, {
      status: entry.status,
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

module.exports = { installFakeFetch };
