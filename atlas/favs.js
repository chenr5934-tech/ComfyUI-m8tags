/* 我的收藏 —— 把看中的词条钉住，下次直接从收藏里拿，不用再从头翻。
 *
 * 只存 `{codex, id, title, group, ts}`：**内容不存快照**，每次打开收藏时按 codex
 * 现查法典数据。这样法典更新后收藏里看到的也是最新的，不会留一份过期的旧 tags。
 * 代价是某条词条在法典里被删了就找不回来 —— 那种情况单独提示，不静默吞掉。
 *
 * 收藏分类和图库的分组是两套独立的东西：一个管词条，一个管图片，别混。
 */
(function () {
  'use strict';

  const KEY = 'qtc-favs';
  const $ = id => document.getElementById(id);

  /* 内存里的形状：
     { groups: ["画风", "服装"], items: { "codex::id": {codex,id,title,group,ts} } }
     未分类用空串，省得和用户自建的分类名撞上。 */
  let data = { groups: [], items: {} };
  let activeGroup = null;      // null = 全部；'' = 未分类；其它 = 分类名
  let seq = 0;                 // 渲染序号：异步加载回来时用来丢弃过期的那一轮

  /* ---------- 存取 ---------- */

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && typeof raw === 'object') {
        data.groups = Array.isArray(raw.groups) ? raw.groups.filter(g => typeof g === 'string' && g) : [];
        data.items = (raw.items && typeof raw.items === 'object') ? raw.items : {};
      }
    } catch (e) { /* 坏数据就当空的，别让整页起不来 */
      data = { groups: [], items: {} };
    }
    /* 分类被删过、但词条还挂着旧分类名时，把它们收回未分类 */
    for (const k of Object.keys(data.items)) {
      const it = data.items[k];
      if (!it || typeof it !== 'object' || !it.codex || !it.id) { delete data.items[k]; continue; }
      if (it.group && data.groups.indexOf(it.group) < 0) it.group = '';
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { /* 无痕模式禁写存储时静默跳过 */ }
  }

  const keyOf = (codex, id) => codex + '::' + id;

  /* ---------- 对外数据接口（卡片星标用） ---------- */

  function has(codex, id) {
    return !!data.items[keyOf(codex, id)];
  }

  function toggle(codex, id, title) {
    const k = keyOf(codex, id);
    if (data.items[k]) {
      delete data.items[k];
      save();
      notify('已取消收藏');
      return false;
    }
    data.items[k] = { codex, id, title: title || id, group: '', ts: Date.now() };
    save();
    notify('已收藏 · 进「★ 我的收藏」里能找到');
    return true;
  }

  function list() {
    return Object.keys(data.items).map(k => data.items[k]);
  }

  function countIn(group) {
    return list().filter(it => (group === null ? true : (it.group || '') === group)).length;
  }

  function setGroup(codex, id, group) {
    const it = data.items[keyOf(codex, id)];
    if (!it) return;
    it.group = group || '';
    save();
  }

  function addGroup(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (data.groups.indexOf(n) >= 0) { notify('已经有这个分类了'); return false; }
    data.groups.push(n);
    save();
    return true;
  }

  function delGroup(name) {
    const i = data.groups.indexOf(name);
    if (i < 0) return;
    data.groups.splice(i, 1);
    /* 分类里的词条不跟着删 —— 退回未分类，比连词条一起没了合理 */
    let moved = 0;
    for (const k of Object.keys(data.items)) {
      if (data.items[k].group === name) { data.items[k].group = ''; moved++; }
    }
    save();
    notify(moved ? `已删分类「${name}」，${moved} 条退回未分类` : `已删分类「${name}」`);
  }

  function notify(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(notify._t);
    notify._t = setTimeout(() => { t.style.display = 'none'; }, 1600);
  }

  /* ---------- 左栏：分类 ---------- */

  function renderGroups() {
    const box = $('favGroupList');
    if (!box) return;
    box.textContent = '';

    const rows = [
      { name: '全部收藏', value: null, n: countIn(null) },
      { name: '未分类', value: '', n: countIn('') },
    ].concat(data.groups.map(g => ({ name: g, value: g, n: countIn(g) })));

    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'self-group-row' + (activeGroup === r.value ? ' active' : '');
      row.onclick = () => { activeGroup = r.value; render(); };

      const nm = document.createElement('span');
      nm.className = 'self-group-name';
      nm.textContent = r.name;

      const cnt = document.createElement('span');
      cnt.className = 'self-group-count';
      cnt.textContent = r.n;

      row.append(nm, cnt);

      /* 只有自建分类能删，「全部」「未分类」是固定的 */
      if (r.value) {
        const del = document.createElement('button');
        del.className = 'self-group-del';
        del.textContent = '×';
        del.title = '删除分类（里面的词条退回未分类）';
        del.onclick = (ev) => {
          ev.stopPropagation();
          if (!window.confirm(`删除分类「${r.name}」？里面的词条会退回未分类，不会被删。`)) return;
          delGroup(r.name);
          if (activeGroup === r.name) activeGroup = null;
          render();
        };
        row.appendChild(del);
      }
      box.appendChild(row);
    }

    const stats = $('favGroupStats');
    if (stats) stats.textContent = `共 ${countIn(null)} 条 · ${data.groups.length} 个分类`;
  }

  /* ---------- 主区：卡片 ---------- */

  async function renderCards() {
    const box = $('favResults');
    const empty = $('favEmpty');
    const status = $('favStatus');
    if (!box) return;

    /* 先自增再取值 —— 写成 seq++ 的话 mine 永远落后 seq 一步，
       下面那个“这轮作废”的判断会次次成立，卡片一条都出不来。 */
    const mine = ++seq;
    const items = list().filter(it => (activeGroup === null ? true : (it.group || '') === activeGroup));

    box.textContent = '';
    if (!items.length) {
      if (empty) {
        empty.hidden = false;
        empty.querySelector('p').textContent = activeGroup === null
          ? '还没有收藏。在法典里把喜欢的词条点上 ☆ 就会出现在这里。'
          : '这个分类里还没有词条。';
      }
      if (status) status.textContent = '';
      return;
    }
    if (empty) empty.hidden = true;

    /* 按法典分组批量加载：同一部只读一次文件 */
    const byCodex = {};
    for (const it of items) (byCodex[it.codex] = byCodex[it.codex] || []).push(it);

    const qtc = window.__qtc;
    if (!qtc) { if (status) status.textContent = '法典模块还在加载，稍后再试'; return; }

    let shown = 0, lost = 0;
    for (const codex of Object.keys(byCodex)) {
      let entries;
      try {
        const d = await qtc.loadCodex(codex);
        entries = (d && d.entries) || [];
      } catch (e) {
        entries = [];
      }
      if (mine !== seq) return;      /* 期间又渲染过一轮，这轮作废 */

      const idx = new Map();
      for (const e of entries) idx.set(e.id, e);
      const meta = (window.QTC_META || []).find(m => m.id === codex);

      for (const it of byCodex[codex]) {
        const entry = idx.get(it.id);
        if (!entry) { lost++; continue; }   /* 法典里没有了，跳过并计数 */

        const card = qtc.renderCard({ entry, codexId: codex });

        /* 卡片下方补一行：所属法典 + 分类下拉 */
        const body = card.querySelector('.card-body');
        if (body) {
          const row = document.createElement('div');
          row.className = 'fav-meta-row';

          const tag = document.createElement('span');
          tag.className = 'fav-codex-tag';
          tag.textContent = (meta && meta.title) || codex;
          tag.title = codex;

          const sel = document.createElement('select');
          sel.className = 'fav-group-sel';
          sel.title = '把这条放进哪个收藏分类';
          const opts = [{ v: '', t: '未分类' }].concat(data.groups.map(g => ({ v: g, t: g })));
          for (const o of opts) {
            const op = document.createElement('option');
            op.value = o.v;
            op.textContent = o.t;
            sel.appendChild(op);
          }
          sel.value = it.group || '';
          sel.onclick = ev => ev.stopPropagation();
          sel.onchange = () => {
            setGroup(it.codex, it.id, sel.value);
            if (activeGroup !== null) render();   /* 在某个分类里改，就把它挪走 */
            else renderGroups();
          };

          row.append(tag, sel);
          body.appendChild(row);
        }

        box.appendChild(card);
        shown++;
      }
    }

    if (status) {
      status.textContent = `收藏 ${shown} 条`
        + (activeGroup === null ? '' : ` · 当前分类「${activeGroup || '未分类'}」`)
        + (lost ? ` · ${lost} 条在法典里已找不到（法典更新后删掉了）` : '');
    }
  }

  function render() {
    renderGroups();
    renderCards();
  }

  /* ---------- 视图切换 ---------- */

  function showFavs(on) {
    const main = document.querySelector('.layout');
    const view = $('favView');
    const foot = document.querySelector('.foot');
    if (!view) return;

    if (on) {
      /* 图库和收藏是两个并列的全屏视图，不能同时开着 —— 先把图库收起来，
         它会顺带把 .layout / .foot 恢复显示，然后我们再盖掉。 */
      const sv = $('selfView');
      if (sv && !sv.hidden && window.SelfGallery) window.SelfGallery.showSelf(false);
    }

    view.hidden = !on;
    if (main) main.hidden = on;
    if (foot) foot.hidden = on;

    const btn = $('favBtn');
    if (btn) {
      btn.classList.toggle('on', on);
      btn.textContent = on ? '← 回到法典' : '★ 我的收藏';
    }
    const selfBtn = $('selfBtn');
    if (selfBtn && on) { selfBtn.classList.remove('on'); selfBtn.textContent = '＋ 我的图库'; }

    if (on) {
      render();
      view.scrollIntoView({ block: 'start' });
    } else {
      window.scrollTo({ top: 0 });
    }
  }

  /* ---------- 初始化 ---------- */

  function init() {
    load();
    const btn = $('favBtn');
    if (btn) btn.onclick = () => showFavs($('favView').hidden);
    const nw = $('favGroupNew');
    if (nw) {
      nw.onclick = () => {
        const name = (window.prompt('新分类名称（建好后在收藏卡片下方的下拉里把词条放进去）') || '').trim();
        if (!name) return;
        if (!addGroup(name)) return;
        render();
        notify('已新建分类：' + name);
      };
    }
    /* 图库那边开起来时，把收藏收掉 —— 否则两个全屏视图会叠着 */
    const selfBtn = $('selfBtn');
    if (selfBtn && !selfBtn.__favWrapped) {
      selfBtn.__favWrapped = true;
      const prev = selfBtn.onclick;
      selfBtn.onclick = (ev) => {
        const fav = $('favView');
        if (fav && !fav.hidden) showFavs(false);
        if (typeof prev === 'function') prev.call(selfBtn, ev);
      };
    }
    render();
  }

  window.Favs = {
    has, toggle, list, setGroup, addGroup, delGroup,
    showFavs, render, countIn,
    get groups() { return data.groups.slice(); },
  };

  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  } catch (e) {
    console.error('[我的收藏] 初始化失败：', e);
  }
})();
