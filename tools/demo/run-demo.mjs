// 双设备往返演示：两台设备各有独立书签树/idmap/storage，共用一个内存 Gist。
// 运行：node tools/demo/run-demo.mjs

import { createBookmarksAdapter } from '../../src/lib/browserapi.js';
import { createSyncService } from '../../src/lib/sync.js';
import { createStore } from '../../src/lib/store.js';
import { createGistClient } from '../../src/lib/gist.js';
import { decryptPayload, encryptPayload } from '../../src/lib/crypto.js';
import { createFakeBookmarks, countNodes, findByTitle, toPlain } from './fake-bookmarks.mjs';
import { createFakeGistFetch, createGistStore } from './fake-gist.mjs';

const PASSPHRASE = '口令-pass';
const GIST_ID = 'abc123';
const FILENAME = 'samubookmarker.json';

let stepIndex = 0;
function step(text) {
  stepIndex += 1;
  console.log(`[${String(stepIndex).padStart(2, '0')}] ${text}`);
}

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
    async configure() {
      await store.saveSettings({ token: 'ghp_demo_token', passphrase: PASSPHRASE, gistId: GIST_ID, filename: FILENAME, deviceName: name });
    },
    syncNow: () => service.syncNow(),
    async plainTree() {
      return toPlain(await bookmarks.getTree());
    },
  };
}

function sameTree(left, right) {
  return left === right ? '一致 ✔' : '不一致 ✘';
}

async function main() {
  const clock = createClock();
  const gistStore = createGistStore({ gistId: GIST_ID, filename: FILENAME });
  const deviceA = createDevice({ name: '设备A', deviceId: 'device-a', gistStore, clock });
  const deviceB = createDevice({ name: '设备B', deviceId: 'device-b', gistStore, clock });
  await deviceA.configure();
  await deviceB.configure();

  console.log('SamuBookMarker 双设备往返演示（口令加密快照 / 仅手动同步 / LWW + 删除墓碑）');
  console.log('两台设备书签树、idmap、storage 彼此独立，只共享一个内存 Gist。');
  console.log('');

  const barId = '1';
  await deviceA.bookmarks.create({ parentId: barId, title: 'Samu 主页', url: 'https://samu.example/' });
  await deviceA.bookmarks.create({ parentId: barId, title: 'GitHub', url: 'https://github.com/' });
  await deviceA.bookmarks.create({ parentId: barId, title: 'MDN', url: 'https://developer.mozilla.org/' });
  const folder = await deviceA.bookmarks.create({ parentId: barId, title: '技术资料' });
  await deviceA.bookmarks.create({ parentId: folder.id, title: 'ECMAScript 规范', url: 'https://tc39.es/ecma262/' });
  step(`设备A 建立 3 个书签 + 1 个文件夹（文件夹内再放 1 个书签，共 ${countNodes(await deviceA.bookmarks.getTree())} 项）`);

  clock.advance();
  const firstA = await deviceA.syncNow();
  step(`A.sync：本地快照 ${firstA.summary.total} 项，加密后写入远端 ${firstA.summary.pushed} 项`);

  clock.advance();
  const firstB = await deviceB.syncNow();
  step(`B.sync（首次）：远端解密后拉取，新增 ${firstB.summary.created} 项，本地共 ${firstB.summary.total} 项`);
  step(`两台设备书签树：${sameTree(await deviceA.plainTree(), await deviceB.plainTree())}`);

  const githubOnB = findByTitle(await deviceB.bookmarks.getTree(), 'GitHub');
  await deviceB.bookmarks.update(githubOnB.id, { title: 'GitHub（B 改名）' });
  const mdnOnB = findByTitle(await deviceB.bookmarks.getTree(), 'MDN');
  await deviceB.bookmarks.remove(mdnOnB.id);
  step('设备B：把「GitHub」改名为「GitHub（B 改名）」，并删除「MDN」');

  clock.advance();
  const secondB = await deviceB.syncNow();
  step(`B.sync：改名 1 条 + 删除 1 条墓碑，远端快照剩 ${secondB.summary.pushed} 个存活节点`);

  clock.advance();
  const secondA = await deviceA.syncNow();
  const afterDelete = await deviceA.bookmarks.getTree();
  step(`A.sync：更新 ${secondA.summary.updated} 项，删除 ${secondA.summary.removed} 项 —— 删除已跨设备生效：MDN 在 A 上${findByTitle(afterDelete, 'MDN') ? '仍存在 ✘' : '已消失 ✔'}`);
  step(`两台设备书签树：${sameTree(await deviceA.plainTree(), await deviceB.plainTree())}`);

  const homepageOnA = findByTitle(await deviceA.bookmarks.getTree(), 'Samu 主页');
  await deviceA.bookmarks.update(homepageOnA.id, { title: 'Samu 主页（A 改）' });
  clock.advance();
  await deviceA.syncNow();
  step('冲突：A 把「Samu 主页」改成「Samu 主页（A 改）」，先同步并写入远端');

  const homepageOnB = findByTitle(await deviceB.bookmarks.getTree(), 'Samu 主页');
  await deviceB.bookmarks.update(homepageOnB.id, { title: 'Samu 主页（B 改，较晚）' });
  clock.advance();
  const conflictB = await deviceB.syncNow();
  step(`B 也改了同一项标题后同步：LWW 判定 ${conflictB.summary.conflicts} 处冲突，B 的写入较晚 → B 版本胜出`);

  clock.advance();
  const conflictA = await deviceA.syncNow();
  const winnerOnA = findByTitle(await deviceA.bookmarks.getTree(), 'Samu 主页（B 改，较晚）');
  step(`A.sync：本地被远端覆盖（更新 ${conflictA.summary.updated} 项），A 上的标题变为「${winnerOnA ? winnerOnA.title : '?'}」`);
  const finalA = await deviceA.plainTree();
  const finalB = await deviceB.plainTree();
  step(`两台设备书签树：${sameTree(finalA, finalB)}`);

  const patchBefore = gistStore.count('PATCH');
  clock.advance();
  const idleA = await deviceA.syncNow();
  clock.advance();
  const idleB = await deviceB.syncNow();
  step(`空闲两次同步（A 推送 ${idleA.summary.pushed}、B 推送 ${idleB.summary.pushed} 项）：PATCH 次数 ${patchBefore} → ${gistStore.count('PATCH')}，无变更不重复写远端`);

  const envelope = JSON.parse(gistStore.content);
  const decrypted = await decryptPayload(PASSPHRASE, envelope);
  console.log('');
  console.log('=== 设备A 书签树 ===');
  console.log(finalA);
  console.log('=== 设备B 书签树 ===');
  console.log(finalB);
  console.log('=== 远端快照 ===');
  console.log(`Gist 文件 ${FILENAME} 密文长度：${gistStore.payloadBytes()} 字节（AES-GCM，KDF 迭代 ${envelope.kdf?.iterations}）`);
  console.log(`解密后的 payload：v=${decrypted.v}，deviceId=${decrypted.deviceId}，节点 ${decrypted.nodes.length} 项`);
  const methods = gistStore.methods().reduce((acc, method) => {
    acc[method] = (acc[method] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`请求方法列表：${Object.entries(methods).map(([method, times]) => `${method}×${times}`).join('、')}（共 ${gistStore.requests.length} 次，POST ${gistStore.count('POST')} 次）`);
  console.log('演示结束。');
}

main().catch((error) => {
  console.error('演示失败：', error);
  process.exitCode = 1;
});
