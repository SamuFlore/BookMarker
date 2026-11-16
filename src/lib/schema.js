export const PAYLOAD_VERSION = 1;
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const DEFAULT_FILENAME = 'samubookmarker.json';
export const DEFAULT_DEVICE_NAME = '未命名设备';

export const SYNCED_ROOT_KINDS = ['bar', 'other', 'mobile'];
export const ROOT_SYNC_IDS = { bar: 'root:bar', other: 'root:other', mobile: 'root:mobile' };
export const ROOT_SYNC_ID_SET = new Set(Object.values(ROOT_SYNC_IDS));

export function isRootSyncId(syncId) {
  return ROOT_SYNC_ID_SET.has(syncId);
}

export function makeNode(input) {
  const node = {
    syncId: String(input.syncId),
    parentSyncId: input.parentSyncId == null ? null : String(input.parentSyncId),
    type: input.type === 'folder' ? 'folder' : 'bookmark',
    title: String(input.title ?? ''),
    index: Number.isFinite(input.index) ? input.index : 0,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
    deviceId: String(input.deviceId ?? ''),
    deleted: input.deleted === true,
  };
  if (node.type === 'bookmark') node.url = String(input.url ?? '');
  if (node.deleted) node.deletedAt = Number.isFinite(input.deletedAt) ? input.deletedAt : node.updatedAt;
  return node;
}

export function isNode(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.syncId === 'string' && value.syncId.length > 0
    && (value.parentSyncId === null || typeof value.parentSyncId === 'string')
    && (value.type === 'folder' || value.type === 'bookmark')
    && typeof value.title === 'string'
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    && typeof value.deleted === 'boolean';
}

export function sanitizeNodes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!isNode(item)) continue;
    out.push(makeNode(item));
  }
  return out;
}

export function compareVersion(left, right) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  const leftDeleted = left.deleted ? 1 : 0;
  const rightDeleted = right.deleted ? 1 : 0;
  if (leftDeleted !== rightDeleted) return leftDeleted - rightDeleted;
  const a = String(left.deviceId ?? '');
  const b = String(right.deviceId ?? '');
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function sameContent(left, right) {
  return left.parentSyncId === right.parentSyncId
    && left.type === right.type
    && left.title === right.title
    && (left.url ?? '') === (right.url ?? '')
    && left.index === right.index
    && left.deleted === right.deleted;
}

export function contentKey(node) {
  return [node.parentSyncId ?? '', node.type, node.title, node.url ?? '', node.index, node.deleted ? 1 : 0].join('\u0001');
}

export function sortNodes(nodes) {
  return [...nodes].sort((a, b) => (a.syncId < b.syncId ? -1 : a.syncId > b.syncId ? 1 : 0));
}

export function toPayload(deviceId, nodes, now) {
  return {
    v: PAYLOAD_VERSION,
    deviceId: String(deviceId),
    generatedAt: new Date(now).toISOString(),
    nodes: sortNodes(nodes).map(node => makeNode(node)),
  };
}

export function validatePayload(value) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'NOT_OBJECT' };
  if (value.v !== PAYLOAD_VERSION) return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  if (!Array.isArray(value.nodes)) return { ok: false, reason: 'MISSING_NODES' };
  return { ok: true };
}

export function pruneTombstones(nodes, now) {
  const cutoff = now - TOMBSTONE_TTL_MS;
  return nodes.filter(node => !node.deleted || (node.deletedAt ?? node.updatedAt) >= cutoff);
}

export function indexBySyncId(nodes) {
  const map = new Map();
  for (const node of nodes ?? []) {
    if (isNode(node)) map.set(node.syncId, makeNode(node));
  }
  return map;
}
