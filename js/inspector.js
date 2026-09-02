const path = require('path');

let database;
let selectedItems = [];
let busy = false;

const countElement = document.getElementById('count');
const countDetail = document.getElementById('count-detail');
const selectionLabel = document.getElementById('selection-label');
const messageElement = document.getElementById('message');
const incrementButton = document.getElementById('increment');
const decrementButton = document.getElementById('decrement');
const pastAmount = document.getElementById('past-amount');
const pastDate = document.getElementById('past-date');
const undatedCheckbox = document.getElementById('undated');
const addPastButton = document.getElementById('add-past');

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function showMessage(message, isError = false) {
  messageElement.textContent = message;
  messageElement.classList.toggle('error', isError);
}

function setControlsDisabled(disabled) {
  incrementButton.disabled = disabled || selectedItems.length === 0;
  addPastButton.disabled = disabled || selectedItems.length === 0;
}

async function refresh() {
  selectedItems = await eagle.item.getSelected();
  const counts = database.getCounts(selectedItems.map((item) => item.id));
  const values = selectedItems.map((item) => Number(counts.get(item.id)?.usage_count || 0));
  const undatedValues = selectedItems.map((item) => Number(counts.get(item.id)?.undated_count || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const undatedTotal = undatedValues.reduce((sum, value) => sum + value, 0);

  if (selectedItems.length === 0) {
    selectionLabel.textContent = '未選択';
    countElement.textContent = '—';
    countDetail.textContent = '';
  } else if (selectedItems.length === 1) {
    selectionLabel.textContent = selectedItems[0].name || '1件選択';
    countElement.textContent = String(total);
    countDetail.textContent = undatedTotal > 0 ? `日時不明 ${undatedTotal}回` : '';
  } else {
    selectionLabel.textContent = `${selectedItems.length}件選択・合計`;
    countElement.textContent = String(total);
    countDetail.textContent = undatedTotal > 0 ? `日時不明 ${undatedTotal}回` : '';
  }

  setControlsDisabled(busy);
  decrementButton.disabled = busy || !values.some((value) => value > 0);
}

async function run(action) {
  if (busy || !database) return;
  busy = true;
  setControlsDisabled(true);
  decrementButton.disabled = true;
  try {
    await action();
  } catch (error) {
    console.error(error);
    showMessage(error.message || String(error), true);
  } finally {
    busy = false;
    await refresh();
  }
}

incrementButton.addEventListener('click', () => run(async () => {
  selectedItems = await eagle.item.getSelected();
  const result = database.recordUsage(selectedItems);
  showMessage(`${result.count}件を現在日時で記録しました`);
}));

decrementButton.addEventListener('click', () => run(async () => {
  selectedItems = await eagle.item.getSelected();
  const result = database.decrementUsage(selectedItems.map((item) => item.id));
  showMessage(`${result.count}件を1回減らしました`);
}));

undatedCheckbox.addEventListener('change', () => {
  pastDate.disabled = undatedCheckbox.checked;
});

addPastButton.addEventListener('click', () => run(async () => {
  selectedItems = await eagle.item.getSelected();
  const amount = Number.parseInt(pastAmount.value, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) {
    throw new Error('回数は1〜10000で指定してください。');
  }

  if (undatedCheckbox.checked) {
    const result = database.recordAdjustment(selectedItems, amount, '日時不明の過去分');
    showMessage(`${result.count}回を日時不明で追加しました`);
    return;
  }

  if (!pastDate.value) throw new Error('使用日を指定してください。');
  const usedAt = new Date(`${pastDate.value}T12:00:00`).getTime();
  if (!Number.isFinite(usedAt)) throw new Error('使用日が正しくありません。');
  if (usedAt > Date.now()) throw new Error('未来の日付は指定できません。');
  const result = database.recordUsage(selectedItems, { usedAt, repeat: amount, note: '過去分' });
  showMessage(`${result.count}回を${new Date(usedAt).toLocaleDateString('ja-JP')}に追加しました`);
}));

eagle.onPluginCreate(async (plugin) => {
  try {
    document.body.setAttribute('theme', await eagle.app.theme);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    pastDate.value = dateKey(yesterday);
    const initSqlJs = require(path.join(plugin.path, 'node_modules', 'sql.js'));
    const { UsageDatabase } = require(path.join(plugin.path, 'js', 'database.js'));
    const { getDatabasePath } = require(path.join(plugin.path, 'js', 'storage.js'));
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(plugin.path, 'node_modules', 'sql.js', 'dist', file),
    });
    database = new UsageDatabase(SQL, getDatabasePath(eagle.library.path));
    await refresh();
  } catch (error) {
    console.error(error);
    showMessage(`初期化エラー: ${error.message}`, true);
  }
});

eagle.onPluginShow(() => database && refresh());
eagle.onThemeChanged((theme) => document.body.setAttribute('theme', theme));
eagle.onPluginBeforeExit(() => database?.close());
