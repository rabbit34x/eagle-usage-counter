const path = require('path');

let database;
let SQL;
let UsageDatabase;
let getDatabasePath;
let pluginPath;

const elements = Object.fromEntries([
  'refresh-button', 'status', 'event-count', 'item-count', 'last-used',
  'period-select', 'ranking', 'empty-ranking', 'library-name',
].map((id) => [id, document.getElementById(id)]));

function periodStart() {
  const days = elements['period-select'].value;
  if (days === 'all') return null;
  const date = new Date();
  if (days === '1') date.setHours(0, 0, 0, 0);
  else date.setTime(Date.now() - Number(days) * 86_400_000);
  return date.getTime();
}

function renderRanking() {
  const ranking = database.getRanking({ since: periodStart(), limit: 100 });
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
    const detail = document.createElement('div');
    detail.className = 'item-detail';
    detail.textContent = `最終使用: ${new Date(item.last_used_at).toLocaleString('ja-JP')}`;
    copy.append(name, detail);
    const count = document.createElement('span');
    count.className = 'rank-count';
    count.textContent = String(item.usage_count);
    const unit = document.createElement('small');
    unit.textContent = '回';
    count.append(unit);
    row.append(number, image, copy, count);
    return row;
  }));
  elements['empty-ranking'].hidden = ranking.length > 0;
}

function refresh() {
  if (!database) return;
  try {
    const stats = database.getStats();
    elements['event-count'].textContent = String(stats.event_count || 0);
    elements['item-count'].textContent = String(stats.item_count || 0);
    elements['last-used'].textContent = stats.last_used_at
      ? new Date(stats.last_used_at).toLocaleString('ja-JP') : '—';
    renderRanking();
    elements.status.textContent = '';
  } catch (error) {
    console.error(error);
    elements.status.textContent = error.message || String(error);
  }
}

async function openLibrary() {
  database?.close();
  database = new UsageDatabase(SQL, getDatabasePath(eagle.library.path));
  elements['library-name'].textContent = eagle.library.name || eagle.library.path;
  refresh();
}

elements['refresh-button'].addEventListener('click', refresh);
elements['period-select'].addEventListener('change', renderRanking);

eagle.onPluginCreate(async (plugin) => {
  pluginPath = plugin.path;
  try {
    const initSqlJs = require(path.join(pluginPath, 'node_modules', 'sql.js'));
    ({ UsageDatabase } = require(path.join(pluginPath, 'js', 'database.js')));
    ({ getDatabasePath } = require(path.join(pluginPath, 'js', 'storage.js')));
    SQL = await initSqlJs({ locateFile: (file) => path.join(pluginPath, 'node_modules', 'sql.js', 'dist', file) });
    await openLibrary();
  } catch (error) {
    console.error(error);
    elements.status.textContent = `初期化エラー: ${error.message}`;
  }
});

eagle.onPluginRun(refresh);
eagle.onPluginShow(refresh);
eagle.onLibraryChanged(() => SQL && openLibrary());
eagle.onPluginBeforeExit(() => database?.close());
