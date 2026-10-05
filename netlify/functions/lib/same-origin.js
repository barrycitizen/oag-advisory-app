// Cross-site request guard for every function.
//
// The functions have no login, so the only thing standing between them and
// any other website open in the same browser is the browser's same-origin
// policy — and that only blocks READING a response, not SENDING the request.
// A plain-text POST is a "simple request" (no CORS preflight), so a page on
// evil.example could fire {"type":"delete_client",...} at
// localhost:8888/.netlify/functions/manual-entry and it would run.
//
// Browsers always attach an Origin header to cross-site POSTs, so: if an
// Origin is present and its host isn't the host this request was sent to,
// refuse it. Same-origin calls from the app, and non-browser callers
// (curl, the test suite) that send no Origin, are unaffected.
function crossOriginRejection(event) {
  const headers = event?.headers || {};
  const origin = headers.origin || headers.Origin;
  if (!origin || origin === 'null') return origin === 'null' ? forbidden() : null;
  const host = headers.host || headers.Host;
  let originHost;
  try { originHost = new URL(origin).host; } catch { return forbidden(); }
  return host && originHost === host ? null : forbidden();
}

function forbidden() {
  return { statusCode: 403, body: JSON.stringify({ error: 'Cross-site request refused.' }) };
}

module.exports = { crossOriginRejection };
