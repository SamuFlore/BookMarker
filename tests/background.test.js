import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBookmarks } from './helpers/fake-bookmarks.mjs';

function header(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function createFakeGitHub(options = {}) {
  const state = { content: '', etag: 'e0', calls: [], unauthorized: options.unauthorized === true };
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    state.calls.push({ method, url: String(url) });
    if (String(url).endsWith('/user')) {
      return new Response(JSON.stringify({ login: 'samu' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const authorized = header(init.headers, 'Authorization') === 'Bearer ghp_test';
    if (!authorized || state.unauthorized) {
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    }
    if (!/api\.github\.com\/gists\//.test(String(url))) {
      throw new Error('unexpected url ' + url);
    }
    if (method === 'GET') {
      const ifNoneMatch = header(init.headers, 'If-None-Match');
      if (state.content && ifNoneMatch && ifNoneMatch === state.etag) {
        return new Response(null, { status: 304 });
      }
      const body = { files: { 'samubookmarker.json': { content: state.content, truncated: false } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag: state.etag } });
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      state.content = body.files['samubookmarker.json'].content;
      state.etag = 'e' + (Number(state.etag.slice(1)) + 1);
      return new Response(JSON.stringify({ id: 'gist1' }), { status: 200, headers: { 'content-type': 'application/json', etag: state.etag } });
    }
    throw new Error('method must never be ' + method);
  };
  return { state, fetchImpl };
}

const host = {
  bookmarks: createFakeBookmarks(),
  bag: new Map(),
  listeners: [],
};

function ensureChromeStub() {
  if (globalThis.chrome) return;
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: listener => host.listeners.push(listener) },
      onInstalled: { addListener: () => {} },
      get lastError() {
        return undefined;
      },
    },
    bookmarks: {
      getTree: () => host.bookmarks.getTree(),
      getChildren: id => host.bookmarks.getChildren(id),
      create: payload => host.bookmarks.create(payload),
      update: (id, patch) => host.bookmarks.update(id, patch),
      move: (id, destination) => host.bookmarks.move(id, destination),
      remove: id => host.bookmarks.remove(id),
    },
    storage: {
      local: {
        get: async key => ({ [key]: host.bag.get(key) }),
        set: async obj => {
          for (const [key, value] of Object.entries(obj)) host.bag.set(key, value);
        },
      },
    },
  };
}

function installFakeChrome(github) {
  host.bookmarks = createFakeBookmarks();
  host.bag.clear();
  globalThis.fetch = github.fetchImpl;
  ensureChromeStub();

  return {
    bookmarks: host.bookmarks,
    bag: host.bag,
    async send(message) {
      assert.equal(host.listeners.length, 1, 'background 应注册且仅注册一个 onMessage 监听器');
      return new Promise((resolve, reject) => {
        const returned = host.listeners[0](message, {}, response => resolve(response));
        if (returned !== true) reject(new Error('onMessage 监听器必须返回 true 以保持异步响应通道'));
      });
    },
  };
}

process.env.NODE_NO_WARNINGS = '1';

test('后台：保存设置 → 立即同步 → 跨设备拉取，消息协议端到端可用', async () => {
  const github = createFakeGitHub();
  const env = installFakeChrome(github);
  await import('../src/background.js');

  const initial = await env.send({ type: 'GET_STATE' });
  assert.equal(initial.ok, true);
  assert.equal(initial.settings.hasToken, false);
  assert.equal(initial.settings.filename, 'samubookmarker.json');
  assert.equal(initial.settings.pullOnly, false);
  assert.deepEqual(initial.log, []);

  const saved = await env.send({
    type: 'SAVE_SETTINGS',
    settings: {
      token: 'ghp_test',
      passphrase: '口令{{PASSWORD_hzpf5wor}}',
      gistId: 'https://gist.github.com/samu/deadbeef1234',
      deviceName: '桌面 Chrome',
    },
  });
  assert.equal(saved.ok, true);

  const afterSave = await env.send({ type: 'GET_STATE' });
  assert.equal(afterSave.settings.hasToken, true);
  assert.equal(afterSave.settings.hasPassphrase, true);
  assert.equal(afterSave.settings.gistId, 'deadbeef1234', '应能从完整网址提取 Gist ID');
  assert.equal(afterSave.settings.deviceName, '桌面 Chrome');

  await env.bookmarks.create({ parentId: '1', title: '示例', url: 'https://example.test' });
  const synced = await env.send({ type: 'SYNC_NOW' });
  assert.equal(synced.ok, true, JSON.stringify(synced.error ?? {}));
  assert.ok(github.state.content.length > 0, '应写入远端');
  assert.ok(!github.state.content.includes('example.test'), '远端内容必须是密文');
  assert.ok(github.state.calls.every(call => call.method === 'GET' || call.method === 'PATCH'));

  const finalState = await env.send({ type: 'GET_STATE' });
  assert.equal(finalState.status.lastSummary.created + finalState.status.lastSummary.updated >= 0, true);
  assert.equal(typeof finalState.status.lastSyncAt, 'number');
  assert.ok(finalState.log.length > 0);
  assert.equal(finalState.status.lastError, null);

  const toggled = await env.send({ type: 'SAVE_SETTINGS', settings: { pullOnly: true } });
  assert.equal(toggled.ok, true);
  const afterToggle = await env.send({ type: 'GET_STATE' });
  assert.equal(afterToggle.settings.pullOnly, true, '仅拉取开关应持久化');
});

test('后台：凭据错误时把 UNAUTHORIZED 映射成可读提示且不改动本地', async () => {
  const github = createFakeGitHub({ unauthorized: true });
  const env = installFakeChrome(github);
  await import('../src/background.js');

  await env.send({
    type: 'SAVE_SETTINGS',
    settings: { token: 'ghp_test', passphrase: '口令', gistId: 'abc123def456' },
  });
  const result = await env.send({ type: 'SYNC_NOW' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNAUTHORIZED');
  assert.match(result.error.message, /Token/);
  assert.deepEqual(env.bookmarks.paths(), []);

  const state = await env.send({ type: 'GET_STATE' });
  assert.equal(state.status.lastError.code, 'UNAUTHORIZED');
  assert.ok(state.log.some(entry => entry.level === 'error'));
});

test('后台：未配置时同步返回 NOT_CONFIGURED，未知消息被拒绝', async () => {
  const github = createFakeGitHub();
  const env = installFakeChrome(github);
  await import('../src/background.js');

  const result = await env.send({ type: 'SYNC_NOW' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_CONFIGURED');

  const unknown = await env.send({ type: 'DO_SOMETHING_ELSE' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_MESSAGE');
});
