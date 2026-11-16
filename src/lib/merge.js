import { compareVersion, contentKey, makeNode, pruneTombstones, sameContent, sortNodes } from './schema.js';

export function mergeNodes(localNodes, remoteNodes, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const local = toMap(localNodes);
  const remote = toMap(remoteNodes);
  const merged = [];
  const stats = { conflicts: 0, localWins: 0, remoteWins: 0, onlyLocal: 0, onlyRemote: 0, identical: 0 };

  for (const syncId of new Set([...local.keys(), ...remote.keys()])) {
    const mine = local.get(syncId);
    const theirs = remote.get(syncId);
    if (mine && !theirs) {
      merged.push(mine);
      stats.onlyLocal += 1;
      continue;
    }
    if (!mine && theirs) {
      merged.push(theirs);
      stats.onlyRemote += 1;
      continue;
    }
    const order = compareVersion(mine, theirs);
    const divergent = !sameContent(mine, theirs);
    if (order > 0) {
      merged.push(mine);
      stats.localWins += 1;
      if (divergent && !mine.deleted && !theirs.deleted) stats.conflicts += 1;
    } else if (order < 0) {
      merged.push(theirs);
      stats.remoteWins += 1;
      if (divergent && !mine.deleted && !theirs.deleted) stats.conflicts += 1;
    } else {
      merged.push(mine);
      stats.identical += 1;
    }
  }

  return { nodes: pruneTombstones(sortNodes(merged), now), stats };
}

export function nodesEqual(leftNodes, rightNodes) {
  const left = signature(leftNodes);
  const right = signature(rightNodes);
  return left === right;
}

function signature(nodes) {
  return sortNodes(nodes ?? [])
    .map(node => node.syncId + '=' + contentKey(makeNode(node)))
    .join('|');
}

function toMap(nodes) {
  const map = new Map();
  for (const node of nodes ?? []) {
    if (!node || typeof node.syncId !== 'string') continue;
    map.set(node.syncId, makeNode(node));
  }
  return map;
}
