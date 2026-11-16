import { ROOT_SYNC_IDS, isRootSyncId, makeNode, sameContent } from './schema.js';
import { link, localIdOf, syncIdOfLocal, unlinkSync } from './idmap.js';

const ROOT_ID_KIND = {
  '1': 'bar',
  '2': 'other',
  '3': 'mobile',
  'toolbar_____': 'bar',
  'menu________': 'menu',
  'unfiled_____': 'other',
  'mobile______': 'mobile',
};

const POSITIONAL_KINDS = ['bar', 'other', 'mobile'];
const SYNCED_KINDS = new Set(['bar', 'other', 'mobile']);

export function classifyRootKind(localId, position) {
  const byId = ROOT_ID_KIND[String(localId)];
  if (byId) return byId;
  return POSITIONAL_KINDS[position] ?? null;
}

export function readRoots(tree) {
  const root = Array.isArray(tree) ? tree[0] : tree;
  const children = Array.isArray(root?.children) ? root.children : [];
  const roots = [];
  const skipped = [];
  children.forEach((child, position) => {
    const kind = classifyRootKind(child.id, position);
    if (kind && SYNCED_KINDS.has(kind)) {
      roots.push({ kind, syncId: ROOT_SYNC_IDS[kind], localId: child.id, node: child });
    } else {
      skipped.push({ kind: kind ?? 'unknown', localId: child.id, title: child.title ?? '' });
    }
  });
  return { root: root ?? null, roots, skipped };
}

export function flattenTree(tree, options) {
  const state = {
    idmap: options.idmap,
    previous: options.previous instanceof Map ? options.previous : new Map(),
    deviceId: String(options.deviceId ?? ''),
    now: Number.isFinite(options.now) ? options.now : Date.now(),
    mint: options.mint ?? defaultMint,
  };
  const { roots, skipped } = readRoots(tree);
  const nodes = [];
  const rootLocalBySyncId = {};

  const walk = (children, parentSyncId) => {
    children.forEach((child, index) => {
      const existing = syncIdOfLocal(state.idmap, child.id);
      const syncId = existing ?? state.mint();
      if (!existing) link(state.idmap, child.id, syncId);
      const type = child.url ? 'bookmark' : 'folder';
      const next = makeNode({
        syncId,
        parentSyncId,
        type,
        title: child.title ?? '',
        url: child.url ?? '',
        index,
        updatedAt: state.now,
        deviceId: state.deviceId,
        deleted: false,
      });
      const previous = state.previous.get(syncId);
      const unchanged = previous && !previous.deleted && sameContent(previous, next);
      next.updatedAt = unchanged ? previous.updatedAt : state.now;
      nodes.push(next);
      if (type === 'folder') walk(Array.isArray(child.children) ? child.children : [], syncId);
    });
  };

  for (const root of roots) {
    rootLocalBySyncId[root.syncId] = root.localId;
    link(state.idmap, root.localId, root.syncId);
    walk(Array.isArray(root.node.children) ? root.node.children : [], root.syncId);
  }

  return { nodes, rootLocalBySyncId, roots, skipped };
}

export function diffRemovals(previousNodes, currentNodes, options = {}) {
  const previousLocalIds = options.previousLocalIds instanceof Set
    ? options.previousLocalIds
    : new Set(Array.isArray(options.previousLocalIds) ? options.previousLocalIds : []);
  const deviceId = String(options.deviceId ?? '');
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const live = new Set((currentNodes ?? []).map(node => node.syncId));
  const tombstones = [];
  for (const node of previousNodes ?? []) {
    if (!node || node.deleted) continue;
    if (!previousLocalIds.has(node.syncId)) continue;
    if (live.has(node.syncId)) continue;
    tombstones.push(makeNode({ ...node, deleted: true, updatedAt: now, deletedAt: now, deviceId }));
  }
  return tombstones;
}

export function planApply(mergedNodes, options) {
  const idmapState = options.idmap;
  const current = options.currentNodes instanceof Map ? options.currentNodes : new Map();
  const merged = new Map();
  for (const node of mergedNodes ?? []) merged.set(node.syncId, node);
  const depths = computeDepths(merged);

  const plan = { remove: [], create: [], update: [], reparent: [] };

  for (const syncId of Object.keys(idmapState.bySyncId)) {
    if (isRootSyncId(syncId)) continue;
    const node = merged.get(syncId);
    const localId = idmapState.bySyncId[syncId];
    if (!localId) continue;
    if (!node || node.deleted) {
      plan.remove.push({ syncId, localId, depth: depths.get(syncId) ?? 0 });
    }
  }
  plan.remove.sort((a, b) => b.depth - a.depth);

  for (const node of merged.values()) {
    if (node.deleted || isRootSyncId(node.syncId)) continue;
    if (localIdOf(idmapState, node.syncId)) continue;
    plan.create.push({
      syncId: node.syncId,
      parentSyncId: node.parentSyncId,
      type: node.type,
      title: node.title,
      url: node.url ?? '',
      depth: depths.get(node.syncId) ?? 0,
    });
  }
  plan.create.sort((a, b) => a.depth - b.depth || (a.syncId < b.syncId ? -1 : a.syncId > b.syncId ? 1 : 0));

  for (const node of merged.values()) {
    if (node.deleted || isRootSyncId(node.syncId)) continue;
    if (!localIdOf(idmapState, node.syncId)) continue;
    const here = current.get(node.syncId);
    if (!here) continue;
    const titleChanged = here.title !== node.title;
    const urlChanged = (here.url ?? '') !== (node.url ?? '');
    if (titleChanged || urlChanged) {
      plan.update.push({ syncId: node.syncId, title: node.title, url: node.url ?? '' });
    }
    if (here.parentSyncId !== node.parentSyncId) {
      plan.reparent.push({ syncId: node.syncId, parentSyncId: node.parentSyncId });
    }
  }

  return plan;
}

export async function executePlan(api, options) {
  const idmapState = options.idmap;
  const plan = options.plan;
  const merged = new Map();
  for (const node of options.mergedNodes ?? []) merged.set(node.syncId, node);
  const rootLocalBySyncId = options.rootLocalBySyncId ?? {};

  const removed = [];
  for (const item of plan.remove ?? []) {
    if (!item.localId) continue;
    try {
      await api.remove(item.localId);
      removed.push(item.syncId);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
    unlinkSync(idmapState, item.syncId);
  }

  const created = [];
  for (const item of plan.create ?? []) {
    const parentLocalId = resolveLocal(idmapState, rootLocalBySyncId, item.parentSyncId);
    if (!parentLocalId) continue;
    const payload = { parentId: parentLocalId, title: item.title };
    if (item.type === 'bookmark') payload.url = item.url;
    try {
      const createdNode = await api.create(payload);
      link(idmapState, createdNode.id, item.syncId);
      created.push(item.syncId);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  const updated = [];
  for (const item of plan.update ?? []) {
    const localId = localIdOf(idmapState, item.syncId);
    if (!localId) continue;
    const node = merged.get(item.syncId);
    const patch = { title: item.title };
    if (node && node.type === 'bookmark' && node.url) patch.url = node.url;
    try {
      await api.update(localId, patch);
      updated.push(item.syncId);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  const reparented = [];
  for (const item of plan.reparent ?? []) {
    const localId = localIdOf(idmapState, item.syncId);
    const parentLocalId = resolveLocal(idmapState, rootLocalBySyncId, item.parentSyncId);
    if (!localId || !parentLocalId) continue;
    try {
      await api.move(localId, { parentId: parentLocalId });
      reparented.push(item.syncId);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  return { removed, created, updated, reparented };
}

export async function reconcileOrder(api, options) {
  const idmapState = options.idmap;
  const rootLocalBySyncId = options.rootLocalBySyncId ?? {};
  const maxMoves = Number.isFinite(options.maxMoves) ? options.maxMoves : 4000;
  const wanted = new Map();
  for (const node of options.mergedNodes ?? []) {
    if (node.deleted) continue;
    const bucket = wanted.get(node.parentSyncId);
    if (bucket) bucket.push(node);
    else wanted.set(node.parentSyncId, [node]);
  }

  let moves = 0;
  for (const [parentSyncId, children] of wanted) {
    const parentLocalId = resolveLocal(idmapState, rootLocalBySyncId, parentSyncId);
    if (!parentLocalId) continue;
    const desired = [...children].sort(compareSiblings).map(node => node.syncId);
    const actualNodes = await api.getChildren(parentLocalId);
    const actual = actualNodes.map(node => syncIdOfLocal(idmapState, node.id) ?? '\u0000' + node.id);
    for (let target = 0; target < desired.length; target += 1) {
      if (actual[target] === desired[target]) continue;
      const from = actual.indexOf(desired[target]);
      const localId = localIdOf(idmapState, desired[target]);
      if (!localId) continue;
      if (moves >= maxMoves) return { moves, truncated: true };
      await api.move(localId, { parentId: parentLocalId, index: target });
      if (from >= 0) actual.splice(from, 1);
      actual.splice(target, 0, desired[target]);
      moves += 1;
    }
  }
  return { moves, truncated: false };
}

export function resolveLocal(idmapState, rootLocalBySyncId, syncId) {
  if (syncId == null) return null;
  return localIdOf(idmapState, syncId) ?? rootLocalBySyncId[syncId] ?? null;
}

export function computeDepths(merged) {
  const depths = new Map();
  const visiting = new Set();
  const depthOf = (syncId) => {
    if (depths.has(syncId)) return depths.get(syncId);
    if (visiting.has(syncId)) return 0;
    visiting.add(syncId);
    const node = merged.get(syncId);
    const parentId = node?.parentSyncId;
    const depth = parentId == null || !merged.has(parentId) ? 0 : depthOf(parentId) + 1;
    visiting.delete(syncId);
    depths.set(syncId, depth);
    return depth;
  };
  for (const syncId of merged.keys()) depthOf(syncId);
  return depths;
}

function compareSiblings(left, right) {
  if (left.index !== right.index) return left.index - right.index;
  if (left.title !== right.title) return left.title < right.title ? -1 : 1;
  return left.syncId < right.syncId ? -1 : 1;
}

function isGone(error) {
  const message = String(error?.message ?? error ?? '');
  return /cannot find|not found|no bookmark|invalid id/i.test(message);
}

function defaultMint() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error('crypto.randomUUID unavailable');
}
