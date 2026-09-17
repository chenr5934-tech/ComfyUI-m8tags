/* 法典检索 · 本地离线版 — 卡片式 UI（参照 novelai.quicktagcloud.com）
 * 卡片 = 预览图窗位（预留）+ 简介标题 + tags；点击卡片复制全部，点 tag 复制单个。
 * file:// 可用：数据为 data/*.js 全局变量。
 */
'use strict';

const $ = id => document.getElementById(id);
const state = {
  codexId: '',
  data: null,          // { meta, entries }
  searchable: null,    // [{entry, hay}]
  query: '',
  activePath: [],      // 分类过滤
  nsfwOn: false,
  onlyNew: false,
  shown: 0,
  PAGE: 120,
};

/* ---------- 浏览状态持久化 ----------
 * 小窗每次关掉再打开都从头看，很难受。把「看的是哪部、搜了什么、缩在哪个分类、
 * 滚到哪了」存进 localStorage，下次进来原地接着看。
 *
 * 优先级：URL 参数 > 本地缓存 > 第一部法典。小窗是被插件带着 codex/q 打开的，
 * 那代表节点当前的意图，不能被上次的缓存盖掉。
 */
const VIEW_KEY = 'qtc-view';

/* 存了多少条已经渲染出来 —— 光记 scrollY 不够：列表是 120 条一批分页渲染的，
 * 只把滚动位置还原回去、内容却还没铺到那个高度，浏览器只能停在实际高度上。 */
function readView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') || {}; }
  catch (e) { return {}; }
}

function saveView(patch) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(Object.assign(readView(), patch, { ts: Date.now() })));
  } catch (e) { /* 无痕模式禁写存储时静默跳过，不该因此崩掉整页 */ }
}

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e2) { return false; }
  }
}

let toastTimer = null;
function toast(msg) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 1500);
}

/* ---------- 法典加载 ---------- */

function loadCodex(id) {
  return new Promise((resolve, reject) => {
    if (window.QTC_DATA && window.QTC_DATA[id]) return resolve(window.QTC_DATA[id]);
    const s = document.createElement('script');
    s.src = `data/${id}.js`;
    s.onload = () => resolve(window.QTC_DATA[id]);
    s.onerror = () => reject(new Error(`加载 data/${id}.js 失败`));
    document.head.appendChild(s);
  });
}

function buildSearchable(entries) {
  return entries.map(entry => ({
    entry,
    hay: [entry.title, (entry.path || []).join(' '), entry.tags].join('\n').toLowerCase(),
  }));
}

/* ---------- 法典选择 ---------- */

function populateSelect() {
  const sel = $('codexSelect');
  sel.innerHTML = '';
  for (const m of window.QTC_META) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.title}（${m.entryCount}）${m.nsfw ? ' [NSFW]' : ''}`;
    sel.appendChild(opt);
  }
  sel.onchange = () => selectCodex(sel.value);
}

async function selectCodex(id, opts) {
  const o = opts || {};
  const meta = window.QTC_META.find(m => m.id === id);
  if (!meta) return;
  if (meta.nsfw && !state.nsfwOn) {
    showNsfwGate(meta);
    return;
  }
  hideNsfwGate();
  state.codexId = id;
  /* opts 只在「回到上次看到哪」时传，用来把分类和搜索词一起带回来。
     用户自己点下拉切换法典时不传，照旧清空。 */
  state.activePath = Array.isArray(o.path) ? o.path.slice() : [];
  state.query = typeof o.query === 'string' ? o.query : '';
  $('search').value = state.query;
  setStatus(`正在加载 ${meta.title}…`);
  try {
    const data = await loadCodex(id);
    state.data = data;
    state.searchable = buildSearchable(data.entries);
    /* 必须等 state.data 就位再画树。早一步画，renderNode 里那个
       `state.data ? state.data.entries.length : 0` 拿到的是上一个法典的条目数
       （首屏则是 null → 0），「全部」那一行会和右边列表当场矛盾。 */
    renderTree(meta.tree || []);
    $('footSource').textContent = `${meta.title} · v${meta.version || '?'} · ${meta.author || '未知作者'}${meta.source ? ' · ' + meta.source : ''}`;
    setStatus(`已加载 ${data.entries.length} 条词条（${meta.title}）`);
    runSearch();

    const targetY = Number(o.scrollY) > 0 ? Number(o.scrollY) : 0;
    saveView({
      codexId: id,
      query: state.query,
      path: state.activePath,
      scrollY: targetY,
    });
    if (targetY > 0) restoreScroll(targetY);
  } catch (e) {
    setStatus(`加载失败：${e.message}`);
  }
}

/* 回到上次的滚动位置。
 * 列表是 120 条一批分页渲染的，内容高度不一定已经铺到目标位置，所以是
 * 「滚一次 → 不够高就再补一批 → 再滚」，最多补 40 批（≈4800 条）就放弃，
 * 免得递归停不下来。恢复期间滚动监听暂停写缓存，否则会被中间的中间值覆盖。 */
let restoring = false;

function restoreScroll(targetY, tries) {
  const n = tries || 0;
  restoring = true;
  requestAnimationFrame(() => {
    window.scrollTo(0, targetY);
    const more = $('moreBtn');
    if (window.scrollY < targetY - 4 && more && n < 40) {
      more.remove();
      renderMore();
      restoreScroll(targetY, n + 1);
      return;
    }
    restoring = false;
  });
}

/* 滚动写缓存要节流：scroll 一秒能触发几十次，每次都写 localStorage 会拖慢滚动。 */
let scrollSaveTimer = null;

function saveScrollSoon() {
  if (restoring) return;   /* 恢复过程中不写，否则会把目标位置覆盖成中间值 */
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => saveView({ scrollY: window.scrollY }), 250);
}

/* ---------- 分类树 ---------- */

function renderTree(nodes) {
  const box = $('tree');
  box.innerHTML = '';
  const root = { name: '全部', count: state.data ? state.data.entries.length : 0, children: nodes };
  box.appendChild(renderNode(root, []));
}

function renderNode(node, path) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  const isActive = pathEqual(state.activePath, path);
  const hasKids = node.children && node.children.length;
  row.innerHTML = `<span class="twist">${hasKids ? (isActive ? '▾' : '▸') : ''}</span><span>${esc(node.name)}</span><span class="count">${node.count != null ? node.count : ''}</span>`;
  row.title = node.name;
  row.onclick = () => togglePath(path, row, wrap, hasKids);
  if (isActive) row.classList.add('active');
  wrap.appendChild(row);
  if (hasKids) {
    const kids = document.createElement('div');
    kids.className = 'tree-children';
    kids.hidden = !isActive;
    for (const c of node.children) kids.appendChild(renderNode(c, [...path, c.name]));
    wrap.appendChild(kids);
  }
  return wrap;
}

function pathEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

function togglePath(path, row, wrap, hasKids) {
  if (pathEqual(state.activePath, path)) {
    state.activePath = [];
  } else {
    state.activePath = path;
  }
  if (hasKids) {
    const kids = wrap.querySelector('.tree-children');
    if (kids) kids.hidden = !pathEqual(state.activePath, path);
    row.querySelector('.twist').textContent = pathEqual(state.activePath, path) ? '▾' : '▸';
  }
  document.querySelectorAll('#tree .tree-row').forEach(r => r.classList.remove('active'));
  row.classList.add('active');
  runSearch();
}

/* ---------- 搜索 ---------- */

function parseQuery(q) {
  const tokens = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const must = [], mustNot = [];
  for (const t of tokens) (t.startsWith('-') ? mustNot : must).push(t.replace(/^-+/, ''));
  return { must, mustNot };
}

function entryMatches(rec, must, mustNot) {
  if (state.activePath.length) {
    const p = rec.entry.path || [];
    if (!state.activePath.every((seg, i) => p[i] === seg)) return false;
  }
  if (state.onlyNew && !rec.entry.new) return false;
  for (const t of must) if (!rec.hay.includes(t)) return false;
  for (const t of mustNot) if (rec.hay.includes(t)) return false;
  return true;
}

function runSearch() {
  if (!state.data) return;
  const { must, mustNot } = parseQuery(state.query);
  const t0 = performance.now();
  const results = state.searchable.filter(rec => entryMatches(rec, must, mustNot));
  const ms = (performance.now() - t0).toFixed(1);
  state.results = results;
  state.shown = 0;
  setStatus(`找到 ${results.length} 条${must.length || mustNot.length ? `（匹配 ${state.query}）` : ''} · 用时 ${ms}ms · 点击卡片复制全部，点单个 tag 复制`);
  const stats = $('stats');
  if (stats) stats.textContent = `${results.length} / ${state.data.entries.length} 条`;
  renderMore();
  if (results.length === 0) {
    $('empty').hidden = false;
    $('empty').querySelector('p').textContent = '没有匹配的词条，换个关键词试试（支持中文标题 / 英文 tag / 分类名；`-词` 表示排除）。';
    $('results').innerHTML = '';
  } else {
    $('empty').hidden = true;
  }
  /* 筛选条件一变就记一笔：法典 / 搜索词 / 分类，下次进来直接回到这个视图。
     scrollY 不在这里写 —— patch 是合并的，交给滚动那边的节流去更新。 */
  saveView({ codexId: state.codexId, query: state.query, path: state.activePath });
}

function renderMore() {
  const box = $('results');
  const frag = document.createDocumentFragment();
  const slice = state.results.slice(state.shown, state.shown + state.PAGE);
  for (const rec of slice) frag.appendChild(renderCard(rec));
  if (state.shown === 0) box.innerHTML = '';
  box.appendChild(frag);
  state.shown += slice.length;
  if (state.shown < state.results.length && !$('moreBtn')) {
    const btn = document.createElement('button');
    btn.id = 'moreBtn';
    btn.textContent = `加载更多（${state.results.length - state.shown}）`;
    btn.className = 'more-btn';
    btn.onclick = () => { btn.remove(); renderMore(); };
    box.appendChild(btn);
  } else if (state.shown >= state.results.length) {
    const b = $('moreBtn'); if (b) b.remove();
  }
}

/* ---------- 高亮 ---------- */

function highlight(text, tokens) {
  if (!tokens.length) return esc(text);
  /* text 先经过 esc 才去匹配，所以 token 也得 esc 一次 —— 否则搜 `a&b`
     或 `<lora:` 这类词时，被匹配的是转义后的 `a&amp;b`，永远匹配不上。 */
  const re = new RegExp('(' + tokens.map(t => escRe(esc(t))).join('|') + ')', 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}

/* ---------- 与法典图鉴（ComfyUI 插件）小窗的通信 ----------
 * 站点单独打开时这里的判断全为假，行为跟以前一模一样；
 * 只有被插件小窗内嵌时，卡片上才会多出「加入已选栏」。 */

function hostedInPlugin() {
  try {
    return window.parent !== window;
  } catch (e) {
    return false;
  }
}

/* extra 用来传「我的图库」那种自带内容的条目：它不在法典里，宿主查不到，
   所以正负提示词要随消息一起发过去。不带 extra 就是原来的法典词条。 */
function postPick(entry, extra) {
  try {
    window.parent.postMessage(Object.assign({
      source: 'codex-atlas',
      type: 'pick',
      kind: 'codex',
      codex: state.codexId || '',
      id: entry.id || '',
      title: entry.title || '',
      tags: entry.tags || '',
      negative: entry.n || '',
    }, extra || {}), window.location.origin);
  } catch (e) {
    console.warn('[法典图鉴] 向宿主发送失败：', e);
  }
}

/* ---------- 卡片 ---------- */

function renderCard(rec) {
  const e = rec.entry;
  const { must } = parseQuery(state.query);
  const card = document.createElement('div');
  card.className = 'card';

  /* 预览图窗位：有 img 字段则渲染 <img>（本地 images/<codex>/<file>），否则占位 */
  const imgWrap = document.createElement('div');
  imgWrap.className = 'card-img-wrap';
  if (e.img) {
    const img = document.createElement('img');
    img.className = 'card-img';
    img.loading = 'lazy';
    img.alt = e.title;
    img.src = `images/${state.codexId}/${encodeURIComponent(e.img)}${e.rev ? '?v=' + encodeURIComponent(e.rev) : ''}`;
    img.onerror = () => {
      img.remove();
      imgWrap.appendChild(placeholderEl());
    };
    imgWrap.appendChild(img);
  } else {
    imgWrap.appendChild(placeholderEl());
  }
  if (e.new) {
    const badges = document.createElement('div');
    badges.className = 'card-badges';
    const b = document.createElement('span');
    b.className = 'badge-new';
    b.textContent = '新增';
    badges.appendChild(b);
    imgWrap.appendChild(badges);
  }
  card.appendChild(imgWrap);

  /* 正文：简介标题（词条说明）+ tags */
  const body = document.createElement('div');
  body.className = 'card-body';

  const titleRow = document.createElement('div');
  titleRow.className = 'card-title-row';
  const title = document.createElement('h3');
  title.className = 'card-title';
  title.innerHTML = highlight(e.title, must);
  titleRow.appendChild(title);
  body.appendChild(titleRow);

  const path = document.createElement('div');
  path.className = 'card-path';
  path.textContent = (e.path || []).join(' / ');
  body.appendChild(path);

  const tagsBox = document.createElement('div');
  tagsBox.className = 'card-tags';
  const parts = (e.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  for (const p of parts) {
    const span = document.createElement('span');
    span.className = 'tag';
    span.innerHTML = highlight(p, must);
    span.title = '点击复制此 tag';
    span.onclick = async ev => {
      ev.stopPropagation();
      const ok = await copyText(p);
      flashCopied(card);
      toast(ok ? `已复制：${p.slice(0, 50)}` : '复制失败');
    };
    tagsBox.appendChild(span);
    tagsBox.appendChild(document.createTextNode(', '));
  }
  body.appendChild(tagsBox);

  if (e.n) {
    const neg = document.createElement('div');
    neg.className = 'card-neg';
    neg.textContent = e.n;
    body.appendChild(neg);
  }
  if (e.note) {
    const note = document.createElement('div');
    note.className = 'card-note';
    note.textContent = `📝 ${e.note}`;
    body.appendChild(note);
  }
  if (e.cp && e.cp.length) {
    const cp = document.createElement('div');
    cp.className = 'card-cp';
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = `角色 Prompt（${e.cp.length}）`;
    det.appendChild(sum);
    for (const c of e.cp) {
      const pre = document.createElement('pre');
      pre.textContent = `${c.l}: ${c.p}${c.n ? '\n负面: ' + c.n : ''}`;
      det.appendChild(pre);
    }
    cp.appendChild(det);
    body.appendChild(cp);
  }

  /* 操作条（hover 显示） */
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const mkBtn = (label, text, primary) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = async ev => {
      ev.stopPropagation();
      const ok = await copyText(text);
      flashCopied(card);
      toast(ok ? `已复制 ${label}` : '复制失败');
    };
    return b;
  };
  const allText = [e.tags, e.n ? `负面: ${e.n}` : ''].filter(Boolean).join('\n');
  /* 被插件小窗内嵌时多一个「加入已选栏」——独立打开站点时不会出现 */
  if (hostedInPlugin()) {
    const pick = document.createElement('button');
    pick.textContent = '＋ 加入已选栏';
    pick.className = 'primary';
    pick.title = '加入右侧已选栏，凑齐后一次推送到 ComfyUI 节点';
    pick.onclick = ev => {
      ev.stopPropagation();
      postPick(e);
      flashCopied(card);
      toast(`已加入已选栏：${e.title}`);
    };
    actions.appendChild(pick);
  }
  actions.appendChild(mkBtn('复制全部', allText, true));
  actions.appendChild(mkBtn('复制正向', e.tags || ''));
  if (e.n) actions.appendChild(mkBtn('复制负面', e.n));
  body.appendChild(actions);

  card.appendChild(body);

  /* 点卡片空白处复制全部 */
  card.onclick = async () => {
    const ok = await copyText(allText);
    flashCopied(card);
    toast(ok ? `已复制「${e.title}」` : '复制失败');
  };
  return card;
}

function placeholderEl() {
  const ph = document.createElement('div');
  ph.className = 'card-img-placeholder';
  ph.innerHTML = `<span class="ph-icon">🖼</span><span>预览图</span><span style="font-size:10.5px;opacity:.8">待添加</span>`;
  return ph;
}

function flashCopied(card) {
  card.classList.remove('copied');
  void card.offsetWidth;
  card.classList.add('copied');
  setTimeout(() => card.classList.remove('copied'), 420);
}

/* ---------- NSFW 门 ---------- */

function showNsfwGate(meta) {
  $('nsfwGate').hidden = false;
  $('nsfwGate').querySelector('h2').textContent = `⚠️ 成人内容法典：${meta.title}`;
  $('nsfwEnter').onclick = () => {
    state.nsfwOn = true;
    $('nsfwToggle').checked = true;
    try { localStorage.setItem('qtc-nsfw', '1'); } catch (e) {} /* 与手动勾选一致：持久化授权 */
    hideNsfwGate();
    selectCodex(meta.id);
  };
  $('nsfwCancel').onclick = () => {
    hideNsfwGate();
    $('codexSelect').value = state.codexId || window.QTC_META[0].id;
  };
}
function hideNsfwGate() { $('nsfwGate').hidden = true; }

/* ---------- 其他 ---------- */

function setStatus(s) { $('status').textContent = s; }

function randomEntry() {
  if (!state.data) return;
  const i = Math.floor(Math.random() * state.data.entries.length);
  const rec = state.searchable[i];
  const card = renderCard(rec);
  const box = $('results');
  box.innerHTML = '';
  box.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStatus(`🎲 随机：${rec.entry.title}`);
}

/* ---------- 日/夜模式 ---------- */

function applyThemeIcon() {
  const dark = document.documentElement.classList.contains('dark');
  $('themeBtn').textContent = dark ? '☀️' : '🌙';
  $('themeBtn').title = dark ? '切换到白天模式' : '切换到黑夜模式';
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  try { localStorage.setItem('qtc-theme', dark ? 'dark' : 'light'); } catch (e) {}
  applyThemeIcon();
}

/* ---------- 初始化 ---------- */

function init() {
  try {
    populateSelect();

    /* NSFW 授权要先恢复：上次停在 R18 法典的话，晚一步就会先弹一次门。 */
    try { state.nsfwOn = localStorage.getItem('qtc-nsfw') === '1'; } catch (e) {}
    $('nsfwToggle').checked = state.nsfwOn;

    const first = window.QTC_META[0];
    /* 参数名是 c / q —— 插件小窗用 buildAtlasUrl() 拼的就是这两个。
       （站点以前压根没读 URL 参数，所以小窗打开永远是第一部法典，
       不跟节点上选的那部走；这里补上。） */
    const sp = new URLSearchParams(location.search);
    const urlCodex = sp.get('c') || '';
    const urlQuery = sp.get('q') || '';
    const saved = readView();

    /* 带 URL 参数 = 插件小窗按节点的意图打开，一切以参数为准，不套上次缓存；
       没带参数（独立打开 / 双击 bat 启动）才回到上次看到哪。 */
    const hasUrlCodex = !!(urlCodex && window.QTC_META.some(m => m.id === urlCodex));
    const savedOk = !hasUrlCodex && !!saved.codexId && window.QTC_META.some(m => m.id === saved.codexId);

    state.onlyNew = !hasUrlCodex && saved.onlyNew === true;
    $('newToggle').checked = state.onlyNew;

    const startId = hasUrlCodex ? urlCodex : (savedOk ? saved.codexId : first.id);
    $('codexSelect').value = startId;
    selectCodex(startId, hasUrlCodex
      ? { query: urlQuery, path: [] }
      : (savedOk ? { query: saved.query || '', path: saved.path || [], scrollY: saved.scrollY || 0 } : {}));
  } catch (e) {
    console.error(e);
    $('empty').hidden = false;
    $('empty').querySelector('p').textContent = '数据文件加载失败：' + e.message;
    $('empty').querySelector('.dim').textContent = '请确认整个 tag-atlas 文件夹（含 data/ 子目录）完整，且 index.html 与 data/ 在同一目录。';
    return;
  }

  $('search').addEventListener('input', e => {
    state.query = e.target.value;
    runSearch();
  });
  $('randomBtn').onclick = randomEntry;
  $('themeBtn').onclick = toggleTheme;
  applyThemeIcon();

  $('newToggle').addEventListener('change', e => {
    state.onlyNew = e.target.checked;
    runSearch();
  });
  $('nsfwToggle').addEventListener('change', e => {
    state.nsfwOn = e.target.checked;
    try { localStorage.setItem('qtc-nsfw', state.nsfwOn ? '1' : '0'); } catch (err) {}
    if (state.nsfwOn) hideNsfwGate();
    const sel = $('codexSelect');
    if (sel.value) selectCodex(sel.value);
  });

  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('search')) {
      const sv = $('selfView');
      if (sv && !sv.hidden) return;      // 图库视图里 / 不该抢去聚焦搜索框
      e.preventDefault();
      $('search').focus();
    }
    if (e.key === 'Escape') {
      /* 「我的图库」开着时不要插手：那边的 Esc 是关详情弹窗/确认框用的。
         这里一旦跟着跑，会把搜索框清空并重建法典卡片列表 —— 用户看不见
         （.layout 已隐藏），但切回法典时搜索词已经没了。 */
      const sv = $('selfView');
      if (sv && !sv.hidden) return;
      $('search').value = '';
      state.query = '';
      runSearch();
      $('search').blur();
    }
  });

  /* 触底加载更多 */
  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 600) {
      const btn = $('moreBtn');
      if (btn) { btn.remove(); renderMore(); }
    }
    saveScrollSoon();
  });

  $('empty').hidden = false;
  $('empty').querySelector('p').textContent = '正在初始化…';
}

init();
