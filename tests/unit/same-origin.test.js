// Cross-site request guard (netlify/functions/lib/same-origin.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { crossOriginRejection } = require('../../netlify/functions/lib/same-origin');

const ev = (headers) => ({ headers });

test('allows requests with no Origin (curl, server-to-server, tests)', () => {
  assert.equal(crossOriginRejection(ev({ host: 'localhost:8888' })), null);
  assert.equal(crossOriginRejection({}), null);
});
test('allows same-origin browser requests', () => {
  assert.equal(crossOriginRejection(ev({ host: 'localhost:8888', origin: 'http://localhost:8888' })), null);
  assert.equal(crossOriginRejection(ev({ Host: 'app.example.com', Origin: 'https://app.example.com' })), null);
});
test('refuses another website, a different port, and opaque "null" origins', () => {
  for (const origin of ['https://evil.example', 'http://localhost:9999', 'null', 'not a url']) {
    const r = crossOriginRejection(ev({ host: 'localhost:8888', origin }));
    assert.equal(r?.statusCode, 403, origin);
  }
});
