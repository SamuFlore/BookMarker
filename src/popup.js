'use strict';

// SamuBookMarker popup. Plain script (no imports) so esbuild can bundle it to an IIFE.

const SAVED_PLACEHOLDER = '留空不修改';
const UNSET_PLACEHOLDER = '尚未设置';
const FEEDBACK_MS = 4000;
const MAX_LOG_ROWS = 20;

const SUMMARY_FIELDS = [
  ['pushed', '推送'],
  ['pulled', '拉取'],
  ['created', '新增'],
  ['updated', '更新'],
  ['removed', '删除'],
  ['conflicts', '冲突'],
];

const PREVIEW_STATE = {
  ok: true,
  settings: {
    hasToken: true,
    hasPassphrase: true,
    gistId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    deviceName: '桌面 Chrome',
    filename: 'samubookmarker.json',
    pullOnly: false,
  },
  status: {
    running: false,
    lastSyncAt: Date.now() - 12 * 60 * 1000,
    lastSummary: { pushed: 3, pulled: 2, created: 1, updated: 4, removed: 0, conflicts: 1 },
    lastError: null,
  },
  log: [
    { at: Date.now() - 12 * 60 * 1000, level: 'info', text: '同步完成：推送 3，拉取 2' },
    { at: Date.now() - 12 * 60 * 1000 + 1800, level: 'info', text: '冲突 1 条，已保留本机版本' },
    { at: Date.now() - 26 * 60 * 1000, level: 'info', text: '拉取远端快照 samubookmarker.json' },
    { at: Date.now() - 26 * 60 * 1000 + 400, level: 'error', text: '上传失败（模拟）：HTTP 502 Bad Gateway' },
    { at: Date.now() - 3 * 60 * 60 * 1000, level: 'info', text: '设置已保存' },
  ],
};

function createEmptyState() {
  return {
    ok: true,
    settings: { hasToken: false, hasPassphrase: false, gistId: '', deviceName: '', filename: 'samubookmarker.json', pullOnly: false },
    status: { running: false, lastSyncAt: null, lastSummary: null, lastError: null },
    log: [],
  };
}

const runtime = typeof globalThis.chrome?.runtime?.sendMessage === 'function' ? globalThis.chrome.runtime : null;
const previewMode = runtime === null;

const dom = {};
let state = createEmptyState();
let busyAction = null; // 'save' | 'sync' | null
let feedbackTimer = null;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatClock(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '尚未同步';
  const date = new Date(timestamp);
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function describeError(error) {
  if (!error) return '未知错误';
  const code = error.code || 'ERROR';
  const message = error.message || '';
  return message ? code + '：' + message : String(code);
}

function errorFrom(exception) {
  const message = exception && exception.message ? exception.message : String(exception);
  return { code: 'POPUP_ERROR', message: message };
}

async function request(message) {
  if (!runtime) throw new Error('preview mode');
  const response = await runtime.sendMessage(message);
  if (!response || typeof response !== 'object') {
    return { ok: false, error: { code: 'NO_RESPONSE', message: '后台没有返回数据' } };
  }
  return response;
}

function setFeedback(text, kind) {
  if (feedbackTimer !== null) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  if (!text) {
    dom.feedback.hidden = true;
    dom.feedback.textContent = '';
    dom.feedback.className = 'feedback';
    return;
  }
  dom.feedback.textContent = text;
  dom.feedback.className = 'feedback is-' + kind;
  dom.feedback.hidden = false;
  feedbackTimer = setTimeout(() => {
    feedbackTimer = null;
    dom.feedback.hidden = true;
    dom.feedback.textContent = '';
    dom.feedback.className = 'feedback';
  }, FEEDBACK_MS);
}

function updateButtons() {
  const running = Boolean(state.status && state.status.running);
  const saveBusy = busyAction === 'save';
  const syncBusy = busyAction === 'sync';

  dom.saveBtn.disabled = busyAction !== null;
  dom.saveBtn.textContent = saveBusy ? '保存中…' : '保存设置';
  dom.saveBtn.classList.toggle('is-loading', saveBusy);

  dom.syncBtn.disabled = busyAction !== null || running;
  dom.syncBtn.textContent = syncBusy || running ? '同步中…' : '立即同步';
  dom.syncBtn.classList.toggle('is-loading', syncBusy || running);
}

function renderSummary(summary) {
  dom.summary.replaceChildren();
  if (!summary) {
    const empty = document.createElement('span');
    empty.className = 'summary-empty';
    empty.textContent = '暂无记录';
    dom.summary.append(empty);
    return;
  }
  for (const field of SUMMARY_FIELDS) {
    const item = document.createElement('span');
    item.className = 'summary-item';
    if (field[0] === 'conflicts' && Number(summary.conflicts) > 0) item.classList.add('is-warn');
    item.append(document.createTextNode(field[1] + ' '));
    const value = document.createElement('b');
    value.textContent = String(Number(summary[field[0]] || 0));
    item.append(value);
    dom.summary.append(item);
  }
}

function renderLog(entries) {
  const list = Array.isArray(entries) ? entries.slice(0, MAX_LOG_ROWS) : [];
  dom.logCount.textContent = '同步日志（' + list.length + '）';
  dom.logList.replaceChildren();

  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = '暂无日志';
    dom.logList.append(empty);
    return;
  }

  for (const entry of list) {
    const row = document.createElement('li');
    row.className = entry && entry.level === 'error' ? 'log-item is-error' : 'log-item';
    const time = document.createElement('time');
    time.className = 'log-time';
    time.textContent = formatClock(entry && entry.at);
    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = String((entry && entry.text) || '');
    row.append(time, text);
    dom.logList.append(row);
  }
}

function renderSecretState(badge, input, saved) {
  badge.hidden = false;
  badge.textContent = saved ? '已保存' : '未设置';
  badge.className = saved ? 'field-state field-state--ok' : 'field-state field-state--warn';
  input.classList.toggle('field-input--saved', saved);
}

function render() {
  const settings = state.settings || {};
  const status = state.status || {};

  dom.token.placeholder = settings.hasToken ? SAVED_PLACEHOLDER : UNSET_PLACEHOLDER;
  dom.passphrase.placeholder = settings.hasPassphrase ? SAVED_PLACEHOLDER : UNSET_PLACEHOLDER;
  renderSecretState(dom.tokenState, dom.token, settings.hasToken);
  renderSecretState(dom.passphraseState, dom.passphrase, settings.hasPassphrase);
  dom.gistId.placeholder = settings.gistId || UNSET_PLACEHOLDER;
  dom.deviceName.placeholder = settings.deviceName || UNSET_PLACEHOLDER;
  dom.pullOnly.checked = settings.pullOnly === true;

  dom.lastSync.textContent = formatClock(status.lastSyncAt);
  renderSummary(status.lastSummary);

  dom.runningFlag.hidden = !status.running;

  if (status.lastError) {
    dom.errorText.textContent = describeError(status.lastError);
    dom.errorBar.hidden = false;
  } else {
    dom.errorText.textContent = '';
    dom.errorBar.hidden = true;
  }

  renderLog(state.log);
  updateButtons();
}

async function refresh() {
  if (!runtime) {
    state = PREVIEW_STATE;
    render();
    return;
  }
  try {
    const response = await request({ type: 'GET_STATE' });
    if (response.ok) {
      state = {
        settings: response.settings || {},
        status: response.status || {},
        log: Array.isArray(response.log) ? response.log : [],
      };
    } else {
      state.status = Object.assign({}, state.status, { lastError: response.error || null });
    }
  } catch (exception) {
    state.status = Object.assign({}, state.status, { lastError: errorFrom(exception) });
  }
  render();
}

function collectSettings() {
  const settings = {};
  const token = dom.token.value.trim();
  const passphrase = dom.passphrase.value;
  const gistId = dom.gistId.value.trim();
  const deviceName = dom.deviceName.value.trim();

  if (token) settings.token = token;
  if (passphrase.trim()) settings.passphrase = passphrase;
  if (gistId) settings.gistId = gistId;
  if (deviceName) settings.deviceName = deviceName;

  const pullOnly = dom.pullOnly.checked === true;
  if (pullOnly !== ((state.settings || {}).pullOnly === true)) settings.pullOnly = pullOnly;
  return settings;
}

function clearInputs() {
  dom.token.value = '';
  dom.passphrase.value = '';
  dom.gistId.value = '';
  dom.deviceName.value = '';
}

async function onSave(event) {
  event.preventDefault();
  if (busyAction !== null) return;

  if (previewMode) {
    setFeedback('预览模式：无法与后台通信', 'warn');
    return;
  }

  const settings = collectSettings();
  if (Object.keys(settings).length === 0) {
    setFeedback('没有需要保存的修改', 'warn');
    return;
  }

  busyAction = 'save';
  updateButtons();
  try {
    const response = await request({ type: 'SAVE_SETTINGS', settings: settings });
    if (response.ok) {
      clearInputs();
      setFeedback(
        settings.pullOnly === undefined
          ? '设置已保存'
          : settings.pullOnly
            ? '设置已保存：已切换为仅拉取'
            : '设置已保存：已恢复双向同步',
        'ok'
      );
    } else {
      setFeedback(describeError(response.error), 'err');
    }
  } catch (exception) {
    setFeedback(describeError(errorFrom(exception)), 'err');
  } finally {
    busyAction = null;
    await refresh();
  }
}

async function onSync() {
  if (busyAction !== null) return;

  if (previewMode) {
    setFeedback('预览模式：无法与后台通信', 'warn');
    return;
  }

  busyAction = 'sync';
  updateButtons();
  try {
    const response = await request({ type: 'SYNC_NOW' });
    if (response.ok) {
      const summary = response.summary || {};
      const pulled = Number(summary.pulled || 0);
      const conflicts = Number(summary.conflicts || 0);
      setFeedback(
        state.settings && state.settings.pullOnly === true
          ? '仅拉取完成：拉取 ' + pulled + ' · 冲突 ' + conflicts + '（未上传）'
          : '同步完成：推送 ' + Number(summary.pushed || 0) + ' · 拉取 ' + pulled + ' · 冲突 ' + conflicts,
        'ok'
      );
    } else {
      setFeedback(describeError(response.error), 'err');
    }
  } catch (exception) {
    setFeedback(describeError(errorFrom(exception)), 'err');
  } finally {
    busyAction = null;
    await refresh();
  }
}

function init() {
  dom.previewBanner = document.getElementById('preview-banner');
  dom.lastSync = document.getElementById('last-sync');
  dom.summary = document.getElementById('summary');
  dom.runningFlag = document.getElementById('running-flag');
  dom.errorBar = document.getElementById('error-bar');
  dom.errorText = document.getElementById('error-text');
  dom.form = document.getElementById('settings-form');
  dom.token = document.getElementById('token');
  dom.passphrase = document.getElementById('passphrase');
  dom.tokenState = document.getElementById('token-state');
  dom.passphraseState = document.getElementById('passphrase-state');
  dom.gistId = document.getElementById('gist-id');
  dom.deviceName = document.getElementById('device-name');
  dom.pullOnly = document.getElementById('pull-only');
  dom.saveBtn = document.getElementById('save-btn');
  dom.syncBtn = document.getElementById('sync-btn');
  dom.feedback = document.getElementById('feedback');
  dom.logCount = document.getElementById('log-count');
  dom.logList = document.getElementById('log-list');

  dom.previewBanner.hidden = !previewMode;
  dom.form.addEventListener('submit', onSave);
  dom.syncBtn.addEventListener('click', onSync);

  render();
  refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
