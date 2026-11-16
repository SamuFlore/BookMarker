// 内存 Gist 服务端：只认 GET 与 PATCH https://api.github.com/gists/{id}。
// 提供 createFakeGistFetch(store) 作为 fetch 实现，并记录每一次请求。

export const GIST_API_BASE = 'https://api.github.com';
export const DEFAULT_FILENAME = 'samubookmarker.json';

export function createGistStore(options = {}) {
  const store = {
    gistId: options.gistId ?? 'abc123',
    filename: options.filename ?? DEFAULT_FILENAME,
    owner: options.owner ?? 'samu-demo',
    content: options.content ?? null,
    version: 0,
    etag: null,
    requests: [],
    unexpectedMethods: [],
    failNext: null,
    fail(status, message) {
      store.failNext = { status, message: message ?? `injected ${status}` };
    },
    methods() {
      return store.requests.map(request => request.method);
    },
    count(method) {
      return store.requests.filter(request => request.method === method).length;
    },
    payloadBytes() {
      return store.content === null ? 0 : Buffer.byteLength(store.content, 'utf8');
    },
    reset() {
      store.content = null;
      store.version = 0;
      store.etag = null;
      store.requests.length = 0;
      store.unexpectedMethods.length = 0;
      store.failNext = null;
    },
  };
  return store;
}

function headerValue(headers, name) {
  if (!headers) return null;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return null;
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function gistBody(store) {
  const files = {};
  if (store.content !== null) {
    files[store.filename] = {
      filename: store.filename,
      type: 'application/json',
      language: 'JSON',
      truncated: false,
      size: Buffer.byteLength(store.content, 'utf8'),
      content: store.content,
      raw_url: `${GIST_API_BASE}/gists/${store.gistId}/raw/${encodeURIComponent(store.filename)}`,
    };
  }
  return {
    id: store.gistId,
    description: 'SamuBookMarker encrypted snapshot',
    public: false,
    owner: { login: store.owner },
    files,
    history: [],
  };
}

export function createFakeGistFetch(store) {
  return async function fakeGistFetch(url, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = init.headers ?? {};
    const ifNoneMatch = headerValue(headers, 'if-none-match');
    const authorization = headerValue(headers, 'authorization');
    store.requests.push({ method, url: String(url), ifNoneMatch, authorization });

    const failure = store.failNext;
    if (failure) {
      store.failNext = null;
      return jsonResponse({ message: failure.message, documentation_url: 'https://docs.github.com/rest' }, failure.status);
    }

    const target = String(url);
    if (target === `${GIST_API_BASE}/user` && method === 'GET') {
      return jsonResponse({ login: store.owner, id: 1 }, 200);
    }

    const match = /^https:\/\/api\.github\.com\/gists\/([^/?#]+)$/.exec(target);
    if (!match) return jsonResponse({ message: 'Not Found' }, 404);
    if (decodeURIComponent(match[1]) !== store.gistId) return jsonResponse({ message: 'Not Found' }, 404);

    if (method !== 'GET' && method !== 'PATCH') {
      store.unexpectedMethods.push(method);
      return jsonResponse({ message: `Method ${method} is not supported by this gist` }, 405);
    }

    if (method === 'GET') {
      if (store.content !== null && ifNoneMatch && ifNoneMatch === store.etag) {
        return new Response(null, { status: 304, headers: { etag: store.etag } });
      }
      return jsonResponse(gistBody(store), 200, store.etag ? { etag: store.etag } : {});
    }

    let payload;
    try {
      payload = JSON.parse(String(init.body ?? '{}'));
    } catch {
      return jsonResponse({ message: 'Problems parsing JSON' }, 400);
    }
    const file = payload?.files?.[store.filename];
    const content = file?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return jsonResponse({ message: `files.${store.filename}.content must be a non-empty string` }, 422);
    }
    store.content = content;
    store.version += 1;
    store.etag = `W/"gist-${store.version}"`;
    return jsonResponse(gistBody(store), 200, { etag: store.etag });
  };
}
