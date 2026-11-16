import { createBookmarksAdapter, createStorageAdapter } from './lib/browserapi.js';
import { createStore } from './lib/store.js';
import { createSyncService, describeError, normalizeMode } from './lib/sync.js';
import { createGistClient } from './lib/gist.js';
import { encryptPayload, decryptPayload } from './lib/crypto.js';

const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
const store = createStore(createStorageAdapter(api));
const bookmarks = createBookmarksAdapter(api);

const status = { running: false, lastSyncAt: null, lastSummary: null, lastError: null };
let buffer = [];

const service = createSyncService({
  bookmarks,
  store,
  createGistClient,
  encryptPayload,
  decryptPayload,
  log: (level, text) => buffer.push({ level, text }),
});

async function flushLog() {
  const pending = buffer;
  buffer = [];
  for (const entry of pending) {
    await store.appendLog(entry.level, entry.text);
  }
}

async function buildState() {
  const settings = await store.getSettings();
  const state = await store.getState();
  return {
    ok: true,
    settings: {
      hasToken: Boolean(settings.token),
      hasPassphrase: Boolean(settings.passphrase),
      gistId: settings.gistId,
      deviceName: settings.deviceName,
      filename: settings.filename,
      syncMode: normalizeMode(settings.syncMode),
    },
    status: {
      running: status.running,
      lastSyncAt: state.lastSyncAt ?? status.lastSyncAt,
      lastSummary: status.lastSummary,
      lastError: status.lastError,
    },
    log: await store.getLog(),
  };
}

function extractGistId(value) {
  const text = String(value).trim();
  const match = text.match(/gist\.github\.com\/[^/]+\/([0-9a-f]+)/i) || text.match(/^([0-9a-f]{6,})$/i);
  return match ? match[1] : text;
}

async function saveSettings(patch) {
  const next = {};
  if (typeof patch.token === 'string' && patch.token.trim()) next.token = patch.token.replace(/\s+/g, '');
  if (typeof patch.passphrase === 'string' && patch.passphrase.length > 0) next.passphrase = patch.passphrase;
  if (typeof patch.gistId === 'string' && patch.gistId.trim()) next.gistId = extractGistId(patch.gistId);
  if (typeof patch.deviceName === 'string' && patch.deviceName.trim()) next.deviceName = patch.deviceName.trim();
  if (typeof patch.syncMode === 'string') next.syncMode = normalizeMode(patch.syncMode);
  if (Object.keys(next).length === 0) {
    return { ok: true, saved: false };
  }
  await store.saveSettings(next);
  return { ok: true, saved: true };
}

async function guarded(action) {
  if (status.running) {
    return { ok: false, error: { code: 'BUSY', message: '同步正在进行中，请稍候' } };
  }
  status.running = true;
  status.lastError = null;
  try {
    return await action();
  } catch (error) {
    const described = describeError(error);
    status.lastError = { code: described.code, message: described.message };
    return { ok: false, error: status.lastError };
  } finally {
    status.running = false;
    await flushLog();
  }
}

function recordSummary(summary) {
  if (!summary) return;
  status.lastSummary = summary;
  status.lastSyncAt = Date.now();
}

async function runSync(syncMode) {
  return guarded(async () => {
    if (typeof syncMode === 'string') {
      await saveSettings({ syncMode });
    }
    const result = await service.run();
    recordSummary(result.summary);
    return {
      ok: true,
      confirmRequired: result.confirmRequired === true,
      preview: result.preview,
      summary: result.summary ?? null,
    };
  });
}

async function confirmSync(fingerprint) {
  return guarded(async () => {
    const result = await service.confirm(fingerprint);
    recordSummary(result.summary);
    return { ok: true, summary: result.summary };
  });
}

async function cancelSync() {
  const result = service.cancel();
  await flushLog();
  return { ok: true, cancelled: result.cancelled };
}

async function handle(message) {
  switch (message?.type) {
    case 'GET_STATE':
      return buildState();
    case 'SAVE_SETTINGS':
      return saveSettings(message.settings ?? {});
    case 'SYNC_NOW':
      return runSync(message.syncMode);
    case 'SYNC_CONFIRM':
      return confirmSync(typeof message.fingerprint === 'string' ? message.fingerprint : '');
    case 'SYNC_CANCEL':
      return cancelSync();
    default:
      return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: '未知的消息类型' } };
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message).then(sendResponse, error => {
    const described = describeError(error);
    sendResponse({ ok: false, error: { code: described.code, message: described.message } });
  });
  return true;
});

api.runtime.onInstalled.addListener(async () => {
  const settings = await store.getSettings();
  if (!settings.deviceName) {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    await store.saveSettings({ deviceName: '设备-' + suffix });
  }
  await store.appendLog('info', 'SamuBookMarker 已安装');
});
