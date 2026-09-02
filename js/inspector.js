const path = require('path');

let database;
let selectedItems = [];
let busy = false;

const countElement = document.getElementById('count');
const selectionLabel = document.getElementById('selection-label');
const messageElement = document.getElementById('message');
const incrementButton = document.getElementById('increment');
const decrementButton = document.getElementById('decrement');

function showMessage(message, isError = false) {
  messageElement.textContent = message;
  messageElement.classList.toggle('error', isError);
}

async function refresh() {
  selectedItems = await eagle.item.getSelected();
  const counts = database.getCounts(selectedItems.map((item) => item.id));
  const values = selectedItems.map((item) => Number(counts.get(item.id)?.usage_count || 0));
  const total = values.reduce((sum, value) => sum + value, 0);

  if (selectedItems.length === 0) {
    selectionLabel.textContent = '未選択';
    countElement.textContent = '—';
  } else if (selectedItems.length === 1) {
    selectionLabel.textContent = selectedItems[0].name || '1件選択';
    countElement.textContent = String(total);
  } else {
    selectionLabel.textContent = `${selectedItems.length}件選択・合計`;
    countElement.textContent = String(total);
  }

  incrementButton.disabled = busy || selectedItems.length === 0;
  decrementButton.disabled = busy || !values.some((value) => value > 0);
}

async function run(action) {
  if (busy || !database) return;
  busy = true;
  incrementButton.disabled = true;
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
  showMessage(`${result.count}件を記録しました`);
}));

decrementButton.addEventListener('click', () => run(async () => {
  selectedItems = await eagle.item.getSelected();
  const result = database.decrementUsage(selectedItems.map((item) => item.id));
  showMessage(`${result.count}件を1回減らしました`);
}));

eagle.onPluginCreate(async (plugin) => {
  try {
    document.body.setAttribute('theme', await eagle.app.theme);
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
