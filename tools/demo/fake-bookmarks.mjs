// 内存版 chrome.bookmarks API：形状与 src/lib/browserapi.js 的 createBookmarksAdapter 一致。
// 所有方法返回 Promise；id 自增；getTree 返回 [ { id:'0', children:[根...] } ]。

const ROOT_ID = '0';
const ROOT_DEFINITIONS = [
  { id: '1', title: '书签栏' },
  { id: '2', title: '其他书签' },
  { id: '3', title: '移动端书签' },
];
const PERMANENT_ROOT_IDS = new Set([ROOT_ID, ...ROOT_DEFINITIONS.map(root => root.id)]);
const FIRST_CUSTOM_ID = 4;

export function createFakeBookmarks(options = {}) {
  const nodes = new Map();
  let nextId = Number.isInteger(options.nextId) ? options.nextId : FIRST_CUSTOM_ID;

  nodes.set(ROOT_ID, { id: ROOT_ID, parentId: null, title: '', url: undefined, childIds: [...ROOT_DEFINITIONS.map(root => root.id)] });
  for (const definition of ROOT_DEFINITIONS) {
    nodes.set(definition.id, { id: definition.id, parentId: ROOT_ID, title: definition.title, url: undefined, childIds: [] });
  }

  function requireNode(id) {
    const node = nodes.get(String(id));
    if (!node) throw new Error(`Cannot find bookmark with id ${id}`);
    return node;
  }

  function requireFolder(id) {
    const node = requireNode(id);
    if (!node.childIds) throw new Error(`Bookmark with id ${id} is not a folder`);
    return node;
  }

  function snapshot(node) {
    const out = { id: node.id, parentId: node.parentId, title: node.title, index: indexOf(node) };
    if (node.url !== undefined) out.url = node.url;
    return out;
  }

  function indexOf(node) {
    if (node.parentId == null) return 0;
    const parent = nodes.get(node.parentId);
    return parent ? parent.childIds.indexOf(node.id) : 0;
  }

  function clampIndex(value, length) {
    if (!Number.isInteger(value)) return length;
    if (value < 0) return 0;
    return value > length ? length : value;
  }

  async function getTree() {
    const build = (id) => {
      const node = nodes.get(id);
      const out = snapshot(node);
      if (node.childIds) out.children = node.childIds.map(build);
      return out;
    };
    return [build(ROOT_ID)];
  }

  async function getChildren(id) {
    const folder = requireFolder(id);
    return folder.childIds.map(childId => snapshot(nodes.get(childId)));
  }

  async function create(payload = {}) {
    const parent = requireFolder(payload.parentId);
    const isBookmark = typeof payload.url === 'string';
    const node = {
      id: String(nextId),
      parentId: parent.id,
      title: String(payload.title ?? ''),
      url: isBookmark ? payload.url : undefined,
      childIds: isBookmark ? undefined : [],
    };
    nextId += 1;
    parent.childIds.splice(clampIndex(payload.index, parent.childIds.length), 0, node.id);
    nodes.set(node.id, node);
    return snapshot(node);
  }

  async function update(id, patch = {}) {
    const node = requireNode(id);
    if (typeof patch.title === 'string') node.title = patch.title;
    if (typeof patch.url === 'string' && node.url !== undefined) node.url = patch.url;
    return snapshot(node);
  }

  async function move(id, destination = {}) {
    const node = requireNode(id);
    if (PERMANENT_ROOT_IDS.has(node.id)) throw new Error(`Cannot move a permanent root folder (${id})`);
    const parent = requireFolder(destination.parentId ?? node.parentId);
    const oldParent = requireFolder(node.parentId);
    const at = oldParent.childIds.indexOf(node.id);
    if (at >= 0) oldParent.childIds.splice(at, 1);
    parent.childIds.splice(clampIndex(destination.index, parent.childIds.length), 0, node.id);
    node.parentId = parent.id;
    return snapshot(node);
  }

  async function remove(id) {
    const node = requireNode(id);
    if (PERMANENT_ROOT_IDS.has(node.id)) throw new Error(`Cannot remove a permanent root folder (${id})`);
    const parent = requireFolder(node.parentId);
    const at = parent.childIds.indexOf(node.id);
    if (at >= 0) parent.childIds.splice(at, 1);
    const purge = (targetId) => {
      const target = nodes.get(targetId);
      if (!target) return;
      nodes.delete(targetId);
      for (const childId of target.childIds ?? []) purge(childId);
    };
    purge(node.id);
    return undefined;
  }

  return { getTree, getChildren, create, update, move, remove };
}

// 把书签树导出成便于断言的纯文本：每行一项，按层缩进。
// 文件夹输出 "标题/"，书签输出 "标题 <url>"。
export function toPlainLines(tree) {
  const root = Array.isArray(tree) ? tree[0] : tree;
  const lines = [];
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    lines.push(node.url ? `${pad}${node.title} <${node.url}>` : `${pad}${node.title}/`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const child of root?.children ?? []) walk(child, 0);
  return lines;
}

export function toPlain(tree) {
  return toPlainLines(tree).join('\n');
}

export function countNodes(tree) {
  const root = Array.isArray(tree) ? tree[0] : tree;
  let total = 0;
  const walk = (node) => {
    for (const child of node.children ?? []) {
      total += 1;
      walk(child);
    }
  };
  for (const rootNode of root?.children ?? []) walk(rootNode);
  return total;
}

export function findByTitle(tree, title) {
  const root = Array.isArray(tree) ? tree[0] : tree;
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.title === title) return child;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}
