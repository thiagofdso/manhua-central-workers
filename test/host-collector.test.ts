import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostCollector } from '../src/host-collector-server.ts';

test('host collector authenticates requests and rejects other providers', async () => {
  const server = createHostCollector('test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(url + '/healthz')).status, 401);
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/healthz', { headers })).status, 200);
    for (const [route, payload] of [
      ['/collect-catalog', { domain: 'manhuatop.org', query: '', page: 1 }],
      ['/collect-cover', { pageURL: 'https://manhuatop.org/manga/test/' }],
      ['/collect-cover', { pageURL: 'http://127.0.0.1/private' }],
      ['/extract-chapter', { url: 'https://manhuatop.org/manga/test/ch-1', domain: 'manhuatop.org' }],
    ] as const) {
      assert.equal((await fetch(url + route, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 400);
    }
    assert.equal((await fetch(url + '/unknown-route', { method: 'POST', headers })).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
