export function createIdMap() {
  return { byLocalId: {}, bySyncId: {} };
}

export function normalizeIdMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  const byLocalId = source.byLocalId && typeof source.byLocalId === 'object' ? { ...source.byLocalId } : {};
  const bySyncId = source.bySyncId && typeof source.bySyncId === 'object' ? { ...source.bySyncId } : {};
  return { byLocalId, bySyncId };
}

export function localIdOf(map, syncId) {
  const localId = map.bySyncId[syncId];
  return typeof localId === 'string' && localId.length > 0 ? localId : null;
}

export function syncIdOfLocal(map, localId) {
  const syncId = map.byLocalId[localId];
  return typeof syncId === 'string' && syncId.length > 0 ? syncId : null;
}

export function link(map, localId, syncId) {
  const previousLocal = map.bySyncId[syncId];
  if (previousLocal && previousLocal !== localId) delete map.byLocalId[previousLocal];
  const previousSync = map.byLocalId[localId];
  if (previousSync && previousSync !== syncId) delete map.bySyncId[previousSync];
  map.byLocalId[localId] = syncId;
  map.bySyncId[syncId] = localId;
}

export function unlinkLocal(map, localId) {
  const syncId = map.byLocalId[localId];
  if (!syncId) return;
  delete map.byLocalId[localId];
  if (map.bySyncId[syncId] === localId) delete map.bySyncId[syncId];
}

export function unlinkSync(map, syncId) {
  const localId = map.bySyncId[syncId];
  if (!localId) return;
  delete map.bySyncId[syncId];
  if (map.byLocalId[localId] === syncId) delete map.byLocalId[localId];
}

export function size(map) {
  return Object.keys(map.byLocalId).length;
}

export function pruneToLiveLocalIds(map, liveLocalIds) {
  const live = liveLocalIds instanceof Set ? liveLocalIds : new Set(liveLocalIds ?? []);
  for (const localId of Object.keys(map.byLocalId)) {
    if (!live.has(localId)) unlinkLocal(map, localId);
  }
  return map;
}

export function newSyncId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
