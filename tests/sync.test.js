import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBookmarks, createMemoryStorage } from './helpers/fake-bookmarks.mjs';
import { createStore } from '../src/lib/store.js';
import { createSyncService, SyncError } from '../src/lib/sync.js';
import { encryptPayload, decryptPayload } from '../src/lib/crypto.js';

const SETTINGS = { token: 'ghp_test', passphrase: '正确的口令 pass-2024', gistId: 'gist123', filename: 'samubookmarker.json', syncMode: 'pull-merge' };

// 与真实 gist.js 对齐：读可以不填 token，写必须有 token。
function createSharedGist() {
  const state = { envelope: null, writes: 0, reads: 0 };
  const factory = ({ token, gistId, filename }) => ({
    async read() {
      if (!gistId || !filename) throw new Error('bad client config');
      state.reads += 1;
      return { envelope: state.envelope, etag: 'etag-' + state.reads, unchanged: false };
    },
    async write(envelope) {
      if (!token) throw new Error('token required');
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
  const device = {
    name,
    bookmarks,
    store,
    service,
    clock,
    logs,
    async configure(over = {}) {
      await store.saveSettings({ ...SETTINGS, ...over });
    },
    // 每个动作显式选择模式；需要确认的两段式由 autoConfirm 决定是否一次跑完。
    async act(mode, over = {}) {
      const { autoConfirm = true, ...settings } = over;
      await store.saveSettings({ syncMode: mode, ...settings });
      const first = await service.run();
      if (!first.confirmRequired || !autoConfirm) return first;
      const done = await service.confirm(first.preview.fingerprint);
      return { summary: done.summary, preview: first.preview, confirmRequired: true };
    },
    push(over) { return device.act('push', over); },
    pullMerge(over) { return device.act('pull-merge', over); },
    pullOverwrite(over) { return device.act('pull-overwrite', over); },
    confirm(fingerprint) { return service.confirm(fingerprint); },
  };
  return device;
}

function seedTree(device) {
  const seed = async () => {
    const folder = await device.bookmarks.create({ parentId: '1', title: '工作' });
    await device.bookmarks.create({ parentId: folder.id, title: 'Inbox', url: 'https://inbox.test' });
    await device.bookmarks.create({ parentId: '2', title: '阅读', url: 'https://read.test' });
  };
  return seed();
}

test('推送把本机推上 Gist，另一台拉取覆盖后书签树一致', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure();

  await seedTree(a);
  const pushed = await a.push();
  assert.equal(pushed.summary.pushed, 3, '推送应写入 3 项');
  assert.ok(gist.state.envelope);

  const pulled = await b.pullOverwrite();
  assert.equal(pulled.summary.created, 3, 'B 应新建 3 个节点');
  assert.deepEqual(b.bookmarks.paths().sort(), a.bookmarks.paths().sort());
});

test('删除借助墓碑跨设备传播', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure();

  const keep = await a.bookmarks.create({ parentId: '1', title: '保留', url: 'https://keep.test' });
  const doomed = await a.bookmarks.create({ parentId: '1', title: '待删', url: 'https://gone.test' });
  await a.push();
  await b.pullOverwrite();
  assert.ok(b.bookmarks.paths().some(path => path.includes('待删')));

  a.clock.value = 5_000;
  await a.bookmarks.remove(doomed.id);
  await a.push();

  b.clock.value = 6_000;
  const pulled = await b.pullMerge();
  assert.ok(pulled.summary, '本地没有要删的东西，不需要确认');
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
  await a.push();
  await b.pullOverwrite();
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/原始标题 <https://shared.test>']);

  a.clock.value = 2_000;
  await a.bookmarks.update(created.id, { title: 'A 改的' });
  await a.push();
  assert.equal(a.bookmarks.paths()[0], '书签栏/A 改的 <https://shared.test>');

  const bLocal = (await b.bookmarks.getChildren('1'))[0];
  b.clock.value = 3_000;
  await b.bookmarks.update(bLocal.id, { title: 'B 改的' });
  const conflictOnB = await b.pullMerge();
  assert.equal(conflictOnB.summary.conflicts, 1, '同一项双改应被记为一次冲突');
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/B 改的 <https://shared.test>'], '较晚的 B 版本胜出');

  await b.push();
  a.clock.value = 4_000;
  await a.pullMerge();
  assert.deepEqual(a.bookmarks.paths(), ['书签栏/B 改的 <https://shared.test>']);
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/B 改的 <https://shared.test>']);
});

test('推送时内容没变就不重复写远端', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '一', url: 'https://one.test' });

  const first = await a.push();
  assert.equal(first.summary.pushed, 1);
  const writesAfterFirst = gist.state.writes;

  a.clock.value = 2_000;
  const second = await a.push();
  assert.equal(second.summary.pushed, 0, '内容一致时不应重复写入');
  assert.equal(gist.state.writes, writesAfterFirst);
  assert.ok(a.logs.some(entry => entry.text.includes('已经和本机一致')), '应记录跳过重复写入');
});

test('口令错误时抛出 BAD_PASSPHRASE 且不覆盖远端', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure({ passphrase: '完全不同的口令' });

  await a.bookmarks.create({ parentId: '1', title: '秘密书签', url: 'https://secret.test' });
  await a.push();
  const before = JSON.stringify(gist.state.envelope);

  await assert.rejects(() => b.pullMerge(), error => {
    assert.ok(error instanceof SyncError);
    assert.equal(error.code, 'BAD_PASSPHRASE');
    return true;
  });
  assert.equal(JSON.stringify(gist.state.envelope), before, '远端内容必须保持不变');
  assert.deepEqual(b.bookmarks.paths(), []);
});

test('没有 token 也能拉取，推送才要求 token', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure({ token: '' });

  await a.bookmarks.create({ parentId: '1', title: '公开可读', url: 'https://public.test' });
  await a.push();

  const pulled = await b.pullOverwrite();
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/公开可读 <https://public.test>']);
  assert.equal(pulled.summary.created, 1);

  await assert.rejects(() => b.push(), error => {
    assert.equal(error.code, 'TOKEN_REQUIRED');
    return true;
  });
  assert.equal(gist.state.writes, 1, '没有 token 时不得写入远端');
});

test('缺少配置时拒绝拉取与推送', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await assert.rejects(() => a.pullMerge(), error => error.code === 'NOT_CONFIGURED');
  await assert.rejects(() => a.push(), error => error.code === 'NOT_CONFIGURED');
  assert.equal(gist.state.writes, 0);
});

test('拉取合并：应用远端变更但从不写 Gist，之后推送才上传', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure();

  await a.bookmarks.create({ parentId: '1', title: '工作', url: 'https://a.test' });
  await a.push();
  const envelopeAfterA = gist.state.envelope;
  assert.equal(gist.state.writes, 1);

  const bPull = await b.pullMerge();
  assert.equal(bPull.summary.created, 1, 'B 应拉取到 A 的书签');
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/工作 <https://a.test>']);
  assert.equal(gist.state.writes, 1, '拉取合并不得写入 Gist');
  assert.equal(gist.state.envelope, envelopeAfterA, '远端信封应保持不变');
  assert.equal(bPull.summary.pushed, 0);

  await b.bookmarks.create({ parentId: '1', title: 'B 本地', url: 'https://b.test' });
  const bLocal = await b.pullMerge();
  assert.equal(bLocal.summary.created, 0);
  assert.equal(gist.state.writes, 1, '本机改动同样不得上传');
  assert.ok(b.logs.some(entry => entry.text.includes('拉取合并')), '应记录不上传');

  const bPush = await b.push();
  assert.equal(gist.state.writes, 2, '推送应写入远端');
  assert.equal(bPush.summary.pushed, 2);

  const c = createDevice('dev-c', gist, 3_000);
  await c.configure();
  await c.pullOverwrite();
  assert.deepEqual(c.bookmarks.paths().sort(), [
    '书签栏/B 本地 <https://b.test>',
    '书签栏/工作 <https://a.test>',
  ]);
});

test('拉取覆盖：本机已有同名书签被替换而不是重复追加，且不上传', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await b.configure();
  await seedTree(a);
  await seedTree(b);
  await a.push();
  assert.equal(a.bookmarks.paths().length, 3);

  const preview = await b.pullOverwrite({ autoConfirm: false });
  assert.equal(preview.confirmRequired, true, '拉取覆盖要删本机 3 项，必须先确认');
  assert.equal(preview.preview.deleteCount, 3);
  assert.equal(preview.preview.createCount, 3);
  assert.equal(b.bookmarks.paths().length, 3, '预览不得改动本机书签');
  assert.equal(gist.state.writes, 1, '预览不得写入远端');
  assert.equal((await b.store.getState()).lastSyncAt, null, '预览不得更新同步状态');

  const done = await b.confirm(preview.preview.fingerprint);
  assert.ok(done.summary.removed >= 2, '本机原有条目必须被清掉（删父文件夹会级联子项）');
  assert.equal(b.bookmarks.paths().length, 3, '拉取覆盖后仍是 3 条，不能出现重复');
  assert.equal(gist.state.writes, 1, '拉取覆盖不上传');
  assert.deepEqual(b.bookmarks.paths().sort(), [
    '书签栏/工作',
    '书签栏/工作/Inbox <https://inbox.test>',
    '其他书签/阅读 <https://read.test>',
  ]);
});

test('拉取覆盖：本机独有书签被删除，取消预览则毫发无伤', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '来自 A', url: 'https://a.test' });
  await a.push();

  await b.configure();
  await b.bookmarks.create({ parentId: '1', title: '只在 B 有', url: 'https://b-only.test' });

  const preview = await b.pullOverwrite({ autoConfirm: false });
  assert.equal(preview.confirmRequired, true);
  assert.deepEqual(preview.preview.samples.delete, ['只在 B 有'], '预览应列出将被删除的条目');
  assert.equal(b.service.cancel().cancelled, true);
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/只在 B 有 <https://b-only.test>'], '取消后本机一条都不能少');

  const again = await b.pullOverwrite({ autoConfirm: false });
  const done = await b.confirm(again.preview.fingerprint);
  assert.equal(done.summary.removed, 1);
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/来自 A <https://a.test>']);
});

test('拉取覆盖：Gist 为空时拒绝执行，指纹不符时拒绝落盘', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '本机', url: 'https://local.test' });
  await assert.rejects(a.pullOverwrite(), (error) => {
    assert.equal(error.code, 'REMOTE_EMPTY');
    return true;
  });
  assert.equal(gist.state.writes, 0, '拉取覆盖不得上传');
  assert.deepEqual(a.bookmarks.paths(), ['书签栏/本机 <https://local.test>']);

  const other = createDevice('dev-other', gist, 2_000);
  await other.configure();
  await other.bookmarks.create({ parentId: '1', title: '远端', url: 'https://remote.test' });
  await other.push();

  const preview = await a.pullOverwrite({ autoConfirm: false });
  assert.equal(preview.confirmRequired, true);
  await assert.rejects(a.confirm('过期指纹'), (error) => {
    assert.equal(error.code, 'PLAN_EXPIRED');
    return true;
  });
  assert.deepEqual(a.bookmarks.paths(), ['书签栏/本机 <https://local.test>'], '指纹不符时不得改动本机');
});

test('推送：必须确认，确认后 Gist 被本机覆盖，取消则远端不动', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  const b = createDevice('dev-b', gist, 2_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '来自 A', url: 'https://a.test' });
  await a.push();
  const envelopeFromA = gist.state.envelope;

  await b.configure();
  await b.bookmarks.create({ parentId: '1', title: '只在 B 有', url: 'https://b-only.test' });

  const preview = await b.push({ autoConfirm: false });
  assert.equal(preview.confirmRequired, true, '推送会覆盖远端，必须先确认');
  assert.equal(preview.preview.mode, 'push');
  assert.equal(preview.preview.pushCount, 1);
  assert.equal(preview.preview.overwriteCount, 1, '应算清 Gist 上会被覆盖的项数');
  assert.equal(preview.preview.needsConfirm, true);
  assert.equal(gist.state.envelope, envelopeFromA, '预览不得写入远端');

  assert.equal(b.service.cancel().cancelled, true);
  assert.equal(gist.state.envelope, envelopeFromA, '取消后远端必须原封不动');
  assert.deepEqual(b.bookmarks.paths(), ['书签栏/只在 B 有 <https://b-only.test>']);

  const again = await b.push({ autoConfirm: false });
  const done = await b.confirm(again.preview.fingerprint);
  assert.equal(done.summary.pushed, 1);
  assert.equal(done.summary.removed, 0, '推送不得改动本机');
  assert.notEqual(gist.state.envelope, envelopeFromA);

  a.clock.value = 5_000;
  await a.pullOverwrite();
  assert.deepEqual(a.bookmarks.paths(), ['书签栏/只在 B 有 <https://b-only.test>'], '远端已被 B 覆盖');
});

test('推送：本机没变但远端被别人改过时仍会写回本机版本', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '甲', url: 'https://jia.test' });
  await a.push();

  const b = createDevice('dev-b', gist, 2_000);
  await b.configure();
  await b.bookmarks.create({ parentId: '1', title: '乙', url: 'https://yi.test' });
  await b.push();

  a.clock.value = 5_000;
  const back = await a.push();
  assert.equal(back.summary.pushed, 1, '远端被改过，本机内容应重新写回');
  const envelope = gist.state.envelope;
  const payload = await decryptPayload(SETTINGS.passphrase, envelope);
  assert.deepEqual(
    payload.nodes.filter(node => !node.deleted).map(node => node.title).sort(),
    ['甲'],
    '推送后远端只剩本机的那一项'
  );
});

test('远端密文里不出现明文书签标题', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await a.configure();
  await a.bookmarks.create({ parentId: '1', title: '极密标题XYZ', url: 'https://topsecret.test' });
  await a.push();
  const raw = JSON.stringify(gist.state.envelope);
  assert.equal(raw.includes('极密标题XYZ'), false, '密文中不得出现明文标题');
  assert.equal(raw.includes('topsecret.test'), false, '密文中不得出现明文网址');
  const payload = await decryptPayload(SETTINGS.passphrase, gist.state.envelope);
  assert.ok(payload.nodes.some(node => node.title === '极密标题XYZ'), '用口令解密后应能看到真实标题');
});
test('推送不调用任何本机书签写接口', async () => {
  const gist = createSharedGist();
  const a = createDevice('dev-a', gist, 1_000);
  await a.configure();
  const doomed = await a.bookmarks.create({ parentId: '1', title: '待删', url: 'https://gone.test' });
  await a.bookmarks.create({ parentId: '1', title: '保留', url: 'https://keep.test' });
  await a.push();
  await a.bookmarks.remove(doomed.id);

  const mutations = [];
  for (const name of ['create', 'update', 'move', 'remove']) {
    const original = a.bookmarks[name].bind(a.bookmarks);
    a.bookmarks[name] = async (...args) => {
      mutations.push(name);
      return original(...args);
    };
  }

  a.clock.value = 5_000;
  const pushed = await a.push();
  assert.deepEqual(mutations, [], '推送不得调用本机书签的写接口');
  assert.ok(pushed.summary.pushed >= 1);
  assert.deepEqual(a.bookmarks.paths(), ['书签栏/保留 <https://keep.test>'], '本机书签应原封不动');
});
