const path = require('path');

let database;
let SQL;
let UsageDatabase;
let getDatabasePath;
let pluginPath;

const DAY = 86_400_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const elements = Object.fromEntries([
  'refresh-button', 'status', 'range-select', 'custom-range', 'start-date', 'end-date',
  'metric-select', 'granularity-select', 'event-count', 'event-delta', 'item-count',
  'item-delta', 'active-days', 'active-delta', 'daily-average', 'average-delta',
  'trend-note', 'trend-chart', 'empty-trend', 'weekday-chart', 'activity-total',
  'month-labels', 'activity-grid', 'ranking-note', 'ranking', 'empty-ranking', 'library-name',
].map((id) => [id, document.getElementById(id)]));

function startOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function shiftDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getRange() {
  const preset = elements['range-select'].value;
  const today = startOfDay();
  const until = endOfDay(today).getTime();
  if (preset === 'today') return { since: today.getTime(), until, label: '今日', comparable: true };
  if (preset === '7' || preset === '30') {
    const days = Number(preset);
    return { since: shiftDays(today, -(days - 1)).getTime(), until, label: `過去${days}日`, comparable: true };
  }
  if (preset === 'month') {
    return { since: new Date(today.getFullYear(), today.getMonth(), 1).getTime(), until, label: '今月', comparable: true };
  }
  if (preset === 'year') {
    return { since: new Date(today.getFullYear(), 0, 1).getTime(), until, label: '今年', comparable: true };
  }
  if (preset === 'all') return { since: 0, until, label: '全期間（日時不明を含む）', comparable: false, includeUndated: true };

  const startValue = elements['start-date'].value;
  const endValue = elements['end-date'].value;
  if (!startValue || !endValue) throw new Error('開始日と終了日を指定してください。');
  const since = new Date(`${startValue}T00:00:00`).getTime();
  const customUntil = new Date(`${endValue}T23:59:59.999`).getTime();
  if (since > customUntil) throw new Error('開始日は終了日以前にしてください。');
  return {
    since,
    until: customUntil,
    label: `${new Date(since).toLocaleDateString('ja-JP')}〜${new Date(customUntil).toLocaleDateString('ja-JP')}`,
    comparable: true,
  };
}

function getComparisonRange(range) {
  if (!range.comparable) return null;
  const duration = range.until - range.since + 1;
  const until = range.since - 1;
  return { since: until - duration + 1, until };
}

function calendarDays(range, firstUsedAt = null) {
  const start = range.since || firstUsedAt || range.until;
  return Math.max(1, Math.round((startOfDay(new Date(range.until)) - startOfDay(new Date(start))) / DAY) + 1);
}

function setDelta(element, current, previous, suffix = '') {
  element.classList.remove('positive', 'negative');
  if (previous == null) {
    element.textContent = '全期間';
    return;
  }
  if (previous === 0) {
    element.textContent = current === 0 ? `前期間比 0${suffix}` : '前期間から新規';
    if (current > 0) element.classList.add('positive');
    return;
  }
  const percentage = (current - previous) / previous * 100;
  const sign = percentage > 0 ? '+' : '';
  element.textContent = `前期間比 ${sign}${percentage.toFixed(1)}%`;
  if (percentage > 0) element.classList.add('positive');
  if (percentage < 0) element.classList.add('negative');
}

function renderSummary(range) {
  const current = database.getPeriodStats(range);
  const comparisonRange = getComparisonRange(range);
  const previous = comparisonRange ? database.getPeriodStats(comparisonRange) : null;
  const currentDays = calendarDays(range, current.first_used_at);
  const previousDays = comparisonRange ? calendarDays(comparisonRange) : null;
  const currentDatedCount = Number(current.event_count || 0) - Number(current.undated_count || 0);
  const currentAverage = currentDatedCount / currentDays;
  const previousAverage = previous
    ? (Number(previous.event_count || 0) - Number(previous.undated_count || 0)) / previousDays
    : null;

  elements['event-count'].textContent = String(current.event_count || 0);
  elements['item-count'].textContent = String(current.item_count || 0);
  elements['active-days'].textContent = String(current.active_days || 0);
  elements['daily-average'].textContent = currentAverage.toFixed(1);
  setDelta(elements['event-delta'], Number(current.event_count || 0), previous && Number(previous.event_count || 0));
  setDelta(elements['item-delta'], Number(current.item_count || 0), previous && Number(previous.item_count || 0));
  setDelta(elements['active-delta'], Number(current.active_days || 0), previous && Number(previous.active_days || 0));
  setDelta(elements['average-delta'], currentAverage, previousAverage);
  return current;
}

function resolveGranularity(range, stats) {
  const selected = elements['granularity-select'].value;
  if (selected !== 'auto') return selected;
  const days = calendarDays(range, stats.first_used_at);
  if (days <= 45) return 'day';
  if (days <= 400) return 'week';
  if (days <= 365 * 5) return 'month';
  return 'year';
}

function bucketKey(date, granularity) {
  if (granularity === 'day') return dateKey(date);
  if (granularity === 'week') {
    const monday = startOfDay(date);
    const weekday = monday.getDay() || 7;
    monday.setDate(monday.getDate() - weekday + 1);
    return dateKey(monday);
  }
  if (granularity === 'month') return dateKey(date).slice(0, 7);
  return String(date.getFullYear());
}

function buildBuckets(range, granularity, stats) {
  const effectiveStart = new Date(range.since || stats.first_used_at || range.until);
  const cursor = startOfDay(effectiveStart);
  const end = new Date(range.until);
  if (granularity === 'week') {
    const weekday = cursor.getDay() || 7;
    cursor.setDate(cursor.getDate() - weekday + 1);
  } else if (granularity === 'month') {
    cursor.setDate(1);
  } else if (granularity === 'year') {
    cursor.setMonth(0, 1);
  }

  const buckets = [];
  while (cursor <= end) {
    buckets.push({ key: bucketKey(cursor, granularity), date: new Date(cursor), value: 0 });
    if (granularity === 'day') cursor.setDate(cursor.getDate() + 1);
    else if (granularity === 'week') cursor.setDate(cursor.getDate() + 7);
    else if (granularity === 'month') cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setFullYear(cursor.getFullYear() + 1);
  }
  return buckets;
}

function bucketLabel(bucket, granularity) {
  if (granularity === 'day') return `${bucket.date.getMonth() + 1}/${bucket.date.getDate()}`;
  if (granularity === 'week') return `${bucket.date.getMonth() + 1}/${bucket.date.getDate()}週`;
  if (granularity === 'month') return `${bucket.date.getFullYear()}/${bucket.date.getMonth() + 1}`;
  return String(bucket.date.getFullYear());
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function renderTrend(range, stats) {
  const granularity = resolveGranularity(range, stats);
  const metric = elements['metric-select'].value;
  const rows = database.getTimeSeries({ ...range, granularity });
  const buckets = buildBuckets(range, granularity, stats);
  const values = new Map(rows.map((row) => [row.bucket, Number(metric === 'items' ? row.item_count : row.usage_count)]));
  for (const bucket of buckets) bucket.value = values.get(bucket.key) || 0;

  const labels = { day: '日別', week: '週別', month: '月別', year: '年別' };
  const metricLabel = metric === 'items' ? '使用画像数' : '使用回数';
  const trendRangeLabel = range.includeUndated ? '全期間（日時不明を除く）' : range.label;
  elements['trend-note'].textContent = `${trendRangeLabel}・${labels[granularity]}・${metricLabel}`;
  elements['trend-chart'].replaceChildren();
  elements['empty-trend'].hidden = rows.length > 0;
  if (buckets.length === 0 || rows.length === 0) return;

  const width = 820;
  const height = 250;
  const padding = { left: 48, right: 18, top: 18, bottom: 34 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.value));
  const x = (index) => padding.left + (buckets.length === 1 ? chartWidth / 2 : index / (buckets.length - 1) * chartWidth);
  const y = (value) => padding.top + chartHeight - value / maximum * chartHeight;

  for (let step = 0; step <= 4; step += 1) {
    const value = maximum * (4 - step) / 4;
    const lineY = padding.top + chartHeight * step / 4;
    elements['trend-chart'].append(svgElement('line', { x1: padding.left, y1: lineY, x2: width - padding.right, y2: lineY, class: 'chart-grid' }));
    const label = svgElement('text', { x: padding.left - 8, y: lineY + 3, 'text-anchor': 'end', class: 'chart-axis-label' });
    label.textContent = String(Math.round(value));
    elements['trend-chart'].append(label);
  }

  const points = buckets.map((bucket, index) => `${x(index)},${y(bucket.value)}`);
  const areaPoints = `${padding.left},${padding.top + chartHeight} ${points.join(' ')} ${x(buckets.length - 1)},${padding.top + chartHeight}`;
  elements['trend-chart'].append(svgElement('polygon', { points: areaPoints, class: 'chart-area' }));
  elements['trend-chart'].append(svgElement('polyline', { points: points.join(' '), class: 'chart-line' }));

  const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));
  buckets.forEach((bucket, index) => {
    if (buckets.length <= 60 || bucket.value > 0) {
      const circle = svgElement('circle', { cx: x(index), cy: y(bucket.value), r: buckets.length <= 60 ? 4 : 2.5, class: 'chart-point' });
      const title = svgElement('title');
      title.textContent = `${bucketLabel(bucket, granularity)}: ${bucket.value}`;
      circle.append(title);
      elements['trend-chart'].append(circle);
    }
    if (index % labelEvery === 0 || index === buckets.length - 1) {
      const label = svgElement('text', { x: x(index), y: height - 10, 'text-anchor': 'middle', class: 'chart-axis-label' });
      label.textContent = bucketLabel(bucket, granularity);
      elements['trend-chart'].append(label);
    }
  });
}

function renderWeekdays(range) {
  const metric = elements['metric-select'].value;
  const rows = database.getWeekdayStats(range);
  const values = new Map(rows.map((row) => [Number(row.weekday), Number(metric === 'items' ? row.item_count : row.usage_count)]));
  const maximum = Math.max(1, ...values.values());
  const names = ['日', '月', '火', '水', '木', '金', '土'];
  elements['weekday-chart'].replaceChildren(...names.map((name, weekday) => {
    const value = values.get(weekday) || 0;
    const column = document.createElement('div');
    column.className = 'weekday-column';
    const wrap = document.createElement('div');
    wrap.className = 'weekday-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'weekday-bar';
    bar.style.height = `${Math.max(value > 0 ? 5 : 1, value / maximum * 100)}%`;
    bar.title = `${name}曜日: ${value}`;
    wrap.append(bar);
    const count = document.createElement('span');
    count.className = 'weekday-value';
    count.textContent = String(value);
    const label = document.createElement('span');
    label.className = 'weekday-name';
    label.textContent = name;
    column.append(wrap, count, label);
    return column;
  }));
}

function renderActivity() {
  const today = startOfDay();
  const currentSunday = shiftDays(today, -today.getDay());
  const start = shiftDays(currentSunday, -52 * 7);
  const end = endOfDay(today);
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
    const middleOfWeek = shiftDays(start, week * 7 + 3);
    if (middleOfWeek.getMonth() !== previousMonth) {
      const label = document.createElement('span');
      label.textContent = `${middleOfWeek.getMonth() + 1}月`;
      label.style.gridColumn = String(week + 2);
      monthLabels.push(label);
      previousMonth = middleOfWeek.getMonth();
    }
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = shiftDays(start, week * 7 + weekday);
      const count = activity.get(dateKey(date)) || 0;
      const level = count === 0 || maximum === 0 ? 0 : Math.max(1, Math.ceil(Math.log1p(count) / Math.log1p(maximum) * 4));
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

async function selectRankingItem(itemId) {
  try {
    const item = await eagle.item.getById(itemId);
    if (typeof item?.select === 'function') {
      await item.select();
      return;
    }
    if (typeof eagle.item.select === 'function') {
      await eagle.item.select([itemId]);
      return;
    }
    if (typeof eagle.item.open === 'function') {
      await eagle.item.open(itemId);
      return;
    }
    if (typeof item?.open === 'function') {
      await item.open();
      return;
    }
    throw new Error(`画像選択APIに対応していません（Eagle ${eagle.app.version} Build ${eagle.app.build}）。`);
  } catch (error) {
    console.error(error);
    elements.status.textContent = `画像を選択できませんでした: ${error.message}`;
  }
}

function renderRanking(range) {
  const ranking = database.getRanking({ ...range, limit: 100 });
  elements['ranking-note'].textContent = range.label;
  elements.ranking.replaceChildren(...ranking.map((item, index) => {
    const row = document.createElement('li');
    row.className = 'rank-row';
    row.title = 'クリックしてEagle上で選択';
    row.addEventListener('click', () => selectRankingItem(item.eagle_item_id));
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
    const details = [];
    if (item.last_used_at) details.push(`最終使用: ${new Date(item.last_used_at).toLocaleString('ja-JP')}`);
    if (Number(item.undated_count) > 0) details.push(`日時不明: ${item.undated_count}回`);
    detail.textContent = details.join(' / ') || '日時情報なし';
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
    const range = getRange();
    const stats = renderSummary(range);
    renderTrend(range, stats);
    renderWeekdays(range);
    renderActivity();
    renderRanking(range);
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

function initializeFilters() {
  const today = startOfDay();
  elements['end-date'].value = dateKey(today);
  elements['start-date'].value = dateKey(shiftDays(today, -29));
  elements['range-select'].addEventListener('change', () => {
    elements['custom-range'].hidden = elements['range-select'].value !== 'custom';
    refresh();
  });
  for (const id of ['start-date', 'end-date', 'metric-select', 'granularity-select']) {
    elements[id].addEventListener('change', refresh);
  }
}

initializeFilters();
elements['refresh-button'].addEventListener('click', refresh);

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
