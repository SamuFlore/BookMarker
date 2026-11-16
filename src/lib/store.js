export const STORAGE_KEYS = {
  settings: 'sbk.settings.v1',
  state: 'sbk.state.v1',
  log: 'sbk.log.v1',
};

export const DEFAULT_SETTINGS = {
  token: '',
  passphrase: '',
  gistId: '',
  deviceName: '',
  filename: 'samubookmarker.json',
};

const MAX_LOG = 50;

export function createStore(storage, options = {}) {
  const now = options.now ?? (() => Date.now());

  async function getSettings() {
    const raw = await storage.get(STORAGE_KEYS.settings);
    return { ...DEFAULT_SETTINGS, ...(raw || {}) };
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = { ...current };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in (patch || {}))) continue;
      const value = patch[key];
      if (typeof value !== 'string') continue;
      next[key] = key === 'filename' ? value.trim() || DEFAULT_SETTINGS.filename : value;
    }
    await storage.set(STORAGE_KEYS.settings, next);
    return next;
  }

  async function getState() {
    const raw = await storage.get(STORAGE_KEYS.state);
    const state = raw && typeof raw === 'object' ? raw : {};
    return {
      deviceId: typeof state.deviceId === 'string' ? state.deviceId : '',
      idmap: state.idmap ?? { byLocalId: {}, bySyncId: {} },
      lastNodes: Array.isArray(state.lastNodes) ? state.lastNodes : [],
      localSyncIds: Array.isArray(state.localSyncIds) ? state.localSyncIds : [],
      lastSyncAt: typeof state.lastSyncAt === 'number' ? state.lastSyncAt : null,
    };
  }

  async function saveState(state) {
    await storage.set(STORAGE_KEYS.state, state);
    return state;
  }

  async function appendLog(level, text) {
    const raw = await storage.get(STORAGE_KEYS.log);
    const entries = Array.isArray(raw) ? raw : [];
    entries.unshift({ at: now(), level, text });
    const trimmed = entries.slice(0, MAX_LOG);
    await storage.set(STORAGE_KEYS.log, trimmed);
    return trimmed;
  }

  async function getLog() {
    const raw = await storage.get(STORAGE_KEYS.log);
    return Array.isArray(raw) ? raw.slice(0, MAX_LOG) : [];
  }

  async function clearLog() {
    await storage.set(STORAGE_KEYS.log, []);
  }

  return { getSettings, saveSettings, getState, saveState, appendLog, getLog, clearLog };
}
