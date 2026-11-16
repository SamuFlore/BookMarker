'use strict';

// SamuBookMarker popup. Plain script (no imports) so esbuild can bundle it to an IIFE.

const SAVED_PLACEHOLDER = '已填写';
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
    syncMode: 'pull-overwrite',
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
    settings: { hasToken: false, hasPassphrase: false, gistId: '', deviceName: '', filename: 'samubookmarker.json', syncMode: 'pull-overwrite' },
    status: { running: false, lastSyncAt: null, lastSummary: null, lastError: null },
    log: [],
  };
}

const runtime = typeof globalThis.chrome?.runtime?.sendMessage === 'function' ? globalThis.chrome.runtime : null;
const previewMode = runtime === null;

const dom = {};
let state = createEmptyState();
let busyAction = null; // 'save' | 'sync' | null
let pendingFingerprint = '';
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
  if (!error) return '出错了，但没拿到具体信息';
  const message = error.message || '';
  if (message) return message;
  return error.code ? '出错了（' + error.code + '），详细信息看下面的日志' : '出错了';
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
  const skipPushed = summary.mode === 'pull-overwrite' || summary.mode === 'pull-merge';
  const skipPulled = summary.mode === 'push';
  for (const field of SUMMARY_FIELDS) {
    if (skipPushed && field[0] === 'pushed') continue;
    if (skipPulled && field[0] === 'pulled') continue;
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
  dom.syncMode.value = MODE_HINTS[settings.syncMode] ? settings.syncMode : 'pull-overwrite';
  renderModeHint();

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

// 切动作立刻存盘：否则改了下拉但没保存就点同步，后台还会按旧动作执行。
async function onModeChange() {
  renderModeHint();
  hideConfirm();
  if (previewMode) return;
  const mode = dom.syncMode.value;
  if (mode === (state.settings || {}).syncMode) return;
  try {
    await request({ type: 'SYNC_CANCEL' });
  } catch (exception) {
    // 没有待确认的计划时取消失败无妨
  }
  try {
    const response = await request({ type: 'SAVE_SETTINGS', settings: { syncMode: mode } });
    if (response.ok) {
      state.settings = Object.assign({}, state.settings, { syncMode: mode });
      setFeedback('同步方式已切换为「' + modeLabelOf(mode) + '」', 'ok');
    } else {
      setFeedback(describeError(response.error), 'err');
    }
  } catch (exception) {
    setFeedback(describeError(errorFrom(exception)), 'err');
  }
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

  const syncMode = dom.syncMode.value;
  if (syncMode !== (state.settings || {}).syncMode) settings.syncMode = syncMode;
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
      setFeedback(settings.syncMode === undefined ? '设置已保存' : '设置已保存：同步方式已切换为「' + modeLabelOf(settings.syncMode) + '」', 'ok');
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

  hideConfirm();
  busyAction = 'sync';
  updateButtons();
  try {
    // 把当前选中的动作一起发过去：只靠 SAVE_SETTINGS 先落盘会和这条消息抢跑，
    // 用户选“推送”却可能按上一次的“拉取覆盖”执行。
    const response = await request({ type: 'SYNC_NOW', syncMode: dom.syncMode.value });
    if (!response.ok) {
      setFeedback(describeError(response.error), 'err');
    } else if (response.confirmRequired) {
      setFeedback('', null);
      showConfirm(response.preview || {});
    } else {
      setFeedback(summaryText(response.summary), 'ok');
    }
  } catch (exception) {
    setFeedback(describeError(errorFrom(exception)), 'err');
  } finally {
    busyAction = null;
    await refresh();
  }
}

const MODE_HINTS = {
  'pull-merge': '拉取 Gist 上的书签并与本机书签合并',
  'pull-overwrite': '拉取 Gist 上的书签并覆盖本机书签',
  push: '把本机书签推送到 Gist 并覆盖远端内容',
};

function modeLabelOf(mode) {
  if (mode === 'pull-merge') return '拉取合并';
  if (mode === 'push') return '推送';
  return '拉取覆盖';
}

function renderModeHint() {
  dom.modeHint.textContent = MODE_HINTS[dom.syncMode.value] || MODE_HINTS['pull-overwrite'];
}

function summaryText(summary) {
  const data = summary || {};
  const created = Number(data.created || 0);
  const removed = Number(data.removed || 0);
  const conflicts = Number(data.conflicts || 0) > 0 ? '，冲突 ' + Number(data.conflicts) : '';
  if (data.mode === 'push') {
    if (!Number(data.pushed || 0)) return 'Gist 上已经和本机一致，这次没有重复写入';
    return '已推送：本机 ' + Number(data.pushed || 0) + ' 项覆盖了 Gist 上原来的内容';
  }
  if (data.mode === 'pull-overwrite') {
    return '拉取覆盖完成：本机现在 ' + Number(data.total || 0) + ' 项（新增 ' + created + '，删除 ' + removed + '）';
  }
  return '拉取合并完成：新增 ' + created + '，更新 ' + Number(data.updated || 0) + '，删除 ' + removed + conflicts + '，本机改动没上传';
}

function showConfirm(preview) {
  pendingFingerprint = typeof preview.fingerprint === 'string' ? preview.fingerprint : '';
  const isPush = preview.mode === 'push';
  const deleted = Number(preview.deleteCount || 0);
  const created = Number(preview.createCount || 0);
  const pushCount = Number(preview.pushCount || 0);
  const runLabel = isPush ? '确认，覆盖 Gist' : '确认，覆盖本机';
  dom.confirmRun.textContent = runLabel;
  dom.confirmTitle.textContent = isPush
    ? pushTitle(preview, pushCount)
    : modeLabelOf(preview.mode) + '预览：本机会删掉 ' + deleted + ' 项、新增 ' + created +
      ' 项，' + Number(preview.keepCount || 0) + ' 项不变';
  dom.confirmList.replaceChildren();
  const samples = isPush ? [] : ((preview.samples && preview.samples.delete) || []);
  for (const title of samples) {
    const item = document.createElement('li');
    item.textContent = title;
    dom.confirmList.append(item);
  }
  if (deleted > samples.length) {
    const more = document.createElement('li');
    more.textContent = '……另外还有 ' + (deleted - samples.length) + ' 项';
    dom.confirmList.append(more);
  }
  dom.confirmHint.textContent = confirmHint(preview, runLabel);
  dom.confirmPanel.hidden = false;
}

function pushTitle(preview, pushCount) {
  if (!preview.remotePresent) {
    return '推送预览：把本机 ' + pushCount + ' 项写进 Gist（那边现在还是空的）';
  }
  if (typeof preview.overwriteCount === 'number') {
    return '推送预览：Gist 上现有 ' + preview.overwriteCount + ' 项，会被本机的 ' + pushCount + ' 项覆盖';
  }
  return '推送预览：Gist 上原有的内容会被本机的 ' + pushCount + ' 项覆盖';
}

function confirmHint(preview, runLabel) {
  if (preview.mode === 'push') {
    if (preview.firstJoin) {
      return '这台设备从没和 Gist 同步过。推送会直接用本机内容盖掉 Gist 书签 —— 确认后继续';
    }
    return '点「' + runLabel + '」之后，Gist 上原来那份就被覆盖了，此操作无法恢复';
  }
  if (preview.firstJoin) {
    return '此设备上已有的书签，在 Gist 里找不到对应项，拉取合并可能和 Gist 上那份并存成两份重复。要完全以 Gist 为准，请改用「拉取覆盖」。';
  }
  return '点「' + runLabel + '」之后，操作无法恢复 —— 确认后继续';
}

function hideConfirm() {
  pendingFingerprint = '';
  dom.confirmPanel.hidden = true;
  dom.confirmTitle.textContent = '';
  dom.confirmList.replaceChildren();
  dom.confirmHint.textContent = '';
  dom.confirmRun.textContent = '确认执行';
}

async function onConfirm() {
  if (busyAction !== null || !pendingFingerprint) return;
  busyAction = 'sync';
  updateButtons();
  try {
    const response = await request({ type: 'SYNC_CONFIRM', fingerprint: pendingFingerprint });
    hideConfirm();
    if (response.ok) {
      setFeedback(summaryText(response.summary), 'ok');
    } else {
      const error = response.error || {};
      setFeedback(
        describeError(error) + (error.code === 'PLAN_EXPIRED' ? '（请重新点「立即同步」）' : ''),
        'err'
      );
    }
  } catch (exception) {
    hideConfirm();
    setFeedback(describeError(errorFrom(exception)), 'err');
  } finally {
    busyAction = null;
    await refresh();
  }
}

async function onCancelConfirm() {
  hideConfirm();
  setFeedback('已取消，未做任何修改', 'warn');
  try {
    await request({ type: 'SYNC_CANCEL' });
  } catch (exception) {
    // 取消失败不影响本机：暂存的计划会在两分钟后过期
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
  dom.syncMode = document.getElementById('sync-mode');
  dom.modeHint = document.getElementById('mode-hint');
  dom.confirmPanel = document.getElementById('confirm-panel');
  dom.confirmTitle = document.getElementById('confirm-title');
  dom.confirmList = document.getElementById('confirm-list');
  dom.confirmHint = document.getElementById('confirm-hint');
  dom.confirmRun = document.getElementById('confirm-run');
  dom.confirmCancel = document.getElementById('confirm-cancel');
  dom.saveBtn = document.getElementById('save-btn');
  dom.syncBtn = document.getElementById('sync-btn');
  dom.feedback = document.getElementById('feedback');
  dom.logCount = document.getElementById('log-count');
  dom.logList = document.getElementById('log-list');

  dom.previewBanner.hidden = !previewMode;
  dom.form.addEventListener('submit', onSave);
  dom.syncBtn.addEventListener('click', onSync);
  dom.syncMode.addEventListener('change', onModeChange);
  dom.confirmRun.addEventListener('click', onConfirm);
  dom.confirmCancel.addEventListener('click', onCancelConfirm);

  render();
  refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
