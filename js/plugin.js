const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { UsageDatabase } = require('./database');

let SQL;
let database;
let selectedItems = [];
let busy = false;
let pluginPath = '';

const elements = {};

function collectElements() {
  for (const id of [
    'refresh-button', 'selection-count', 'record-button', 'status', 'selected-items',
    'event-count', 'item-count', 'undo-button', 'period-select', 'ranking',
    'empty-ranking', 'backup-button', 'restore-button', 'library-name',
  ]) elements[id] = document.getElementById(id);
}

function resolveUserDataPath() {
  try {
    const electron = require('electron');
    if (electron.remote?.app) return electron.remote.app.getPath('userData');
  } catch (_) {
    // Fall through to stable OS-specific paths.
  }

  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function getDatabasePath(libraryPath) {
  const normalizedPath = path.resolve(libraryPath).normalize();
  const libraryHash = crypto.createHash('sha256').update(normalizedPath).digest('hex');
  return path.join(
    resolveUserDataPath(),
    'eagle-usage-counter',
    'libraries',
    libraryHash,
    'usage.sqlite',
  );
}

async function openCurrentLibrary() {
  if (database) database.close();
  const libraryPath = eagle.library.path;
  if (!libraryPath) throw new Error('Eagleライブラリが開かれていません。');

  database = new UsageDatabase(SQL, getDatabasePath(libraryPath));
  elements['library-name'].textContent = eagle.library.name || path.basename(libraryPath);
  await refreshAll();
}

async function refreshSelection() {
  selectedItems = await eagle.item.getSelected();
  elements['selection-count'].textContent = String(selectedItems.length);
  elements['record-button'].disabled = selectedItems.length === 0 || busy;

  const counts = database.getCounts(selectedItems.map((item) => item.id));
  elements['selected-items'].replaceChildren(
    ...selectedItems.slice(0, 24).map((item) => {
      const card = document.createElement('article');
      card.className = 'selected-card';

      const image = document.createElement('img');
      image.src = item.thumbnailURL || '';
      image.alt = '';

      const copy = document.createElement('div');
      copy.className = 'item-copy';
      const name = document.createElement('div');
      name.className = 'item-name';
      name.textContent = item.name || item.id;
      const count = document.createElement('div');
      count.className = 'item-count';
      count.textContent = `${counts.get(item.id)?.usage_count || 0} 回使用`;
      copy.append(name, count);
      card.append(image, copy);
      return card;
    }),
  );
}

function getPeriodStart() {
  const days = elements['period-select'].value;
  if (days === 'all') return null;
  const date = new Date();
  if (days === '1') date.setHours(0, 0, 0, 0);
  else date.setTime(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
  return date.getTime();
}

function refreshRanking() {
  const ranking = database.getRanking({ since: getPeriodStart(), limit: 100 });
  elements.ranking.replaceChildren(...ranking.map((item, index) => {
    const row = document.createElement('li');
    row.className = 'rank-row';
    row.title = 'クリックしてEagle上で選択';
    row.addEventListener('click', () => eagle.item.select([item.eagle_item_id]));

    const number = document.createElement('span');
    number.className = 'rank-number';
    number.textContent = String(index + 1);
    const image = document.createElement('img');
    image.className = 'rank-thumb';
    image.src = item.thumbnail_url || '';
    image.alt = '';
    const copy = document.createElement('div');
    copy.className = 'item-copy';
    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = item.name || item.eagle_item_id;
    const lastUsed = document.createElement('div');
    lastUsed.className = 'item-count';
    lastUsed.textContent = `最終使用: ${new Date(item.last_used_at).toLocaleString('ja-JP')}`;
    copy.append(name, lastUsed);
    const count = document.createElement('span');
    count.className = 'rank-count';
    count.append(String(item.usage_count));
    const unit = document.createElement('small');
    unit.textContent = '回';
    count.append(unit);
    row.append(number, image, copy, count);
    return row;
  }));
  elements['empty-ranking'].hidden = ranking.length !== 0;
}

function refreshStats() {
  const stats = database.getStats();
  elements['event-count'].textContent = String(stats.event_count || 0);
  elements['item-count'].textContent = String(stats.item_count || 0);
  elements['undo-button'].disabled = !stats.event_count || busy;
}

async function refreshAll() {
  await refreshSelection();
  refreshStats();
  refreshRanking();
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

async function withBusy(action) {
  if (busy) return;
  busy = true;
  elements['record-button'].disabled = true;
  elements['undo-button'].disabled = true;
  try {
    await action();
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), true);
  } finally {
    busy = false;
    await refreshAll();
  }
}

async function recordSelected() {
  await withBusy(async () => {
    const latestSelection = await eagle.item.getSelected();
    if (latestSelection.length === 0) {
      setStatus('画像を選択してください。', true);
      return;
    }
    const result = database.recordUsage(latestSelection);
    setStatus(`${result.count}件の使用履歴を記録しました。`);
  });
}

async function undoLast() {
  await withBusy(async () => {
    const result = database.undoLastBatch();
    setStatus(result ? `${result.count}件の記録を取り消しました。` : '取り消せる記録がありません。');
  });
}

async function backupDatabase() {
  const result = await eagle.dialog.showSaveDialog({
    title: 'Usage Counterデータベースをバックアップ',
    defaultPath: `eagle-usage-${new Date().toISOString().slice(0, 10)}.sqlite`,
    filters: [{ name: 'SQLite database', extensions: ['sqlite'] }],
  });
  if (result.canceled || !result.filePath) return;
  fs.writeFileSync(result.filePath, database.exportBytes());
  setStatus('データベースをバックアップしました。');
}

async function restoreDatabase() {
  const selected = await eagle.dialog.showOpenDialog({
    title: 'Usage Counterデータベースを復元',
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
    properties: ['openFile'],
  });
  if (selected.canceled || selected.filePaths.length === 0) return;

  const confirmation = await eagle.dialog.showMessageBox({
    type: 'warning',
    title: 'データベースを復元',
    message: '現在の履歴を選択したバックアップで置き換えますか？',
    detail: '置き換え前のデータベースは同じ保存先へ自動バックアップします。',
    buttons: ['復元する', 'キャンセル'],
  });
  if (confirmation.response !== 0) return;

  await withBusy(async () => {
    const safetyBackup = `${database.filePath}.before-restore-${Date.now()}`;
    fs.writeFileSync(safetyBackup, database.exportBytes());
    database.replace(fs.readFileSync(selected.filePaths[0]));
    setStatus('データベースを復元しました。');
  });
}

function bindEvents() {
  elements['refresh-button'].addEventListener('click', () => withBusy(refreshSelection));
  elements['record-button'].addEventListener('click', recordSelected);
  elements['undo-button'].addEventListener('click', undoLast);
  elements['period-select'].addEventListener('change', refreshRanking);
  elements['backup-button'].addEventListener('click', backupDatabase);
  elements['restore-button'].addEventListener('click', restoreDatabase);
}

collectElements();
bindEvents();

eagle.onPluginCreate(async (plugin) => {
  pluginPath = plugin.path;
  try {
    SQL = await initSqlJs({
      locateFile: (file) => path.join(pluginPath, 'node_modules', 'sql.js', 'dist', file),
    });
    await openCurrentLibrary();
  } catch (error) {
    console.error(error);
    setStatus(`初期化に失敗しました: ${error.message}`, true);
  }
});

eagle.onPluginRun(() => database && withBusy(refreshAll));
eagle.onPluginShow(() => database && withBusy(refreshAll));
eagle.onLibraryChanged(() => SQL && withBusy(openCurrentLibrary));
eagle.onPluginBeforeExit(() => database?.close());
