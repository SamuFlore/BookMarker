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

export const SYNC_MODES = ['pull-merge', 'pull-overwrite', 'push'];

export const MODE_LABELS = {
  'pull-merge': '拉取合并',
  'pull-overwrite': '拉取覆盖',
  push: '推送',
};

const PENDING_TTL_MS = 120_000;

const MESSAGES = {
  NOT_CONFIGURED: 'Gist ID 和加密口令得先填上',
  TOKEN_REQUIRED: '推送需要 GitHub Token（拉取可以不填）',
  BUSY: '正在同步，等这次跑完再点',
  BAD_PASSPHRASE: '口令不对，解不开 Gist 上的数据（这次什么都没改）',
  BAD_ENVELOPE: 'Gist 里那个文件不是本插件存的加密数据，怕覆盖你的东西，停下了',
  UNSUPPORTED_VERSION: 'Gist 上的数据版本比插件新，先升级插件',
  BAD_PAYLOAD: 'Gist 上的数据格式不对，怕弄坏书签，停下了',
  REMOTE_EMPTY: 'Gist 上还是空的，这次什么都没改。先切到「推送」把本机推上去，再切回来拉取',
  PLAN_EXPIRED: '刚才那份预览过期了（这期间本机或 Gist 有变化）。再点一次「立即同步」重新看一遍，然后确认',
  UNAUTHORIZED: 'Token 不对，或者它没有 gist 权限',
  NOT_FOUND: '找不到这个 Gist：检查下 Gist ID，以及它是不是你自己账号下的',
  RATE_LIMITED: 'GitHub 限流了，过一会儿再点',
  NETWORK: '连不上 api.github.com，看下网络或代理',
  SERVER: 'GitHub 那边报错了',
  BAD_TOKEN: 'Token 是空的',
  INTERNAL: '同步没成功',
  BOOKMARK_API: '改动本机书签时出错',
};

export function normalizeMode(value) {
  return SYNC_MODES.includes(value) ? value : 'pull-overwrite';
}

export function describeError(error) {
  if (error?.name === 'BookmarkApiError') {
    return {
      code: 'BOOKMARK_API',
      message: String(error.message),
      detail: String(error.cause?.message ?? error.message),
    };
  }
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
  let pending = null;

  // 只读：读取设置、本机书签树与远端密文，算出要做的改动，不写任何东西。
  async function prepare() {
    const settings = await store.getSettings();
    if (!settings.passphrase || !settings.gistId) {
      throw new SyncError('NOT_CONFIGURED', MESSAGES.NOT_CONFIGURED);
    }
    const mode = normalizeMode(settings.syncMode);
    if (mode === 'push' && !settings.token) {
      throw new SyncError('TOKEN_REQUIRED', MESSAGES.TOKEN_REQUIRED);
    }
    const startedAt = now();
    const state = await store.getState();
    const deviceId = state.deviceId || deps.deviceId || 'device-' + Math.floor(Math.random() * 1e9);
    const idmapState = normalizeIdMap(state.idmap);
    const previousNodes = Array.isArray(state.lastNodes) ? state.lastNodes : [];
    const previous = indexBySyncId(previousNodes);

    const tree = await bookmarks.getTree();
    const snapshot = flattenTree(tree, { idmap: idmapState, previous, deviceId, now: startedAt });
    log('info', '本地快照：' + snapshot.nodes.length + ' 项' + (snapshot.skipped.length ? '，跳过 ' + snapshot.skipped.length + ' 个未支持的根' : ''));

    const client = createGistClient({
      token: settings.token,
      gistId: settings.gistId,
      filename: settings.filename || DEFAULT_FILENAME,
    });
    const remote = await client.read();
    let remoteNodes = [];
    let remoteReadable = false;
    if (remote.envelope) {
      if (mode === 'push') {
        // 推送是覆盖远端：口令对不上也照样能推，能解开就顺带算清会被覆盖多少项。
        try {
          const payload = await decryptPayload(settings.passphrase, remote.envelope);
          if (validatePayload(payload).ok) {
            remoteNodes = sanitizeNodes(payload.nodes);
            remoteReadable = true;
          }
        } catch {
          remoteReadable = false;
        }
        log('info', remoteReadable
          ? 'Gist 上共 ' + remoteNodes.length + ' 项，将被本机覆盖'
          : 'Gist 上有数据（口令不同，读不出内容），将被本机覆盖');
      } else {
        let payload;
        try {
          payload = await decryptPayload(settings.passphrase, remote.envelope);
        } catch (error) {
          throw toSyncError(error, 'BAD_PASSPHRASE');
        }
        const verdict = validatePayload(payload);
        if (!verdict.ok) throw new SyncError('BAD_PAYLOAD', MESSAGES.BAD_PAYLOAD + '（' + verdict.reason + '）');
        remoteNodes = sanitizeNodes(payload.nodes);
        remoteReadable = true;
        log('info', 'Gist 上共 ' + remoteNodes.length + ' 项');
      }
    } else {
      log('info', 'Gist 上还没有数据');
    }

    const currentNodes = new Map(snapshot.nodes.map(node => [node.syncId, node]));
    let mergedNodes;
    let merged = null;
    if (mode === 'pull-overwrite') {
      if (!remote.envelope) throw new SyncError('REMOTE_EMPTY', MESSAGES.REMOTE_EMPTY);
      mergedNodes = remoteNodes;
    } else {
      const tombstones = diffRemovals(previousNodes, snapshot.nodes, {
        previousLocalIds: new Set(state.localSyncIds ?? []),
        deviceId,
        now: startedAt,
      });
      const carried = previousNodes.filter(node => node.deleted);
      const localNodes = dedupeBySyncId([...snapshot.nodes, ...tombstones, ...carried]);
      if (mode === 'push') {
        // 推送：远端 := 本机，不做合并
        mergedNodes = localNodes;
      } else {
        merged = mergeNodes(localNodes, remoteNodes, { now: startedAt });
        mergedNodes = merged.nodes;
      }
    }

    const plan = planApply(mergedNodes, { idmap: idmapState, currentNodes });
    return {
      mode, settings, deviceId, idmapState, snapshot, client, remote, remoteNodes, remoteReadable,
      merged, mergedNodes, plan, startedAt, previousNodes,
    };
  }

  function describe(context) {
    const titleOfLocal = new Map(context.snapshot.nodes.map(node => [node.syncId, node.title]));
    const bySyncId = new Map(context.mergedNodes.map(node => [node.syncId, node]));
    const deleteSamples = context.plan.remove.map(item => {
      const local = titleOfLocal.get(item.syncId);
      if (typeof local === 'string' && local) return local;
      const node = bySyncId.get(item.syncId);
      return node?.title || '(未命名)';
    });
    const createSamples = context.plan.create.map(item => item.title || '(未命名)');
    const isPush = context.mode === 'push';
    const liveCount = context.mergedNodes.filter(node => !node.deleted).length;
    const deletedLocal = context.plan.remove.length;
    return {
      mode: context.mode,
      modeLabel: MODE_LABELS[context.mode],
      fingerprint: fingerprintOf(context.mode, context.plan, context.remoteNodes, isPush ? context.mergedNodes : []),
      needsConfirm: isPush || deletedLocal > 0,
      deleteCount: deletedLocal,
      createCount: context.plan.create.length,
      updateCount: context.plan.update.length + context.plan.reparent.length,
      keepCount: liveCount,
      pushCount: isPush ? liveCount : 0,
      overwriteCount: isPush && context.remoteReadable
        ? context.remoteNodes.filter(node => !node.deleted).length
        : null,
      remotePresent: Boolean(context.remote.envelope),
      remoteReadable: context.remoteReadable,
      samples: { delete: deleteSamples.slice(0, 5), create: createSamples.slice(0, 5) },
      firstJoin: context.mode !== 'pull-overwrite'
        && context.previousNodes.length === 0
        && context.remoteNodes.length > 0,
    };
  }

  // 写操作：把预演里算好的改动落到本机，并在合并模式下决定是否上传。
  async function applyPlan(context) {
    // 推送只动远端，本机一条都不碰。
    let applied = { created: [], updated: [], removed: [], reparented: [] };
    let order = { moves: 0 };
    if (context.mode !== 'push') {
      applied = await executePlan(bookmarks, {
        idmap: context.idmapState,
        plan: context.plan,
        mergedNodes: context.mergedNodes,
        rootLocalBySyncId: context.snapshot.rootLocalBySyncId,
      });
      order = await reconcileOrder(bookmarks, {
        idmap: context.idmapState,
        mergedNodes: context.mergedNodes,
        rootLocalBySyncId: context.snapshot.rootLocalBySyncId,
      });
    }

    let pushed = 0;
    if (context.mode === 'push') {
      const unchanged = context.remoteReadable && nodesEqual(context.mergedNodes, context.remoteNodes);
      if (unchanged) {
        log('info', 'Gist 上已经和本机一致，没有重复写入');
      } else {
        const payload = toPayload(context.deviceId, context.mergedNodes, context.startedAt);
        let envelope;
        try {
          envelope = await encryptPayload(context.settings.passphrase, payload);
        } catch (error) {
          throw new SyncError('INTERNAL', '加密失败：' + String(error?.message ?? error), error);
        }
        await context.client.write(envelope);
        pushed = context.mergedNodes.filter(node => !node.deleted).length;
        log('info', '已推送：Gist 上原有的内容被本机 ' + pushed + ' 项覆盖');
      }
    } else if (context.mode === 'pull-merge') {
      log('info', '拉取合并：本机改动没上传，Gist 没动');
    }

    const after = await bookmarks.getTree();
    pruneToLiveLocalIds(context.idmapState, collectLocalIds(after));
    const finishedAt = now();
    await store.saveState({
      deviceId: context.deviceId,
      idmap: context.idmapState,
      lastNodes: context.mergedNodes,
      localSyncIds: [...collectLocalSyncIds(after, context.idmapState)],
      lastSyncAt: finishedAt,
    });

    const summary = {
      mode: context.mode,
      pushed,
      pulled: context.merged ? context.merged.stats.remoteWins + context.merged.stats.onlyRemote : context.remoteNodes.filter(node => !node.deleted).length,
      created: applied.created.length,
      updated: applied.updated.length,
      removed: applied.removed.length,
      conflicts: context.merged ? context.merged.stats.conflicts : 0,
      moved: applied.reparented.length + (order.moves ?? 0),
      total: context.mergedNodes.filter(node => !node.deleted).length,
      durationMs: finishedAt - context.startedAt,
    };
    log('info', '完成（' + MODE_LABELS[context.mode] + '）：新增 ' + summary.created + '，更新 ' + summary.updated + '，删除 ' + summary.removed + '，冲突 ' + summary.conflicts);
    return summary;
  }

  // 第一段：只做预演。需要删除时把计划暂存起来，等前端确认。
  async function run() {
    if (running) throw new SyncError('BUSY', MESSAGES.BUSY);
    running = true;
    try {
      const context = await prepare();
      const preview = describe(context);
      if (preview.needsConfirm) {
        pending = { fingerprint: preview.fingerprint, context, createdAt: now() };
        log('info', context.mode === 'push'
          ? '等确认（推送）：本机 ' + preview.pushCount + ' 项将覆盖 Gist 上原有的内容'
          : '等确认（' + preview.modeLabel + '）：要删本机 ' + preview.deleteCount + ' 项、新增 ' + preview.createCount + ' 项');
        return { confirmRequired: true, preview };
      }
      pending = null;
      const summary = await applyPlan(context);
      return { confirmRequired: false, preview, summary };
    } catch (error) {
      throw logAndWrap(error);
    } finally {
      running = false;
    }
  }

  // 第二段：用户确认后执行暂存的计划；期间本地或远端变化则作废。
  async function confirm(fingerprint) {
    if (running) throw new SyncError('BUSY', MESSAGES.BUSY);
    running = true;
    try {
      if (!pending || now() - pending.createdAt > PENDING_TTL_MS || pending.fingerprint !== fingerprint) {
        pending = null;
        throw new SyncError('PLAN_EXPIRED', MESSAGES.PLAN_EXPIRED);
      }
      const context = pending.context;
      pending = null;
      const fresh = await context.client.read();
      if (!fresh.unchanged && !sameEnvelope(fresh.envelope, context.remote.envelope)) {
        throw new SyncError('PLAN_EXPIRED', MESSAGES.PLAN_EXPIRED);
      }
      return { summary: await applyPlan(context) };
    } catch (error) {
      throw logAndWrap(error);
    } finally {
      running = false;
    }
  }

  function cancel() {
    const had = pending !== null;
    pending = null;
    if (had) log('info', '已取消，什么都没改');
    return { cancelled: had };
  }

  function logAndWrap(error) {
    const described = describeError(error);
    log('error', described.message + (described.detail && described.detail !== described.message ? '（' + described.detail + '）' : ''));
    return Object.assign(new SyncError(described.code, described.message, error), { detail: described.detail });
  }

  return { run, confirm, cancel, isRunning: () => running, hasPending: () => pending !== null };
}

function fingerprintOf(mode, plan, remoteNodes, localNodes = []) {
  const part = (tag, key) => tag + ':' + key;
  const parts = [mode, 'remote:' + remoteNodes.length];
  for (const node of localNodes) {
    parts.push(part('l', node.syncId + '|' + node.title + '|' + (node.url ?? '') + '|' + node.updatedAt + '|' + (node.deleted ? 'd' : 'k')));
  }
  for (const item of plan.remove) parts.push(part('r', item.syncId));
  for (const item of plan.create) parts.push(part('c', item.syncId + '|' + item.title + '|' + (item.url ?? '')));
  for (const item of plan.update) parts.push(part('u', item.syncId + '|' + item.title + '|' + (item.url ?? '')));
  for (const item of plan.reparent) parts.push(part('p', item.syncId + '|' + item.parentSyncId));
  return parts.sort().join('||');
}

function sameEnvelope(left, right) {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
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
