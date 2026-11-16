function pickApi() {
  if (globalThis.browser?.bookmarks) return globalThis.browser;
  return globalThis.chrome;
}

export function createBookmarksAdapter(source = pickApi()) {
  const bookmarks = source.bookmarks;
  return {
    getTree: () => bookmarks.getTree(),
    getChildren: (id) => bookmarks.getChildren(id),
    create: (payload) => bookmarks.create(payload),
    update: (id, patch) => bookmarks.update(id, patch),
    move: (id, destination) => bookmarks.move(id, destination),
    remove: (id) => bookmarks.remove(id),
  };
}

export function createStorageAdapter(source = pickApi()) {
  const local = source.storage.local;
  return {
    async get(key) {
      if (typeof local.get === 'function') {
        const bag = await withCallback(local, 'get', [key]);
        return bag ? bag[key] : undefined;
      }
      throw new Error('storage.local.get unavailable');
    },
    async set(key, value) {
      await withCallback(local, 'set', [{ [key]: value }]);
    },
  };
}

async function withCallback(target, method, args) {
  const returned = target[method](...args);
  if (returned && typeof returned.then === 'function') return returned;
  return new Promise((resolve, reject) => {
    target[method](...args, (result) => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(result);
    });
  });
}
