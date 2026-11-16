// Minimal GitHub Gist transport for SamuBookMarker.
// Read-only discovery plus in-place edits: this client only ever issues GET and PATCH.

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_FILENAME = 'samubookmarker.json';
const DEFAULT_TIMEOUT_MS = 15000;

export class GistError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'GistError';
    this.code = code;
    this.details = details;
  }
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

async function readErrorPayload(response) {
  let payload = null;
  try {
    payload = await response.clone().json();
  } catch {
    try {
      const text = await response.clone().text();
      payload = text ? { message: text } : null;
    } catch {
      payload = null;
    }
  }
  return payload;
}

export function createGistClient(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const gistId = typeof options.gistId === 'string' ? options.gistId.trim() : '';
  const filename = options.filename || DEFAULT_FILENAME;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  let cachedEtag = null;

  function assertConfig() {
    if (isBlank(token)) {
      throw new GistError('BAD_TOKEN', 'A GitHub token is required', { code: 'BAD_TOKEN' });
    }
    if (isBlank(gistId)) {
      throw new GistError('NOT_FOUND', 'No gist id configured', { code: 'NOT_FOUND' });
    }
    if (typeof fetchImpl !== 'function') {
      throw new GistError('NETWORK', 'No fetch implementation available', { code: 'NETWORK' });
    }
  }

  function gistUrl() {
    return `${API_BASE}/gists/${encodeURIComponent(gistId)}`;
  }

  function baseHeaders() {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION
    };
  }

  async function statusError(response) {
    const payload = await readErrorPayload(response);
    const message = (payload && typeof payload.message === 'string' && payload.message)
      || response.statusText
      || `GitHub request failed with status ${response.status}`;
    const details = {
      status: response.status,
      message,
      scopes: response.headers.get('x-oauth-scopes'),
      documentationUrl: (payload && payload.documentation_url) || null
    };
    switch (response.status) {
      case 401:
        return new GistError('UNAUTHORIZED', message, details);
      case 403:
        if (response.headers.get('x-ratelimit-remaining') === '0') {
          return new GistError('RATE_LIMITED', message, details);
        }
        return new GistError('UNAUTHORIZED', message, details);
      case 404:
        return new GistError('NOT_FOUND', message, details);
      default:
        return new GistError('SERVER', message, details);
    }
  }

  async function request(method, url, extraHeaders, body) {
    assertConfig();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: Object.assign(baseHeaders(), extraHeaders || {}),
        body,
        signal: controller.signal
      });
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      throw new GistError('NETWORK', `Network request failed: ${reason}`, { cause: reason });
    } finally {
      clearTimeout(timer);
    }

    if (!response || typeof response.status !== 'number') {
      throw new GistError('NETWORK', 'Network request returned no response', {});
    }
    if (response.status === 304) return response;
    if (response.ok) return response;
    throw await statusError(response);
  }

  async function parseJsonBody(response) {
    try {
      return await response.json();
    } catch {
      throw new GistError('SERVER', 'GitHub response body is not valid JSON', {
        status: response.status
      });
    }
  }

  async function fetchRaw(rawUrl, etag) {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      throw new GistError('SERVER', 'Truncated gist file has no raw_url', { status: 200, etag });
    }
    let response;
    try {
      response = await request('GET', rawUrl, { Accept: 'text/plain' });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      throw new GistError('SERVER', `Unable to fetch truncated gist content: ${message}`, {
        status: error && error.details ? error.details.status : null,
        rawUrl
      });
    }
    try {
      return await response.text();
    } catch {
      throw new GistError('SERVER', 'Unable to read truncated gist content', { rawUrl });
    }
  }

  async function read() {
    const headers = {};
    if (cachedEtag) headers['If-None-Match'] = cachedEtag;

    const response = await request('GET', gistUrl(), headers);
    if (response.status === 304) {
      return { envelope: null, etag: cachedEtag, unchanged: true };
    }

    const body = await parseJsonBody(response);
    const etag = response.headers.get('etag') || cachedEtag || null;
    cachedEtag = etag;

    const file = body && body.files ? body.files[filename] : null;
    let content = file && typeof file.content === 'string' ? file.content : null;

    if (file && file.truncated === true) {
      content = await fetchRaw(file.raw_url, etag);
    }

    if (typeof content !== 'string' || content.trim() === '') {
      return { envelope: null, etag, unchanged: false };
    }

    let envelope;
    try {
      envelope = JSON.parse(content);
    } catch {
      throw new GistError('SERVER', `Gist file "${filename}" does not contain valid JSON`, {
        status: response.status,
        etag
      });
    }
    return { envelope, etag, unchanged: false };
  }

  async function write(envelope) {
    const payload = {
      files: {
        [filename]: { content: JSON.stringify(envelope) }
      }
    };
    const response = await request(
      'PATCH',
      gistUrl(),
      { 'Content-Type': 'application/json' },
      JSON.stringify(payload)
    );
    const etag = response.headers.get('etag') || cachedEtag || null;
    cachedEtag = etag;
    return { etag };
  }

  async function probe() {
    let login = null;
    try {
      const userResponse = await request('GET', `${API_BASE}/user`, {});
      const user = await parseJsonBody(userResponse);
      login = user && typeof user.login === 'string' ? user.login : null;
    } catch (error) {
      if (error instanceof GistError && error.code === 'BAD_TOKEN') throw error;
      login = null;
    }

    try {
      const response = await request('GET', gistUrl(), {});
      const gist = await parseJsonBody(response);
      const owner = gist && gist.owner && typeof gist.owner.login === 'string'
        ? gist.owner.login
        : null;
      return { ok: true, canWrite: Boolean(login && owner && owner === login), login };
    } catch (error) {
      if (error instanceof GistError && error.code === 'BAD_TOKEN') throw error;
      return { ok: false, canWrite: false, login };
    }
  }

  return { read, write, probe };
}
