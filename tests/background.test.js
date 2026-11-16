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
  assert.equal(initial.settings.syncMode, 'pull-overwrite', '默认同步方式应为拉取覆盖');
  assert.deepEqual(initial.log, []);

  const saved = await env.send({
    type: 'SAVE_SETTINGS',
    settings: {
      token: 'ghp_test',
      passphrase: '口令{{PASSWORD_hzpf5wor}}',
      gistId: 'https://gist.github.com/samu/deadbeef1234',
      deviceName: '桌面 Chrome',
      syncMode: 'push',
    },
  });
  assert.equal(saved.ok, true);
  assert.equal((await env.send({ type: 'GET_STATE' })).settings.syncMode, 'push', '推送模式应持久化');

  const afterSave = await env.send({ type: 'GET_STATE' });
  assert.equal(afterSave.settings.hasToken, true);
  assert.equal(afterSave.settings.hasPassphrase, true);
  assert.equal(afterSave.settings.gistId, 'deadbeef1234', '应能从完整网址提取 Gist ID');
  assert.equal(afterSave.settings.deviceName, '桌面 Chrome');

  await env.bookmarks.create({ parentId: '1', title: '示例', url: 'https://example.test' });
  const planned = await env.send({ type: 'SYNC_NOW' });
  assert.equal(planned.ok, true, JSON.stringify(planned.error ?? {}));
  assert.equal(planned.confirmRequired, true, '推送会覆盖 Gist，必须先预览确认');
  assert.equal(planned.preview.mode, 'push');
  const synced = await env.send({ type: 'SYNC_CONFIRM', fingerprint: planned.preview.fingerprint });
  assert.equal(synced.ok, true, JSON.stringify(synced.error ?? {}));
  assert.equal(synced.summary.pushed, 1);
  assert.ok(github.state.content.length > 0, '应写入远端');
  assert.ok(!github.state.content.includes('example.test'), '远端内容必须是密文');
  assert.ok(github.state.calls.every(call => call.method === 'GET' || call.method === 'PATCH'));

  const finalState = await env.send({ type: 'GET_STATE' });
  assert.equal(finalState.status.lastSummary.created + finalState.status.lastSummary.updated >= 0, true);
  assert.equal(typeof finalState.status.lastSyncAt, 'number');
  assert.ok(finalState.log.length > 0);
  assert.equal(finalState.status.lastError, null);

  // 切到“拉取覆盖”后，本机多出来的那一条必须先预览、确认，才会被删除
  await env.bookmarks.create({ parentId: '1', title: '本机独有', url: 'https://local-only.test' });
  const toggled = await env.send({ type: 'SAVE_SETTINGS', settings: { syncMode: 'pull-overwrite' } });
  assert.equal(toggled.ok, true);
  assert.equal((await env.send({ type: 'GET_STATE' })).settings.syncMode, 'pull-overwrite', '同步方式应持久化');

  const dryRun = await env.send({ type: 'SYNC_NOW' });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.confirmRequired, true, '拉取并覆盖前必须先预览确认');
  assert.equal(dryRun.preview.deleteCount, 1);
  assert.equal(dryRun.summary, null, '预览不得产生同步结果');
  assert.ok(env.bookmarks.paths().some(path => path.includes('本机独有')), '预览不得删除任何书签');

  const cancelled = await env.send({ type: 'SYNC_CANCEL' });
  assert.equal(cancelled.ok, true);
  const afterCancel = await env.send({ type: 'SYNC_CONFIRM', fingerprint: dryRun.preview.fingerprint });
  assert.equal(afterCancel.ok, false, '取消后旧计划必须失效');
  assert.equal(afterCancel.error.code, 'PLAN_EXPIRED');

  const again = await env.send({ type: 'SYNC_NOW' });
  const applied = await env.send({ type: 'SYNC_CONFIRM', fingerprint: again.preview.fingerprint });
  assert.equal(applied.ok, true, JSON.stringify(applied.error ?? {}));
  assert.equal(applied.summary.removed, 1);
  assert.equal(env.bookmarks.paths().some(path => path.includes('本机独有')), false, '确认后本机独有项应被删除');
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
test('后台：动作随 SYNC_NOW 一起下发，选推送就按推送执行且不动本机', async () => {
  const github = createFakeGitHub();
  const env = installFakeChrome(github);
  await import('../src/background.js');

  await env.send({
    type: 'SAVE_SETTINGS',
    settings: { token: 'ghp_test', passphrase: '口令', gistId: 'abc123def456', syncMode: 'pull-overwrite' },
  });
  await env.bookmarks.create({ parentId: '1', title: '本机独有', url: 'https://local-only.test' });

  const planned = await env.send({ type: 'SYNC_NOW', syncMode: 'push' });
  assert.equal(planned.ok, true, JSON.stringify(planned.error ?? {}));
  assert.equal(planned.preview.mode, 'push', '应按请求里带的动作执行，而不是存储里的旧动作');
  assert.equal(planned.confirmRequired, true);

  const done = await env.send({ type: 'SYNC_CONFIRM', fingerprint: planned.preview.fingerprint });
  assert.equal(done.ok, true, JSON.stringify(done.error ?? {}));
  assert.deepEqual(env.bookmarks.paths(), ['书签栏/本机独有 <https://local-only.test>'], '推送不得删除本机书签');
  assert.ok(github.state.content.length > 0, '远端应被写入');
  assert.equal((await env.send({ type: 'GET_STATE' })).settings.syncMode, 'push', '动作应被记住');
});
