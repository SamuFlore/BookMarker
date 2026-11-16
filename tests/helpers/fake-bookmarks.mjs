export function createFakeBookmarks(options = {}) {
  const counter = { next: 100 };
  const nodes = new Map();
  const rootIds = options.rootIds ?? ['1', '2', '3'];
  const rootTitles = options.rootTitles ?? { '1': '书签栏', '2': '其他书签', '3': '移动端书签' };

  nodes.set('0', { id: '0', title: '', children: [], parentId: null });
  for (const id of rootIds) {
    nodes.set(id, { id, title: rootTitles[id] ?? '', children: [], parentId: '0' });
    nodes.get('0').children.push(id);
  }

  const view = id => {
    const node = nodes.get(id);
    if (!node) throw new Error('Cannot find bookmark with id ' + id);
    const result = { id: node.id, title: node.title, parentId: node.parentId };
    if (node.url !== undefined) result.url = node.url;
    if (node.children.length) result.children = node.children.map(view);
    return result;
  };

  const attach = (parentId, id, index) => {
    const parent = nodes.get(parentId);
    if (!parent) throw new Error('Cannot find bookmark with id ' + parentId);
    const at = Number.isInteger(index) && index >= 0 && index <= parent.children.length ? index : parent.children.length;
    parent.children.splice(at, 0, id);
    nodes.get(id).parentId = parentId;
  };

  const detach = id => {
    const node = nodes.get(id);
    if (!node) return;
    const parent = nodes.get(node.parentId);
    if (parent) parent.children = parent.children.filter(childId => childId !== id);
  };

  const collect = id => {
    const found = [id];
    for (const childId of nodes.get(id)?.children ?? []) found.push(...collect(childId));
    return found;
  };

  return {
    async getTree() {
      return [{ ...view('0'), children: rootIds.map(view) }];
    },
    async getChildren(id) {
      const node = nodes.get(id);
      if (!node) throw new Error('Cannot find bookmark with id ' + id);
      return node.children.map(childId => {
        const child = nodes.get(childId);
        const entry = { id: child.id, title: child.title, parentId: id, index: node.children.indexOf(childId) };
        if (child.url !== undefined) entry.url = child.url;
        return entry;
      });
    },
    async create(payload) {
      const id = 'n' + counter.next++;
      const node = { id, title: payload.title ?? '', children: [], parentId: null };
      if (payload.url !== undefined) node.url = payload.url;
      nodes.set(id, node);
      attach(payload.parentId, id, payload.index);
      return view(id);
    },
    async update(id, patch) {
      const node = nodes.get(id);
      if (!node) throw new Error('Cannot find bookmark with id ' + id);
      if (patch.title !== undefined) node.title = patch.title;
      if (patch.url !== undefined) node.url = patch.url;
      return view(id);
    },
    async move(id, destination) {
      const node = nodes.get(id);
      if (!node) throw new Error('Cannot find bookmark with id ' + id);
      detach(id);
      attach(destination.parentId ?? node.parentId, id, destination.index);
      return view(id);
    },
    async remove(id) {
      if (!nodes.has(id)) throw new Error('Cannot find bookmark with id ' + id);
      const doomed = collect(id);
      detach(id);
      for (const doomedId of doomed) nodes.delete(doomedId);
    },
    async addRootChild(rootId, title, url) {
      const payload = { parentId: rootId, title };
      if (url !== undefined) payload.url = url;
      return this.create(payload);
    },
    paths() {
      const out = [];
      const walk = (id, prefix) => {
        const node = nodes.get(id);
        if (node.parentId === null) {
          for (const childId of [...node.children]) walk(childId, '');
          return;
        }
        const isRoot = rootIds.includes(id);
        const label = node.url ? `${node.title} <${node.url}>` : node.title;
        if (!isRoot) out.push(prefix ? prefix + '/' + label : label);
        const nextPrefix = isRoot ? node.title : (prefix ? prefix + '/' + label : label);
        for (const childId of [...node.children]) walk(childId, nextPrefix);
      };
      walk('0', '');
      return out;
    },
    count() {
      return nodes.size - 1 - rootIds.length;
    },
  };
}

export function createMemoryStorage() {
  const bag = new Map();
  return {
    async get(key) {
      return bag.get(key);
    },
    async set(key, value) {
      bag.set(key, value);
    },
    dump() {
      return bag;
    },
  };
}
