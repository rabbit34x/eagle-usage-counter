const path = require('path');

let database;
let SQL;
let UsageDatabase;
let getDatabasePath;
let pluginPath;

const elements = Object.fromEntries([
  'refresh-button', 'status', 'event-count', 'item-count', 'last-used',
  'activity-total', 'month-labels', 'activity-grid',
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

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function renderActivity() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentSunday = new Date(today);
  currentSunday.setDate(today.getDate() - today.getDay());
  const start = new Date(currentSunday);
  start.setDate(currentSunday.getDate() - 52 * 7);
  const end = new Date(today);
  end.setHours(23, 59, 59, 999);

  const rows = database.getDailyActivity({ since: start.getTime(), until: end.getTime() });
  const activity = new Map(rows.map((row) => [row.day, Number(row.usage_count)]));
  const maximum = Math.max(0, ...activity.values());
  const total = [...activity.values()].reduce((sum, count) => sum + count, 0);
  elements['activity-total'].textContent = `過去1年間に ${total} 回使用`;
  elements['activity-grid'].setAttribute('aria-label', `過去1年間の使用回数、合計${total}回`);

  const cells = [];
  const monthLabels = [];
  let previousMonth = -1;
  for (let week = 0; week < 53; week += 1) {
    const middleOfWeek = new Date(start);
    middleOfWeek.setDate(start.getDate() + week * 7 + 3);
    if (middleOfWeek.getMonth() !== previousMonth) {
      const label = document.createElement('span');
      label.textContent = `${middleOfWeek.getMonth() + 1}月`;
      label.style.gridColumn = String(week + 2);
      monthLabels.push(label);
      previousMonth = middleOfWeek.getMonth();
    }

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + weekday);
      const count = activity.get(dateKey(date)) || 0;
      const level = count === 0 || maximum === 0
        ? 0
        : Math.max(1, Math.ceil(Math.log1p(count) / Math.log1p(maximum) * 4));
      const cell = document.createElement('span');
      cell.className = 'activity-cell';
      cell.dataset.level = String(level);
      cell.title = `${date.toLocaleDateString('ja-JP')}: ${count}回`;
      cell.setAttribute('aria-label', cell.title);
      if (date > today) cell.classList.add('future');
      cells.push(cell);
    }
  }
  elements['month-labels'].replaceChildren(...monthLabels);
  elements['activity-grid'].replaceChildren(...cells);
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
    renderActivity();
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
