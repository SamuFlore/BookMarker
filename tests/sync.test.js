import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBookmarks, createMemoryStorage } from './helpers/fake-bookmarks.mjs';
import { createStore } from '../src/lib/store.js';
import { createSyncService, SyncError } from '../src/lib/sync.js';
import { encryptPayload, decryptPayload } from '../src/lib/crypto.js';

const SETTINGS = { token: 'ghp_test', passphrase: '正确的口令 pass-2024', gistId: 'gist123', filename: 'samubookmarker.json' };

function createSharedGist() {
  const state = { envelope: null, writes: 0, reads: 0 };
  const factory = ({ token, gistId, filename }) => ({
    async read() {
      if (!token || !gistId || !filename) throw new Error('bad client config');
      state.reads += 1;
      return { envelope: state.envelope, etag: 'etag-' + state.reads, unchanged: false };
    },
    async write(envelope) {
      state.writes += 1;
      state.envelope = envelope;
      return { etag: 'etag-w' + state.writes };
    },
  });
  return { state, factory };
}

function createDevice(name, gist, startedAt = 1_000) {
  const clock = { value: startedAt };
  const bookmarks = createFakeBookmarks();
  const store = createStore(createMemoryStorage(), { now: () => clock.value });
  const logs = [];
  const service = createSyncService({
    log: (level, text) => logs.push({ level, text }),
    bookmarks,
    store,
    createGistClient: gist.factory,
    encryptPayload,
    decryptPayload,
    now: () => clock.value,
    deviceId: name,
  });
  return {
    name,
    bookmarks,
    store,
    service,
    clock,
    logs,
    async configure(over = {}) {
      await store.saveSettings({ ...SETTINGS, ...over });
    },
    async sync() {
      return service.syncNow();
    },
  };
}

test('首次同步写入快照，第二台设备拉取到完整书签树', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure();

  const folder = await a.bookmarks.create({ parentId: '1', title: '工作' });
  await a.bookmarks.create({ parentId: folder.id, title: 'Inbox', url: 'https://inbox.test' });
  await a.bookmarks.create({ parentId: '2', title: '阅读', url: 'https://read.test' });

  const firstA = await a.sync();
  assert.equal(firstA.summary.total, 3);
  assert.equal(firstA.summary.removed, 0);
  assert.ok(gist.state.envelope);

  const firstB = await b.sync();
  assert.equal(firstB.summary.created, 3, 'B 应新建 3 个节点');
  assert.deepEqual(b.bookmarks.paths().sort(), [
    '其他书签/阅读 <https://read.test>',
    '书签栏/工作',
    '书签栏/工作/Inbox <https://inbox.test>',
  ].sort());
});

test('删除借助墓碑跨设备传播', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure();

  const keep = await a.bookmarks.create({ parentId: '1', title: '保留', url: 'https://keep.test' });
  const doomed = await a.bookmarks.create({ parentId: '1', title: '待删', url: 'https://gone.test' });
  await a.sync();
  await b.sync();
  assert.ok(b.bookmarks.paths().some(path => path.includes('待删')));

  a.clock.value = 5_000;
  await a.bookmarks.remove(doomed.id);
  const deletion = await a.sync();
  assert.equal(deletion.summary.removed, 0, '本地已不存在该项，无需删除');

  b.clock.value = 6_000;
  const pulled = await b.sync();
  assert.equal(pulled.summary.removed, 1);
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/保留 <https://keep.test>']);
  assert.ok(keep.id.length > 0);
});

test('同一项并发改名时按最后写入优先收敛到两边一致', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 1_000);
  await a.configure();
  await b.configure();

  const created = await a.bookmarks.create({ parentId: '1', title: '原始标题', url: 'https://shared.test' });
  await a.sync();
  await b.sync();

  const bNode = b.bookmarks.paths();
  assert.deepEqual(bNode, ['书签栏/原始标题 <https://shared.test>']);

  a.clock.value = 2_000;
  await a.bookmarks.update(created.id, { title: 'A 改的' });
  await a.sync();

  const bLocal = (await b.bookmarks.getChildren('1'))[0];
  b.clock.value = 3_000;
  await b.bookmarks.update(bLocal.id, { title: 'B 改的' });
  await b.sync();

  a.clock.value = 4_000;
  await a.sync();

  assert.deepEqual(a.bookmarks.paths(), ['书签栏/B 改的 <https://shared.test>']);
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/B 改的 <https://shared.test>']);
});

test('内容无变化时不重复写远端', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '一', url: 'https://one.test' });

  await a.sync();
  const writesAfterFirst = gist.state.writes;
  a.clock.value = 2_000;
  const second = await a.sync();
  assert.equal(gist.state.writes, writesAfterFirst, '第二次同步不应产生写入');
  assert.equal(second.summary.created, 0);
  assert.equal(second.summary.updated, 0);
});

test('口令错误时抛出 BAD_PASSPHRASE 且不覆盖远端', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure({ passphrase: '完全不同的口令' });

  await a.bookmarks.create({ parentId: '1', title: '秘密书签', url: 'https://secret.test' });
  await a.sync();
  const before = JSON.stringify(gist.state.envelope);

  await assert.rejects(() => b.sync(), error => {
    assert.ok(error instanceof SyncError);
    assert.equal(error.code, 'BAD_PASSPHRASE');
    return true;
  });
  assert.equal(JSON.stringify(gist.state.envelope), before, '远端内容必须保持不变');
  assert.deepEqual(b.bookmarks.paths(), []);
});

test('缺少配置时拒绝同步', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await assert.rejects(() => a.sync(), error => error.code === 'NOT_CONFIGURED');
  assert.equal(gist.state.writes, 0);
});

test('仅拉取模式：应用远端变更但不写入 Gist，关闭开关后补上传', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure({ pullOnly: false });
  await b.configure({ pullOnly: true });

  await a.bookmarks.create({ parentId: '1', title: '工作', url: 'https://a.test' });
  await a.sync();
  const envelopeAfterA = gist.state.envelope;
  assert.equal(gist.state.writes, 1);

  const bPull = await b.sync();
  assert.equal(bPull.summary.created, 1, 'B 应拉取到 A 的书签');
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/工作 <https://a.test>']);
  assert.equal(gist.state.writes, 1, '仅拉取模式不得写入 Gist');
  assert.equal(gist.state.envelope, envelopeAfterA, '远端信封应保持不变');
  assert.equal(bPull.summary.pushed, 0);

  await b.bookmarks.create({ parentId: '1', title: 'B 本地', url: 'https://b.test' });
  const bLocal = await b.sync();
  assert.equal(bLocal.summary.created, 0);
  assert.equal(gist.state.writes, 1, '本机改动同样不得上传');
  assert.ok(b.logs.some(entry => entry.text.includes('仅拉取模式')), '应记录跳过上传');

  await b.configure({ pullOnly: false });
  const bPush = await b.sync();
  assert.equal(gist.state.writes, 2, '关闭仅拉取后应补上传');
  assert.equal(bPush.summary.pushed, 2);

  const c = createDevice('dev-c', gist, 3_000);
  await c.configure();
  await c.sync();
  assert.deepEqual(c.bookmarks.paths().sort(), [
    '书签栏/B 本地 <https://b.test>',
    '书签栏/工作 <https://a.test>',
  ]);
});

test('远端密文里不出现明文书签标题', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '极密标题XYZ', url: 'https://topsecret.test' });
  await a.sync();
  const raw = JSON.stringify(gist.state.envelope);
  assert.ok(!raw.includes('极密标题XYZ'));
  assert.ok(!raw.includes('topsecret.test'));
  assert.equal(typeof gist.state.envelope.ciphertext, 'string');
});
