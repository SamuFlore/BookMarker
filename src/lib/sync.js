import { DEFAULT_FILENAME, indexBySyncId, isRootSyncId, sanitizeNodes, toPayload, validatePayload } from './schema.js';
import { normalizeIdMap, pruneToLiveLocalIds } from './idmap.js';
import { mergeNodes, nodesEqual } from './merge.js';
import { diffRemovals, executePlan, flattenTree, planApply, reconcileOrder } from './tree.js';

export class SyncError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const MESSAGES = {
  NOT_CONFIGURED: '请先填写 GitHub Token、加密口令与 Gist ID',
  BUSY: '同步正在进行中，请稍候',
  BAD_PASSPHRASE: '加密口令不正确，无法解密远端数据（未做任何写入）',
  BAD_ENVELOPE: '远端文件不是 SamuBookMarker 的加密信封，已停止以免覆盖',
  UNSUPPORTED_VERSION: '远端信封版本不受支持，请升级扩展',
  BAD_PAYLOAD: '远端数据格式不正确，已停止以免覆盖',
  UNAUTHORIZED: 'GitHub Token 无效，或缺少 gist 权限',
  NOT_FOUND: '找不到该 Gist，请检查 Gist ID 与账号归属',
  RATE_LIMITED: 'GitHub API 触发限流，请稍后再试',
  NETWORK: '无法访问 api.github.com，请检查网络或代理',
  SERVER: 'GitHub 返回错误',
  BAD_TOKEN: 'Token 为空',
  INTERNAL: '同步失败',
};

export function describeError(error) {
  const code = error?.code && MESSAGES[error.code] ? error.code : 'INTERNAL';
  const message = MESSAGES[code] ?? String(error?.message ?? error);
  return { code, message, detail: String(error?.message ?? '') };
}

export function createSyncService(deps) {
  const bookmarks = deps.bookmarks;
  const store = deps.store;
  const createGistClient = deps.createGistClient;
  const encryptPayload = deps.encryptPayload;
  const decryptPayload = deps.decryptPayload;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  let running = false;

  async function syncNow() {
    if (running) throw new SyncError('BUSY', MESSAGES.BUSY);
    running = true;
    const startedAt = now();
    try {
      const settings = await store.getSettings();
      if (!settings.token || !settings.passphrase || !settings.gistId) {
        throw new SyncError('NOT_CONFIGURED', MESSAGES.NOT_CONFIGURED);
      }
      const state = await store.getState();
      const deviceId = state.deviceId || deps.deviceId || 'device-' + Math.floor(Math.random() * 1e9);
      const idmapState = normalizeIdMap(state.idmap);
      const previousNodes = Array.isArray(state.lastNodes) ? state.lastNodes : [];
      const previous = indexBySyncId(previousNodes);

      const tree = await bookmarks.getTree();
      const snapshot = flattenTree(tree, { idmap: idmapState, previous, deviceId, now: startedAt });
      log('info', `本地快照：${snapshot.nodes.length} 项` + (snapshot.skipped.length ? `，跳过 ${snapshot.skipped.length} 个未支持的根` : ''));

      const tombstones = diffRemovals(previousNodes, snapshot.nodes, {
        previousLocalIds: new Set(state.localSyncIds ?? []),
        deviceId,
        now: startedAt,
      });
      const carried = previousNodes.filter(node => node.deleted);
      const localNodes = dedupeBySyncId([...snapshot.nodes, ...tombstones, ...carried]);

      const client = createGistClient({
        token: settings.token,
        gistId: settings.gistId,
        filename: settings.filename || DEFAULT_FILENAME,
      });
      const remote = await client.read();
      let remoteNodes = [];
      if (remote.envelope) {
        let payload;
        try {
          payload = await decryptPayload(settings.passphrase, remote.envelope);
        } catch (error) {
          throw toSyncError(error, 'BAD_PASSPHRASE');
        }
        const verdict = validatePayload(payload);
        if (!verdict.ok) throw new SyncError('BAD_PAYLOAD', MESSAGES.BAD_PAYLOAD + `（${verdict.reason}）`);
        remoteNodes = sanitizeNodes(payload.nodes);
        log('info', `远端快照：${remoteNodes.length} 项`);
      } else {
        log('info', '远端尚无数据，将写入首份快照');
      }

      const merged = mergeNodes(localNodes, remoteNodes, { now: startedAt });
      const plan = planApply(merged.nodes, {
        idmap: idmapState,
        currentNodes: new Map(snapshot.nodes.map(node => [node.syncId, node])),
      });
      const applied = await executePlan(bookmarks, {
        idmap: idmapState,
        plan,
        mergedNodes: merged.nodes,
        rootLocalBySyncId: snapshot.rootLocalBySyncId,
      });
      const order = await reconcileOrder(bookmarks, {
        idmap: idmapState,
        mergedNodes: merged.nodes,
        rootLocalBySyncId: snapshot.rootLocalBySyncId,
      });

      const needsPush = !remote.envelope || !nodesEqual(merged.nodes, remoteNodes);
      let pushed = 0;
      if (needsPush) {
        const payload = toPayload(deviceId, merged.nodes, startedAt);
        let envelope;
        try {
          envelope = await encryptPayload(settings.passphrase, payload);
        } catch (error) {
          throw new SyncError('INTERNAL', '加密失败：' + String(error?.message ?? error), error);
        }
        await client.write(envelope);
        pushed = merged.nodes.filter(node => !node.deleted).length;
      }

      const after = await bookmarks.getTree();
      const liveLocalIds = collectLocalIds(after);
      pruneToLiveLocalIds(idmapState, liveLocalIds);
      const localSyncIds = collectLocalSyncIds(after, idmapState);

      const finishedAt = now();
      await store.saveState({
        deviceId,
        idmap: idmapState,
        lastNodes: merged.nodes,
        localSyncIds: [...localSyncIds],
        lastSyncAt: finishedAt,
      });

      const summary = {
        pushed,
        pulled: merged.stats.remoteWins + merged.stats.onlyRemote,
        created: applied.created.length,
        updated: applied.updated.length,
        removed: applied.removed.length,
        conflicts: merged.stats.conflicts,
        moved: applied.reparented.length + (order.moves ?? 0),
        total: merged.nodes.filter(node => !node.deleted).length,
        durationMs: finishedAt - startedAt,
      };
      log('info', `同步完成：新增 ${summary.created}，更新 ${summary.updated}，删除 ${summary.removed}，冲突 ${summary.conflicts}`);
      return { summary, skippedRoots: snapshot.skipped };
    } catch (error) {
      const described = describeError(error);
      log('error', described.message + (described.detail && described.detail !== described.message ? `（${described.detail}）` : ''));
      throw Object.assign(new SyncError(described.code, described.message, error), { detail: described.detail });
    } finally {
      running = false;
    }
  }

  return { syncNow, isRunning: () => running };
}

function dedupeBySyncId(nodes) {
  const map = new Map();
  for (const node of nodes) {
    if (!node || typeof node.syncId !== 'string') continue;
    const previous = map.get(node.syncId);
    if (!previous || node.deleted) map.set(node.syncId, node);
  }
  return [...map.values()];
}

function collectLocalIds(tree) {
  const ids = new Set();
  const root = Array.isArray(tree) ? tree[0] : tree;
  const walk = (node) => {
    if (!node) return;
    ids.add(node.id);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return ids;
}

function collectLocalSyncIds(tree, idmapState) {
  const syncIds = new Set();
  const root = Array.isArray(tree) ? tree[0] : tree;
  const walk = (node) => {
    if (!node) return;
    const syncId = idmapState.byLocalId?.[node.id];
    if (syncId && !isRootSyncId(syncId)) syncIds.add(syncId);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return syncIds;
}

function toSyncError(error, fallbackCode) {
  const code = error?.code;
  if (code === 'BAD_PASSPHRASE' || code === 'BAD_ENVELOPE' || code === 'UNSUPPORTED_VERSION') {
    return new SyncError(code, MESSAGES[code], error);
  }
  return new SyncError(fallbackCode, MESSAGES[fallbackCode] ?? MESSAGES.INTERNAL, error);
}
