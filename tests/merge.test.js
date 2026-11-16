import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, compareVersion, pruneTombstones, TOMBSTONE_TTL_MS } from '../src/lib/schema.js';
import { mergeNodes, nodesEqual } from '../src/lib/merge.js';

const node = (over = {}) => makeNode({
  syncId: 's1',
  parentSyncId: 'root:bar',
  type: 'bookmark',
  title: 'A',
  url: 'https://a.test',
  index: 0,
  updatedAt: 100,
  deviceId: 'dev-a',
  deleted: false,
  ...over,
});

test('本地较新时本地获胜，远端较新时远端获胜', () => {
  const mine = node({ title: '本地改', updatedAt: 300, deviceId: 'dev-a' });
  const theirs = node({ title: '远端改', updatedAt: 200, deviceId: 'dev-b' });
  assert.equal(mergeNodes([mine], [theirs], { now: 1000 }).nodes[0].title, '本地改');
  assert.equal(mergeNodes([node({ title: '本地改', updatedAt: 200 })], [theirs], { now: 1000 }).nodes[0].title, '远端改');
});

test('时间戳相同则删除优先，其次比设备 id', () => {
  const alive = node({ updatedAt: 500, deviceId: 'dev-z', deleted: false });
  const dead = node({ updatedAt: 500, deviceId: 'dev-a', deleted: true, deletedAt: 500 });
  assert.equal(mergeNodes([alive], [dead], { now: 1000 }).nodes[0].deleted, true);
  const low = node({ updatedAt: 500, deviceId: 'dev-a', title: 'A' });
  const high = node({ updatedAt: 500, deviceId: 'dev-b', title: 'B' });
  assert.equal(mergeNodes([low], [high], { now: 1000 }).nodes[0].title, 'B');
});

test('统计 onlyLocal / onlyRemote / conflicts', () => {
  const stats = mergeNodes(
    [node({ syncId: 'a' }), node({ syncId: 'b', title: '本地' , updatedAt: 900 })],
    [node({ syncId: 'b', title: '远端', updatedAt: 500 }), node({ syncId: 'c' })],
    { now: 1000 },
  ).stats;
  assert.equal(stats.onlyLocal, 1);
  assert.equal(stats.onlyRemote, 1);
  assert.equal(stats.localWins, 1);
  assert.equal(stats.conflicts, 1);
});

test('内容一致但时间戳不同不算冲突', () => {
  const stats = mergeNodes([node({ updatedAt: 900 })], [node({ updatedAt: 100 })], { now: 1000 }).stats;
  assert.equal(stats.conflicts, 0);
  assert.equal(stats.localWins, 1);
});

test('墓碑超过保留期会被清理', () => {
  const now = 10 * TOMBSTONE_TTL_MS;
  const fresh = node({ syncId: 'fresh', deleted: true, updatedAt: now - 1000, deletedAt: now - 1000 });
  const stale = node({ syncId: 'stale', deleted: true, updatedAt: 1, deletedAt: 1 });
  const result = pruneTombstones([fresh, stale], now);
  assert.deepEqual(result.map(item => item.syncId), ['fresh']);
});

test('nodesEqual 忽略顺序但识别内容差异', () => {
  assert.equal(nodesEqual([node({ syncId: 'b' }), node({ syncId: 'a' })], [node({ syncId: 'a' }), node({ syncId: 'b' })]), true);
  assert.equal(nodesEqual([node()], [node({ title: '变了' })]), false);
  assert.equal(nodesEqual([node()], [node({ index: 3 })]), false);
});

test('compareVersion 对称且稳定', () => {
  const left = node({ updatedAt: 10, deviceId: 'a' });
  const right = node({ updatedAt: 10, deviceId: 'b' });
  assert.ok(compareVersion(left, right) < 0);
  assert.ok(compareVersion(right, left) > 0);
  assert.equal(compareVersion(left, { ...left }), 0);
});
