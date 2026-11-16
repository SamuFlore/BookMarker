import test from 'node:test';
import assert from 'node:assert/strict';
import { GistError, createGistClient } from '../src/lib/gist.js';

const TOKEN = 'ghp_test_token';
const GIST_ID = 'abc123';
const FILENAME = 'samubookmarker.json';
const GIST_URL = `https://api.github.com/gists/${GIST_ID}`;

const ENVELOPE = { v: 1, alg: 'A256GCM', ciphertext: 'AAAA', iv: 'BBBB' };

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, init.headers || {})
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: init.headers || {}
  });
}

function createFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url, method: init.method, headers: init.headers || {}, body: init.body, init };
    calls.push(call);
    return handler(call, calls);
  };
  return { fetchImpl, calls };
}

function createClient(handler, overrides = {}) {
  const { fetchImpl, calls } = createFetch(handler);
  const client = createGistClient({
    token: TOKEN,
    gistId: GIST_ID,
    fetchImpl,
    timeoutMs: 2000,
    ...overrides
  });
  return { client, calls };
}

async function expectGistError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof GistError, `expected GistError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('read() parses the stored envelope and sends documented headers', async () => {
  const { client, calls } = createClient(() => jsonResponse(
    { files: { [FILENAME]: { content: JSON.stringify(ENVELOPE) } } },
    { headers: { etag: 'W/"etag-1"' } }
  ));

  const result = await client.read();
  assert.deepEqual(result, { envelope: ENVELOPE, etag: 'W/"etag-1"', unchanged: false });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.url, GIST_URL);
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers.Accept, 'application/vnd.github+json');
  assert.equal(call.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(call.headers['If-None-Match'], undefined);
});

test('read() returns unchanged on 304 and reuses the cached etag', async () => {
  let round = 0;
  const { client, calls } = createClient(() => {
    round += 1;
    if (round === 1) {
      return jsonResponse(
        { files: { [FILENAME]: { content: JSON.stringify(ENVELOPE) } } },
        { headers: { etag: 'W/"etag-1"' } }
      );
    }
    return new Response(null, { status: 304 });
  });

  const first = await client.read();
  assert.equal(first.unchanged, false);

  const second = await client.read();
  assert.deepEqual(second, { envelope: null, etag: 'W/"etag-1"', unchanged: true });
  assert.equal(calls[1].headers['If-None-Match'], 'W/"etag-1"');
});

test('read() reports a missing or empty file as a null envelope', async () => {
  const missing = createClient(() => jsonResponse({ files: {} }));
  assert.deepEqual(await missing.client.read(), {
    envelope: null,
    etag: null,
    unchanged: false
  });

  const empty = createClient(() => jsonResponse({ files: { [FILENAME]: { content: '' } } }));
  assert.deepEqual(await empty.client.read(), {
    envelope: null,
    etag: null,
    unchanged: false
  });

  const blank = createClient(() => jsonResponse({ files: { [FILENAME]: { content: '\n  ' } } }));
  assert.deepEqual(await blank.client.read(), {
    envelope: null,
    etag: null,
    unchanged: false
  });
});

test('write() PATCHes the file and returns the response etag', async () => {
  const { client, calls } = createClient(() => jsonResponse(
    { files: { [FILENAME]: { content: '{}' } } },
    { headers: { etag: 'W/"etag-2"' } }
  ));

  const result = await client.write(ENVELOPE);
  assert.deepEqual(result, { etag: 'W/"etag-2"' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, GIST_URL);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].body), {
    files: { [FILENAME]: { content: JSON.stringify(ENVELOPE) } }
  });
});

test('write() falls back to the cached etag when the response omits one', async () => {
  const { client } = createClient((call) => {
    if (call.method === 'PATCH') return jsonResponse({});
    return jsonResponse(
      { files: { [FILENAME]: { content: JSON.stringify(ENVELOPE) } } },
      { headers: { etag: 'W/"cached"' } }
    );
  });

  await client.read();
  assert.deepEqual(await client.write(ENVELOPE), { etag: 'W/"cached"' });
});

test('maps 401 to UNAUTHORIZED', async () => {
  const { client } = createClient(() => jsonResponse({ message: 'Bad credentials' }, { status: 401 }));
  await expectGistError(client.read(), 'UNAUTHORIZED');
});

test('maps 403 with an exhausted rate limit to RATE_LIMITED', async () => {
  const { client } = createClient(() => jsonResponse(
    { message: 'API rate limit exceeded' },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
  ));
  await expectGistError(client.read(), 'RATE_LIMITED');
});

test('maps a plain 403 to UNAUTHORIZED and exposes scopes in details', async () => {
  const { client } = createClient(() => jsonResponse(
    { message: 'Resource not accessible by personal access token' },
    { status: 403, headers: { 'x-ratelimit-remaining': '4999', 'x-oauth-scopes': 'gist' } }
  ));
  await assert.rejects(client.read(), (error) => {
    assert.ok(error instanceof GistError);
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.equal(error.details.scopes, 'gist');
    assert.match(error.details.message, /Resource not accessible/);
    return true;
  });
});

test('maps 404 to NOT_FOUND', async () => {
  const { client } = createClient(() => jsonResponse({ message: 'Not Found' }, { status: 404 }));
  await expectGistError(client.read(), 'NOT_FOUND');
  await expectGistError(client.write(ENVELOPE), 'NOT_FOUND');
});

test('maps 422 and 5xx to SERVER', async () => {
  const invalid = createClient(() => jsonResponse({ message: 'Validation Failed' }, { status: 422 }));
  await assert.rejects(invalid.client.write(ENVELOPE), (error) => {
    assert.equal(error.code, 'SERVER');
    assert.equal(error.details.message, 'Validation Failed');
    return true;
  });

  const unavailable = createClient(() => jsonResponse({ message: 'boom' }, { status: 503 }));
  await expectGistError(unavailable.client.read(), 'SERVER');
});

test('maps a thrown fetch to NETWORK', async () => {
  const { client } = createClient(() => {
    throw new Error('dns down');
  });
  await assert.rejects(client.read(), (error) => {
    assert.equal(error.code, 'NETWORK');
    assert.match(error.message, /dns down/);
    return true;
  });
});

test('maps a timeout to NETWORK', async () => {
  const { fetchImpl } = createFetch(() => new Promise(() => {}));
  const client = createGistClient({
    token: TOKEN,
    gistId: GIST_ID,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    timeoutMs: 20
  });
  await expectGistError(client.read(), 'NETWORK');
  assert.ok(fetchImpl);
});

test('没有 token 也能读，写入才要求 token', async () => {
  const { client, calls } = createClient(
    () => jsonResponse(
      { files: { [FILENAME]: { content: JSON.stringify(ENVELOPE) } } },
      { headers: { etag: 'W/"anon"' } }
    ),
    { token: '   ' }
  );
  const result = await client.read();
  assert.deepEqual(result.envelope, ENVELOPE);
  assert.equal('Authorization' in calls[0].headers, false, '匿名读取不得带 Authorization');
  await expectGistError(client.write(ENVELOPE), 'TOKEN_REQUIRED');
});

test('read() follows raw_url when the file is truncated', async () => {
  const rawUrl = `https://gist.githubusercontent.com/u/${GIST_ID}/raw/samubookmarker.json`;
  const { client, calls } = createClient((call) => {
    if (call.url === rawUrl) {
      return textResponse(JSON.stringify(ENVELOPE), { headers: { etag: 'W/"raw"' } });
    }
    return jsonResponse(
      {
        files: {
          [FILENAME]: { content: 'gist truncated payload', truncated: true, raw_url: rawUrl }
        }
      },
      { headers: { etag: 'W/"etag-3"' } }
    );
  });

  const result = await client.read();
  assert.deepEqual(result, { envelope: ENVELOPE, etag: 'W/"etag-3"', unchanged: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, rawUrl);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].headers.Authorization, `Bearer ${TOKEN}`);
});

test('read() raises SERVER when the raw fetch fails', async () => {
  const rawUrl = `https://gist.githubusercontent.com/u/${GIST_ID}/raw/samubookmarker.json`;
  const { client } = createClient((call) => {
    if (call.url === rawUrl) {
      return jsonResponse({ message: 'nope' }, { status: 500 });
    }
    return jsonResponse({
      files: { [FILENAME]: { content: '', truncated: true, raw_url: rawUrl } }
    });
  });
  await expectGistError(client.read(), 'SERVER');
});

test('probe() reports readability, write access and login', async () => {
  const { client } = createClient((call) => {
    if (call.url === 'https://api.github.com/user') return jsonResponse({ login: 'samu' });
    return jsonResponse({ owner: { login: 'samu' } });
  });
  assert.deepEqual(await client.probe(), { ok: true, canWrite: true, login: 'samu' });
});

test('probe() reports no write access for a foreign gist', async () => {
  const { client } = createClient((call) => {
    if (call.url === 'https://api.github.com/user') return jsonResponse({ login: 'samu' });
    return jsonResponse({ owner: { login: 'someone-else' } });
  });
  assert.deepEqual(await client.probe(), { ok: true, canWrite: false, login: 'samu' });
});

test('probe() survives an unreadable gist and a failing user lookup', async () => {
  const { client } = createClient((call) => {
    if (call.url === 'https://api.github.com/user') return jsonResponse({}, { status: 500 });
    return jsonResponse({ message: 'Not Found' }, { status: 404 });
  });
  assert.deepEqual(await client.probe(), { ok: false, canWrite: false, login: null });
});

test('never issues a POST (gist creation is user-driven)', async () => {
  const { client, calls } = createClient((call) => {
    if (call.url === 'https://api.github.com/user') return jsonResponse({ login: 'samu' });
    if (call.method === 'PATCH') return jsonResponse({}, { headers: { etag: 'W/"p"' } });
    if (call.headers['If-None-Match']) return new Response(null, { status: 304 });
    return jsonResponse(
      { owner: { login: 'samu' }, files: { [FILENAME]: { content: JSON.stringify(ENVELOPE) } } },
      { headers: { etag: 'W/"i"' } }
    );
  });

  await client.read();
  await client.read();
  await client.write(ENVELOPE);
  await client.probe();

  assert.ok(calls.length >= 5);
  assert.deepEqual(
    calls.filter((call) => call.method === 'POST'),
    []
  );
  assert.deepEqual(
    [...new Set(calls.map((call) => call.method))].sort(),
    ['GET', 'PATCH']
  );
});
