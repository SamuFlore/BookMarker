import test from 'node:test';
import assert from 'node:assert/strict';

import { createBookmarksAdapter } from '../src/lib/browserapi.js';
import { createSyncService } from '../src/lib/sync.js';
import { createStore } from '../src/lib/store.js';
import { createGistClient } from '../src/lib/gist.js';
import { decryptPayload, encryptPayload as realEncryptPayload, isEnvelope } from '../src/lib/crypto.js';
import { countNodes, createFakeBookmarks, findByTitle, toPlain } from '../tools/demo/fake-bookmarks.mjs';
import { createFakeGistFetch, createGistStore } from '../tools/demo/fake-gist.mjs';

const PASSPHRASE = '口令-pass';
const GIST_ID = 'abc123';
const FILENAME = 'samubookmarker.json';
// 真实 PBKDF2 参数是 210000；测试里只降迭代次数以缩短耗时，其余加密路径完全一致。
const TEST_ITERATIONS = 5000;

const encryptPayload = (passphrase, payload) => realEncryptPayload(passphrase, payload, { iterations: TEST_ITERATIONS });

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms = 1000) {
      current += ms;
      return current;
    },
  };
}

function createMemoryStorage() {
  const data = new Map();
  return {
    async get(key) {
      const value = data.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
  };
}

function createDevice({ name, deviceId, gistStore, clock }) {
  const bookmarks = createBookmarksAdapter({ bookmarks: createFakeBookmarks() });
  const store = createStore(createMemoryStorage());
  const fetchImpl = createFakeGistFetch(gistStore);
  const service = createSyncService({
    bookmarks,
    store,
    createGistClient: (options) => createGistClient({ ...options, fetchImpl }),
    encryptPayload,
    decryptPayload,
    now: () => clock.now(),
    deviceId,
    log: () => {},
  });
  return {
    name,
    bookmarks,
    store,
    configure: () => store.saveSettings({
      token: 'ghp_test_token',
      passphrase: PASSPHRASE,
      gistId: GIST_ID,
      filename: FILENAME,
      deviceName: name,
    }),
    syncNow: () => service.syncNow(),
    plainTree: async () => toPlain(await bookmarks.getTree()),
  };
}

async function createWorld() {
  const clock = createClock();
  const gistStore = createGistStore({ gistId: GIST_ID, filename: FILENAME });
  const deviceA = createDevice({ name: '设备A', deviceId: 'device-a', gistStore, clock });
  const deviceB = createDevice({ name: '设备B', deviceId: 'device-b', gistStore, clock });
  await deviceA.configure();
  await deviceB.configure();
  return { clock, gistStore, deviceA, deviceB };
}

async function seedDeviceA(deviceA) {
  await deviceA.bookmarks.create({ parentId: '1', title: 'Samu 主页', url: 'https://samu.example/' });
  await deviceA.bookmarks.create({ parentId: '1', title: 'GitHub', url: 'https://github.com/' });
  await deviceA.bookmarks.create({ parentId: '1', title: 'MDN', url: 'https://developer.mozilla.org/' });
  const folder = await deviceA.bookmarks.create({ parentId: '1', title: '技术资料' });
  await deviceA.bookmarks.create({ parentId: folder.id, title: 'ECMAScript 规范', url: 'https://tc39.es/ecma262/' });
}

test('双设备往返：手动同步、口令加密快照、删除墓碑与 LWW 收敛', async (t) => {
  const world = await createWorld();
  const { clock, gistStore, deviceA, deviceB } = world;
  await seedDeviceA(deviceA);
  assert.equal(countNodes(await deviceA.bookmarks.getTree()), 5, '设备A 应有 5 项待同步内容');

  await t.test('A 首次同步只写一个加密信封，方法仅有 GET/PATCH', async () => {
    clock.advance();
    const result = await deviceA.syncNow();
    assert.equal(result.summary.pushed, 5);
    assert.equal(gistStore.count('PATCH'), 1, '首次同步应写一次远端');
    const envelope = JSON.parse(gistStore.content);
    assert.equal(isEnvelope(envelope), true, '远端内容必须是 SamuBookMarker 加密信封');
    assert.deepEqual(gistStore.unexpectedMethods, [], '不应出现 GET/PATCH 之外的方法');
    assert.equal(gistStore.count('POST'), 0, '从不出现 POST 请求');
    for (const request of gistStore.requests) {
      assert.ok(['GET', 'PATCH'].includes(request.method), `意外的请求方法 ${request.method}`);
    }
  });

  await t.test('B 首次同步拉取全部书签，两台设备书签树一致', async () => {
    clock.advance();
    const result = await deviceB.syncNow();
    assert.equal(result.summary.created, 5, 'B 应创建 5 个本地节点');
    assert.equal(countNodes(await deviceB.bookmarks.getTree()), 5);
    assert.equal(await deviceB.plainTree(), await deviceA.plainTree(), '两台设备书签树必须逐行一致');
    const treeOnB = await deviceB.bookmarks.getTree();
    assert.ok(findByTitle(treeOnB, 'ECMAScript 规范'), '文件夹内的书签也要跨设备建立');
  });

  await t.test('B 的改名与删除跨设备传播到 A', async () => {
    const githubOnB = findByTitle(await deviceB.bookmarks.getTree(), 'GitHub');
    await deviceB.bookmarks.update(githubOnB.id, { title: 'GitHub（B 改名）' });
    const mdnOnB = findByTitle(await deviceB.bookmarks.getTree(), 'MDN');
    await deviceB.bookmarks.remove(mdnOnB.id);

    clock.advance();
    await deviceB.syncNow();
    clock.advance();
    const resultOnA = await deviceA.syncNow();

    assert.equal(resultOnA.summary.updated, 1, 'A 应应用 1 处远端改名');
    assert.equal(resultOnA.summary.removed, 1, 'A 应删除 1 个远端已删节点');
    const treeOnA = await deviceA.bookmarks.getTree();
    assert.equal(findByTitle(treeOnA, 'MDN'), null, '删除必须跨设备生效');
    assert.ok(findByTitle(treeOnA, 'GitHub（B 改名）'), '改名必须跨设备生效');
    assert.equal(await deviceA.plainTree(), await deviceB.plainTree(), '删除与改名后两棵树仍一致');
  });

  await t.test('并发修改同一项按最后写入优先收敛', async () => {
    const homepageOnA = findByTitle(await deviceA.bookmarks.getTree(), 'Samu 主页');
    await deviceA.bookmarks.update(homepageOnA.id, { title: 'Samu 主页（A 改）' });
    clock.advance();
    await deviceA.syncNow();

    const homepageOnB = findByTitle(await deviceB.bookmarks.getTree(), 'Samu 主页');
    await deviceB.bookmarks.update(homepageOnB.id, { title: 'Samu 主页（B 改，较晚）' });
    clock.advance();
    const conflictOnB = await deviceB.syncNow();
    assert.equal(conflictOnB.summary.conflicts, 1, '同一项双改应被记为一次冲突');

    clock.advance();
    await deviceA.syncNow();
    const titleOnA = findByTitle(await deviceA.bookmarks.getTree(), 'Samu 主页（B 改，较晚）');
    const titleOnB = findByTitle(await deviceB.bookmarks.getTree(), 'Samu 主页（B 改，较晚）');
    assert.ok(titleOnA, '较晚的 B 版本应胜出并覆盖 A');
    assert.ok(titleOnB);
    assert.equal(titleOnA.title, 'Samu 主页（B 改，较晚）');
    assert.equal(await deviceA.plainTree(), await deviceB.plainTree(), '冲突必须收敛到同一棵树');
  });

  await t.test('无变更时再次同步不重复写远端', async () => {
    const patchesBefore = gistStore.count('PATCH');
    clock.advance();
    const idleA = await deviceA.syncNow();
    clock.advance();
    const idleB = await deviceB.syncNow();
    assert.equal(idleA.summary.pushed, 0, 'A 无变更不应推送');
    assert.equal(idleB.summary.pushed, 0, 'B 无变更不应推送');
    assert.equal(gistStore.count('PATCH'), patchesBefore, '无变更时 PATCH 次数不得增加');
  });

  await t.test('远端密文不含明文书签标题与 URL', async () => {
    const raw = gistStore.content;
    const envelope = JSON.parse(raw);
    assert.equal(isEnvelope(envelope), true);
    for (const needle of ['Samu 主页', 'GitHub', 'MDN', '技术资料', 'ECMAScript 规范', 'https://samu.example/', 'https://github.com/']) {
      assert.equal(raw.includes(needle), false, `密文中不应出现明文 ${needle}`);
    }
    const payload = await decryptPayload(PASSPHRASE, envelope);
    const titles = payload.nodes.map(node => node.title);
    assert.ok(titles.includes('GitHub（B 改名）'), '用口令解密后应能看到真实标题');
    assert.equal(payload.nodes.filter(node => node.deleted).length >= 1, true, '删除项应以墓碑形式存在（最终快照可被 TTL 裁剪）');
  });

  await t.test('远端故障注入：401 映射为 UNAUTHORIZED 且不写入', async () => {
    const patchesBefore = gistStore.count('PATCH');
    gistStore.fail(401, 'Bad credentials');
    await assert.rejects(deviceA.syncNow(), (error) => {
      assert.equal(error.code, 'UNAUTHORIZED');
      return true;
    });
    assert.equal(gistStore.count('PATCH'), patchesBefore, '失败时不得写入远端');
    assert.equal(gistStore.failNext, null, '故障注入应被消费一次');
  });
});
