import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBookmarks } from './helpers/fake-bookmarks.mjs';
import { createIdMap, link, localIdOf } from '../src/lib/idmap.js';
import { ROOT_SYNC_IDS } from '../src/lib/schema.js';
import { readRoots, flattenTree, diffRemovals, planApply, executePlan, reconcileOrder } from '../src/lib/tree.js';

const treeOf = async api => api.getTree();

test('readRoots 识别 Chrome 三根，Firefox 菜单根被跳过', async () => {
  const chromeLike = await treeOf(createFakeBookmarks());
  assert.deepEqual(readRoots(chromeLike).roots.map(root => root.kind), ['bar', 'other', 'mobile']);
  assert.equal(readRoots(chromeLike).rootLocalBySyncId, undefined);

  const firefoxTree = [{ id: 'root________', title: '', children: [
    { id: 'menu________', title: 'Bookmarks Menu', children: [] },
    { id: 'toolbar_____', title: 'Bookmarks Toolbar', children: [] },
    { id: 'unfiled_____', title: 'Other Bookmarks', children: [] },
    { id: 'mobile______', title: 'Mobile Bookmarks', children: [] },
  ] }];
  const read = readRoots(firefoxTree);
  assert.deepEqual(read.roots.map(root => root.kind), ['bar', 'other', 'mobile']);
  assert.equal(read.skipped.length, 1);
  assert.equal(read.skipped[0].kind, 'menu');
});

test('flattenTree 分配稳定 syncId，并在内容未变时沿用 updatedAt', async () => {
  const api = createFakeBookmarks();
  const folder = await api.create({ parentId: '1', title: '工作' });
  await api.create({ parentId: folder.id, title: 'Inbox', url: 'https://inbox.test' });

  const idmap = createIdMap();
  const first = flattenTree(await api.getTree(), { idmap, previous: new Map(), deviceId: 'dev-a', now: 1000 });
  assert.equal(first.nodes.length, 2);
  const byTitle = Object.fromEntries(first.nodes.map(node => [node.title, node]));
  assert.equal(byTitle['工作'].parentSyncId, ROOT_SYNC_IDS.bar);
  assert.equal(byTitle.Inbox.parentSyncId, byTitle['工作'].syncId);
  assert.equal(byTitle.Inbox.type, 'bookmark');
  assert.equal(localIdOf(idmap, byTitle['工作'].syncId), folder.id);

  const previous = new Map(first.nodes.map(node => [node.syncId, node]));
  const stable = flattenTree(await api.getTree(), { idmap, previous, deviceId: 'dev-a', now: 2000 });
  assert.equal(stable.nodes.find(node => node.title === '工作').updatedAt, 1000);

  await api.update(folder.id, { title: '工作2' });
  const changed = flattenTree(await api.getTree(), { idmap, previous, deviceId: 'dev-a', now: 3000 });
  assert.equal(changed.nodes.find(node => node.title === '工作2').updatedAt, 3000);
});

test('diffRemovals 只对曾经同步过的本地项生成墓碑', async () => {
  const api = createFakeBookmarks();
  const kept = await api.create({ parentId: '1', title: '保留', url: 'https://keep.test' });
  const doomed = await api.create({ parentId: '1', title: '待删', url: 'https://gone.test' });
  const idmap = createIdMap();
  const snapshot = flattenTree(await api.getTree(), { idmap, previous: new Map(), deviceId: 'dev-a', now: 1000 });

  const remoteOnly = { syncId: 'remote-only', parentSyncId: ROOT_SYNC_IDS.bar, type: 'bookmark', title: '远端', url: 'https://r.test', index: 9, updatedAt: 900, deviceId: 'dev-b', deleted: false };
  const previousNodes = [...snapshot.nodes, remoteOnly];
  const previousLocalIds = new Set(snapshot.nodes.map(node => node.syncId));

  await api.remove(doomed.id);
  const after = flattenTree(await api.getTree(), { idmap, previous: new Map(snapshot.nodes.map(node => [node.syncId, node])), deviceId: 'dev-a', now: 5000 });
  const tombstones = diffRemovals(previousNodes, after.nodes, { previousLocalIds, deviceId: 'dev-a', now: 5000 });

  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].deleted, true);
  assert.equal(tombstones[0].deletedAt, 5000);
  assert.notEqual(tombstones[0].syncId, after.nodes.find(node => node.title === '保留').syncId);
  assert.ok(!tombstones.some(item => item.syncId === 'remote-only'));
});

test('planApply 区分创建、更新、重挂与删除', async () => {
  const api = createFakeBookmarks();
  const local = await api.create({ parentId: '1', title: '本地项', url: 'https://local.test' });
  const idmap = createIdMap();
  const snapshot = flattenTree(await api.getTree(), { idmap, previous: new Map(), deviceId: 'dev-a', now: 1000 });
  const localNode = snapshot.nodes[0];
  const current = new Map(snapshot.nodes.map(node => [node.syncId, node]));

  const remoteOnly = { syncId: 'remote-new', parentSyncId: ROOT_SYNC_IDS.bar, type: 'bookmark', title: '新增', url: 'https://new.test', index: 5, updatedAt: 900, deviceId: 'dev-b', deleted: false };
  const edited = { ...localNode, title: '改过的标题', updatedAt: 900, deviceId: 'dev-b' };
  const plan = planApply([edited, remoteOnly], { idmap, currentNodes: current });

  assert.deepEqual(plan.create.map(item => item.syncId), ['remote-new']);
  assert.deepEqual(plan.update.map(item => item.syncId), [localNode.syncId]);
  assert.equal(plan.remove.length, 0);

  const planWithDelete = planApply([{ ...remoteOnly, deleted: true, deletedAt: 900 }], { idmap, currentNodes: current });
  assert.deepEqual(planWithDelete.remove.map(item => item.syncId).sort(), [localNode.syncId].sort());
  assert.equal(local.id.length > 0, true);
});

test('executePlan + reconcileOrder 把本地树对齐到合并结果', async () => {
  const api = createFakeBookmarks();
  const keep = await api.create({ parentId: '1', title: '保留', url: 'https://keep.test' });
  await api.create({ parentId: '1', title: '删除我', url: 'https://dead.test' });
  const idmap = createIdMap();
  const snapshot = flattenTree(await api.getTree(), { idmap, previous: new Map(), deviceId: 'dev-a', now: 1000 });
  const current = new Map(snapshot.nodes.map(node => [node.syncId, node]));
  const keepNode = snapshot.nodes.find(node => node.title === '保留');
  const deadNode = snapshot.nodes.find(node => node.title === '删除我');

  const merged = [
    { ...keepNode, index: 1, updatedAt: 1200 },
    { ...deadNode, deleted: true, deletedAt: 1200 },
    { syncId: 'remote-folder', parentSyncId: ROOT_SYNC_IDS.bar, type: 'folder', title: '新文件夹', index: 0, updatedAt: 900, deviceId: 'dev-b', deleted: false },
    { syncId: 'remote-child', parentSyncId: 'remote-folder', type: 'bookmark', title: '子项', url: 'https://child.test', index: 0, updatedAt: 900, deviceId: 'dev-b', deleted: false },
  ];

  const plan = planApply(merged, { idmap, currentNodes: current });
  const applied = await executePlan(api, { idmap, plan, mergedNodes: merged, rootLocalBySyncId: snapshot.rootLocalBySyncId });
  await reconcileOrder(api, { idmap, mergedNodes: merged, rootLocalBySyncId: snapshot.rootLocalBySyncId });

  const paths = api.paths();
  assert.equal(applied.removed.length, 1);
  assert.equal(applied.created.length, 2);
  assert.ok(!paths.some(path => path.includes('删除我')));
  assert.ok(paths.some(path => path === '书签栏/保留 <https://keep.test>'));
  assert.ok(paths.some(path => path.endsWith('新文件夹/子项 <https://child.test>')));

  const bar = await api.getChildren('1');
  assert.equal(bar[0].title, '新文件夹');
  assert.equal(bar[1].id, keep.id);
});
