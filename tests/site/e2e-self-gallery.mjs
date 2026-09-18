/* 「我的图库」端到端验证：驱动本机 Chromium（CDP）打开法典站点，检查三栏布局、
 * 卡片同构、复制行为、分组与上传链路。
 *
 *   node tools/e2e-self-gallery.mjs                        # 以 file:// 打开
 *   node tools/e2e-self-gallery.mjs http://127.0.0.1:8899/index.html   # 以 http 打开
 *
 * 需要本机有一份 Chromium（默认用 ms-playwright 缓存里的；可用 CHROME 环境变量覆盖）。
 * 不依赖 playwright 包 —— 直接讲 CDP。 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
/* 站点源码已经并进插件的 atlas/（独立站点目录不再单独存在），所以站点根是 HERE/../../atlas */
const SITE = resolve(HERE, "..", "..", "atlas", "index.html");
const SHOT = join(HERE, "_shot.png");          // 图库全貌
const SHOT_DETAIL = join(HERE, "_shot-detail.png");   // 详情弹窗
const SHOT_CONFIRM = join(HERE, "_shot-confirm.png"); // 删除确认框
const SHOT_REVIEW = join(HERE, "_shot-review.png");   // 上传审阅窗
const PORT = 9333;

/* 探针卡片的定位表达式。图库里可能有用户自己的图（排序还比探针新），
   所以不能靠"第一张卡片" —— 一律认标题为「探针图」的那张。 */
const PROBE = `[...document.querySelectorAll('#selfResults .card')].find(c => {`
  + ` const t = c.querySelector('.card-title'); return t && t.textContent === '探针图'; })`;

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = join(process.env.USERPROFILE || "", "AppData", "Local", "ms-playwright");
  if (existsSync(root)) {
    for (const d of readdirSync(root)) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const p = join(root, d, sub, "chrome.exe");
        if (existsSync(p)) return p;
      }
    }
  }
  return "chrome.exe";   // 交给 PATH
}

/* 拿图库里已有的一张图当上传样本；图库为空就退到站点 images/ 里找一张 */
function findSample() {
  const pick = (dir) => {
    try {
      const n = readdirSync(dir).find((x) => /\.(png|jpe?g)$/i.test(x));
      return n ? join(dir, n) : null;
    } catch (e) {
      return null;
    }
  };

  const selfDir = resolve(HERE, "..", "..", "atlas", "self-image");
  const own = pick(selfDir);
  if (own) return own;

  const imagesRoot = resolve(HERE, "..", "..", "atlas", "images");
  try {
    for (const codex of readdirSync(imagesRoot)) {
      const f = pick(join(imagesRoot, codex));
      if (f) return f;
    }
  } catch (e) { /* 没图就算了 */ }
  return null;
}

const CHROME = findChrome();
const SAMPLE = findSample();

const page_url = process.argv[2] || pathToFileURL(SITE).href;

const profile = mkdtempSync(join(tmpdir(), "cdp-prof-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--allow-file-access-from-files",
  "--window-size=1680,1300",
  "about:blank",
], { stdio: "ignore" });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of c.handlers) h(msg);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error("页面异常：" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  on(fn) { this.handlers.push(fn); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error("Chromium 没起来");
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

let dialogAnswer = "";
let cdp;

async function main() {
  const ws = await findPageWs();
  cdp = await CDP.connect(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const consoleErrors = [];
  let loaded = false;
  cdp.on((m) => {
    if (m.method === "Page.loadEventFired") loaded = true;
    if (m.method === "Page.javascriptDialogOpening") {
      cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: dialogAnswer });
    }
    if (m.method === "Runtime.exceptionThrown") {
      consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });

  await cdp.send("Page.navigate", { url: page_url });
  for (let i = 0; i < 60 && !loaded; i++) await sleep(200);
  await sleep(900);

  /* ---------- 0. 沙盒守卫：这个脚本绝不能碰用户真实的 self-image/ ----------
   * 写盘只有两个出口：后端接口（fetch）和 File System Access（showDirectoryPicker）。
   * 都堵死，并且记录每次尝试 —— 收尾断言全程没有真的落盘。 */
  await cdp.eval(`(() => {
    window.__diskOps = [];
    window.showDirectoryPicker = async () => {
      window.__diskOps.push('showDirectoryPicker(已拦)');
      throw new DOMException('blocked by e2e sandbox', 'AbortError');
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = (typeof input === 'string' ? input : (input && input.url) || '');
      if (url.includes('/codex_atlas/self-image')) {
        window.__diskOps.push('fetch ' + url + '(已拦)');
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'blocked by e2e sandbox' }), { status: 403 }));
      }
      return realFetch(input, init);
    };
    return true;
  })()`);

  /* ---------- 0b. CSS 结构自检 ----------
   * 悬空选择器（`xxx {` 后面直接跟另一条规则）会被 CSS 嵌套语法吞掉，
   * 之前真的踩过一次：三条 badge 规则被整个吃进 `.self-detail h4` 里。
   * 扁平 CSS 里每条 CSSStyleRule 的 cssRules 都应当是空的。 */
  const cssCheck = await cdp.eval(`(() => {
    const out = { sheets: 0, rules: 0, nested: [] };
    /* media / supports / keyframes 本来就装着子规则，要递归进去；
       只有「带选择器的规则里还装着规则」才是 CSS 嵌套吞规则的征兆。 */
    const walk = (list) => {
      for (const r of list) {
        out.rules++;
        if (r.selectorText && r.cssRules && r.cssRules.length) {
          out.nested.push(r.selectorText + ' 吞了 ' + r.cssRules.length + ' 条');
        }
        if (!r.selectorText && r.cssRules && r.cssRules.length) walk(r.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      out.sheets++;
      walk(rules);
    }
    return out;
  })()`);
  check("样式表没有嵌套吞规则",
    cssCheck.nested.length === 0 && cssCheck.rules > 150,
    `${cssCheck.sheets} 张表 / ${cssCheck.rules} 条规则`
      + (cssCheck.nested.length ? " | " + cssCheck.nested.join(", ") : ""));

  /* ---------- 1. 法典主界面仍正常 ---------- */
  const mainState = await cdp.eval(`(() => ({
    cards: document.querySelectorAll('#results .card').length,
    codex: document.getElementById('codexSelect').value,
    foot: document.getElementById('footSource').textContent,
  }))()`);
  check("法典主界面卡片已渲染", mainState.cards > 0, `${mainState.cards} 张卡片 / 法典=${mainState.codex}`);

  /* 分类树「全部」那一行必须是当前法典的条目数。
     它曾经读的是上一个法典的 state.data（首屏则是 null），显示 0。 */
  const treeCount = await cdp.eval(`(() => {
    const row = document.querySelector('#tree .tree-row');
    const count = row ? row.querySelector('.count').textContent.trim() : null;
    const meta = (window.QTC_META || [])[0] || {};
    return { count, expected: String(meta.entryCount), foot: document.getElementById('stats').textContent };
  })()`);
  check("分类树「全部」计数是当前法典的条目数",
    treeCount.count === treeCount.expected,
    `树=${treeCount.count} / 元数据=${treeCount.expected} / 侧栏=${treeCount.foot}`);

  /* ---------- 2. 切到我的图库，三栏就位 ---------- */
  await cdp.eval(`document.getElementById('selfBtn').click()`);
  await sleep(700);
  const layout = await cdp.eval(`(() => {
    const v = document.getElementById('selfView');
    const r = (sel) => { const n = document.querySelector(sel); return n ? n.getBoundingClientRect() : null; };
    const g = r('.self-groups'), m = r('.self-main'), u = r('.self-upload');
    return {
      visible: !v.hidden,
      hasGroups: !!g, hasMain: !!m, hasUpload: !!u,
      order: g && m && u ? (g.left < m.left && m.left < u.left) : false,
      widths: g && m && u ? [Math.round(g.width), Math.round(m.width), Math.round(u.width)] : null,
      dropBox: !!r('#selfDrop'),
      pathBox: !!r('.self-path'),
      masonry: !!r('#selfResults.masonry'),
    };
  })()`);
  check("我的图库视图可见", layout.visible);
  check("三栏都存在", layout.hasGroups && layout.hasMain && layout.hasUpload);
  check("左=分组 / 中=卡片 / 右=上传 的水平顺序", layout.order, "宽度 " + JSON.stringify(layout.widths));
  check("上传框与保存位置在右栏内", layout.dropBox && layout.pathBox);
  check("中栏用法典同款 masonry 网格", layout.masonry);

  /* ---------- 2b. 注入一条探针记录 ----------
   * 后面的断言全都基于它，这样 e2e 不再依赖"用户的图库里恰好有图"——
   * 图库被清空也照样能跑。只改内存里的 SELF_META，不碰磁盘。 */
  await cdp.eval(`(() => {
    window.SELF_META = (window.SELF_META || []).filter(r => r.file !== '__probe__.png');
    window.SELF_META.push({
      file: '__probe__.png',
      title: '探针图',
      addedAt: 1700000000,
      meta: {
        format: 'png', source: 'a1111',
        positive: 'probe_a, probe_b, probe_c',
        negative: 'probe_neg',
        checkpoint: { name: 'ProbeModel', file: 'ProbeModel', hash: 'deadbeef01' },
        loras: [{ name: 'probe_lora', file: 'probe_lora', weight: 1, hash: 'cafebabe02' }],
        params: { Steps: '20', Size: '1024x1024' },
        raw: { parameters: 'probe raw text' },
        warnings: [],
      },
    });
    window.SelfGallery.renderAll();
    return true;
  })()`);
  await sleep(500);

  /* 基线：探针已经进去了，图库原本有几张就是几张。
     后面一律用相对值判断，不再假设"图库里恰好一张"——
     那种断言在图库被清空（或用户多存了几张）时会整片崩掉。 */
  const baseline = await cdp.eval(`({
    records: (window.SELF_META || []).length,
    cards: document.querySelectorAll('#selfResults .card').length,
  })`);

  /* ---------- 3. 卡片与法典同构 ---------- */
  const card = await cdp.eval(`(() => {
    const c = ${PROBE};
    if (!c) return { found: false };
    return {
      found: true,
      isCard: c.classList.contains('card'),
      notSelfCard: document.querySelectorAll('#selfResults .self-card').length === 0,
      /* 探针那张图在磁盘上并不存在，<img> 会 onerror 换成占位块 ——
         所以这里只验证"图窗位在"，不要求真的有像素 */
      imgWrap: !!c.querySelector('.card-img-wrap'),
      title: (c.querySelector('.card-title') || {}).textContent || '',
      meta: (c.querySelector('.card-meta') || {}).textContent || '',
      tags: c.querySelectorAll('.card-tags .tag').length,
      neg: !!c.querySelector('.card-neg'),
      toggle: (c.querySelector('.card-detail-toggle') || {}).textContent || '',
      badge: (c.querySelector('.badge-new') || {}).textContent || '',
      inlineDetail: c.querySelectorAll('.card-body .self-model, .card-body .self-prompt, .card-body .self-raw').length,
    };
  })()`);
  check("已入库图片渲染成法典同款 .card", card.found && card.isCard && card.notSelfCard);
  check("卡片有图窗位 / 标题 / 元数据摘要 / tag 列表 / 负面",
    card.imgWrap && !!card.title && !!card.meta && card.tags > 0 && card.neg,
    `${card.tags} 个 tag · 摘要「${card.meta}」· 徽标「${card.badge}」`);
  check("卡片下方有「查看详情」按钮", card.toggle === "查看详情");
  /* 详情面板的元素（.self-model / .self-prompt / .self-raw）只该出现在弹窗里。
     原来这里查的是 `.card-detail` —— 那个类名在哪个文件里都不存在，
     querySelectorAll 永远返回 0，断言恒真，防不住任何回归。 */
  check("卡片里不再内联展开详情（详情只在弹窗里出现）", card.inlineDetail === 0,
    `卡片体内的详情元素 ${card.inlineDetail} 个`);

  /* ---------- 4. 点大图 = 复制全部提示词 ---------- */
  await cdp.eval(`(() => {
    window.__copied = [];
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get() { return { writeText: async (t) => { window.__copied.push(String(t)); } }; },
    });
    return true;
  })()`);
  /* 点图窗位（探针图在磁盘上不存在，<img> 已经被 onerror 换掉了）——
     事件照样冒泡到 card，行为跟点大图一致 */
  await cdp.eval(`${PROBE}.querySelector('.card-img-wrap').click()`);
  await sleep(250);
  const copiedAll = await cdp.eval(`(() => {
    const t = (window.__copied || []).join('\\n');
    return { n: window.__copied.length, hasPos: t.includes('probe_a'), hasNeg: t.includes('负面:') };
  })()`);
  check("点大图复制了全部提示词（正向+负面）",
    copiedAll.n > 0 && copiedAll.hasPos && copiedAll.hasNeg,
    "收到 " + copiedAll.n + " 次剪贴板写入");

  /* ---------- 5. 点单个 tag 只复制那个 tag ---------- */
  await cdp.eval(`(() => { window.__copied = []; return true; })()`);
  const tagText = await cdp.eval(`(() => {
    const t = ${PROBE}.querySelector('.card-tags .tag');
    const v = t.textContent; t.click(); return v;
  })()`);
  await sleep(200);
  const copiedOne = await cdp.eval(`(window.__copied || []).join('|')`);
  check("点单个 tag 只复制那一个", copiedOne === tagText, `tag=「${tagText}」→ 剪贴板「${copiedOne}」`);

  /* ---------- 6. 点「查看详情」→ 弹出左图右详情的窗口 ---------- */
  await cdp.eval(`${PROBE}.querySelector('.card-detail-toggle').click()`);
  await sleep(1800);   // 留时间给 Civitai 反查
  const detail = await cdp.eval(`(() => {
    const m = document.getElementById('selfDetail');
    const fig = m.querySelector('.detail-figure').getBoundingClientRect();
    const info = m.querySelector('.detail-info').getBoundingClientRect();
    const b = m.querySelector('.detail-box').getBoundingClientRect();
    const d = document.getElementById('selfDetailInfo');
    return {
      open: !m.hidden,
      ratio: +(b.width / b.height).toFixed(2),
      leftIsFigure: fig.left < info.left,
      figureW: Math.round(fig.width),
      infoW: Math.round(info.width),
      /* 探针图在磁盘上不存在，onerror 会把 src 撤掉，所以不去读 src：
         用"图窗位在 + 标题对得上"确认左栏展示的就是这张卡片对应的图 */
      hasFigure: !!m.querySelector('.detail-figure img'),
      detailTitle: (d.querySelector('.detail-title') || {}).textContent || '',
      title: (d.querySelector('.detail-title') || {}).textContent || '',
      source: (d.querySelector('.self-source') || {}).textContent || '',
      models: d.querySelectorAll('.self-model').length,
      links: d.querySelectorAll('.self-model-links .self-link').length,
      linkHref: (d.querySelector('.self-model-links .self-link') || {}).href || '',
      prompts: d.querySelectorAll('.self-prompt').length,
      groupPick: !!d.querySelector('.self-group-pick select'),
      params: !!d.querySelector('.self-params'),
      scrollLocked: document.body.style.overflow === 'hidden',
    };
  })()`);
  check("「查看详情」弹出独立的详情窗口", detail.open && !!detail.title, "标题「" + detail.title + "」");
  check("窗口是长方形，左图右详情", detail.ratio > 1.3 && detail.leftIsFigure,
    `宽高比 ${detail.ratio} · 左 ${detail.figureW}px / 右 ${detail.infoW}px`);
  check("左栏展示的就是这张卡片对应的图", detail.hasFigure && detail.detailTitle === card.title,
    `详情标题「${detail.detailTitle}」/ 卡片标题「${card.title}」`);
  check("右栏渲染出底模 / LoRA 条目", detail.models > 0,
    `${detail.models} 个模型条目（C 站链接数 ${detail.links}）`);
  /* 不断言 detail.links > 0：那些链接来自 Civitai 反查，是外网依赖。
     探针用的是虚构 hash，查不到就只有"没搜到"的提示 —— 断在这里会让
     整个 e2e 长期挂红，反而掩盖真正的回归。链接渲染在真实数据下人工看过。 */
  check("右栏有格式、完整提示词、参数、分组下拉",
    !!detail.source && detail.prompts === 2 && detail.params && detail.groupPick, detail.source);
  check("弹窗打开时背景不滚", detail.scrollLocked);

  /* 关闭方式：✕ / Esc / 点遮罩 */
  const closeKinds = [];
  for (const kind of ["close", "esc", "backdrop"]) {
    await cdp.eval(`${PROBE}.querySelector('.card-detail-toggle').click()`);
    await sleep(250);
    if (kind === "close") await cdp.eval(`document.getElementById('selfDetailClose').click()`);
    if (kind === "esc") await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    if (kind === "backdrop") await cdp.eval(`document.getElementById('selfDetail').click()`);
    await sleep(200);
    const st = await cdp.eval(`({
      hidden: document.getElementById('selfDetail').hidden,
      scroll: document.body.style.overflow,
    })`);
    closeKinds.push({ kind, ...st });
  }
  check("✕ / Esc / 点遮罩都能关掉弹窗并恢复滚动",
    closeKinds.every((k) => k.hidden && k.scroll === ""),
    closeKinds.map((k) => `${k.kind}:${k.hidden && k.scroll === "" ? "ok" : "NO"}`).join(" "));

  /* ---------- 6b. 右栏保存位置建议：只讲通用位置，不许出现本机路径 ---------- */
  const note = await cdp.eval(`(() => {
    const n = document.querySelector('.self-note');
    const t = document.querySelector('.self-tree');
    return { exists: !!n, text: n ? n.textContent : '', tree: t ? t.textContent : '' };
  })()`);
  check("右栏有「推荐保存到 self-image」的说明", note.exists && /self-image/.test(note.text) && /data\//.test(note.tree),
    note.tree.replace(/\s+/g, " ").slice(0, 64));
  const noteBlob = note.text + note.tree;
  const winPath = /[A-Za-z]:[\\/]/;
  const localHints = /dsh工作区|stable-diffusion|ComfyUI-aki|Users\s*\\|AppData/i;
  check("说明里只有通用位置，没有本机绝对路径",
    !winPath.test(noteBlob) && !localHints.test(noteBlob),
    winPath.test(noteBlob) ? "出现了盘符路径：" + (noteBlob.match(/[A-Za-z]:[\\/][^，。\s]*/) || [""])[0] : "无盘符、无用户名");

  const pathBar = await cdp.eval(`document.getElementById('selfPathText').textContent`);
  check("保存位置那一行也不含本机路径", !winPath.test(pathBar) && !localHints.test(pathBar), pathBar.slice(0, 60));

  /* ---------- 6c. 「从图库删除」必须弹自建模态警告 ---------- */
  const clickDelete = `(() => {
    const c = ${PROBE};
    const b = [...c.querySelectorAll('.card-foot button')].find(x => /删除/.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  })()`;

  const confirmFlow = await cdp.eval(`(() => {
    const c = ${PROBE};
    const btns = [...c.querySelectorAll('.card-foot button')].map(b => b.textContent);
    const del = [...c.querySelectorAll('.card-foot button')].find(x => /删除/.test(x.textContent));
    if (!del) return { found: false, btns };
    del.click();
    const m = document.getElementById('selfConfirm');
    return {
      found: true,
      btns,
      btnText: del.textContent,
      modalShown: !m.hidden,
      title: document.getElementById('selfConfirmTitle').textContent,
      body: document.getElementById('selfConfirmBody').textContent,
      okText: document.getElementById('selfConfirmOk').textContent,
      hasDangerBtn: !!m.querySelector('.confirm-actions .danger'),
      bullets: m.querySelectorAll('#selfConfirmBody li').length,
      overDetail: true,
    };
  })()`);
  check("已入库卡片有「从图库删除」按钮", confirmFlow.found, JSON.stringify(confirmFlow.btns || []));
  check("点击后弹出自建模态警告框（不是原生 confirm）",
    confirmFlow.modalShown && confirmFlow.hasDangerBtn, confirmFlow.title);
  check("警告写明原图会被永久删除、不保留",
    /永久删除/.test(confirmFlow.body) && /回收站/.test(confirmFlow.body)
      && /找不回/.test(confirmFlow.body) && confirmFlow.bullets >= 3,
    `li=${confirmFlow.bullets} | ` + confirmFlow.body.replace(/\s+/g, " ").slice(0, 96));
  check("警告正文里也没有本机绝对路径", !winPath.test(confirmFlow.body), "");

  await cdp.eval(`document.getElementById('selfConfirmCancel').click()`);
  await sleep(280);
  const afterCancel = await cdp.eval(`({
    modalHidden: document.getElementById('selfConfirm').hidden,
    cards: document.querySelectorAll('#selfResults .card').length,
    records: (window.SELF_META || []).length,
  })`);
  check("点取消什么都不删", afterCancel.modalHidden && afterCancel.cards === baseline.cards && afterCancel.records === baseline.records,
    `卡片 ${afterCancel.cards} / 记录 ${afterCancel.records}`);

  await cdp.eval(clickDelete);
  await sleep(250);
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(250);
  const afterEsc = await cdp.eval(`({
    modalHidden: document.getElementById('selfConfirm').hidden,
    cards: document.querySelectorAll('#selfResults .card').length,
  })`);
  check("Esc 也能取消确认框", afterEsc.modalHidden && afterEsc.cards === baseline.cards);

  /* 确认删除：沙盒守卫挡住真实落盘，这里验证"确实发起了删除动作、且没删到东西" */
  const opsBefore = await cdp.eval(`(window.__diskOps || []).length`);
  await cdp.eval(clickDelete);
  await sleep(250);
  const okTextBefore = await cdp.eval(`document.getElementById('selfConfirmOk').textContent`);
  await cdp.eval(`document.getElementById('selfConfirmOk').click()`);
  await sleep(1000);
  const afterOk = await cdp.eval(`({
    modalHidden: document.getElementById('selfConfirm').hidden,
    cards: document.querySelectorAll('#selfResults .card').length,
    records: (window.SELF_META || []).length,
    ops: (window.__diskOps || []).length,
  })`);
  check("确认按钮文案是明确的危险操作（不是泛泛的「确定」）", /删除/.test(okTextBefore), okTextBefore);
  check("确认后才真正发起删除，且被沙盒守卫拦下",
    afterOk.modalHidden && afterOk.records === baseline.records && afterOk.ops > opsBefore,
    `记录仍 ${afterOk.records} 条 / 写盘尝试 ${afterOk.ops} 次`);

  /* ---------- 7. 左栏分组：新建 + 过滤 ---------- */
  const groups0 = await cdp.eval(`[...document.querySelectorAll('#selfGroupList .self-group-row .self-group-name')].map(n => n.textContent)`);
  check("左栏有「全部图片 / 未分组」", groups0.includes("全部图片") && groups0.includes("未分组"),
    JSON.stringify(groups0));

  dialogAnswer = "测试分组";
  await cdp.eval(`document.getElementById('selfGroupNew').click()`);
  await sleep(400);
  const groups1 = await cdp.eval(`[...document.querySelectorAll('#selfGroupList .self-group-row .self-group-name')].map(n => n.textContent)`);
  check("新建分组出现在左栏", groups1.includes("测试分组"), JSON.stringify(groups1));

  /* 分组落到记录上：打开详情弹窗，用里面的下拉把它归进去 */
  await cdp.eval(`${PROBE}.querySelector('.card-detail-toggle').click()`);
  await sleep(350);
  await cdp.eval(`(() => {
    const sel = document.querySelector('#selfDetailInfo .self-group-pick select');
    sel.value = '测试分组';
    sel.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(700);
  await cdp.eval(`document.getElementById('selfDetailClose').click()`);
  await sleep(250);
  const afterMove = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#selfGroupList .self-group-row')];
    const row = (name) => rows.find(r => r.querySelector('.self-group-name').textContent === name);
    const c = ${PROBE};
    return {
      groupCount: row('测试分组') ? row('测试分组').querySelector('.self-group-count').textContent : null,
      ungrouped: row('未分组') ? row('未分组').querySelector('.self-group-count').textContent : null,
      badge: (c.querySelectorAll('.badge-new')[1] || {}).textContent || '',
      path: (c.querySelector('.card-path') || {}).textContent || '',
    };
  })()`);
  check("归入分组后计数与徽标同步", afterMove.groupCount === "1" && afterMove.badge === "测试分组",
    `测试分组=${afterMove.groupCount} / 未分组=${afterMove.ungrouped} / 徽标=${afterMove.badge}`);

  /* 切到空分组应显示空态。
     不能用「未分组」—— 用户自己的图可能就在那儿。新建一个专用空分组，
     它的空是确定的，不依赖图库里有什么。 */
  dialogAnswer = "__empty_probe__";
  await cdp.eval(`document.getElementById('selfGroupNew').click()`);
  await sleep(350);
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#selfGroupList .self-group-row')];
    const r = rows.find(x => x.querySelector('.self-group-name').textContent === '__empty_probe__');
    if (r) r.click();
    return true;
  })()`);
  await sleep(400);
  const emptyState = await cdp.eval(`(() => ({
    cards: document.querySelectorAll('#selfResults .card').length,
    emptyShown: !document.getElementById('selfEmpty').hidden,
    status: document.getElementById('selfStatus').textContent.slice(0, 40),
  }))()`);
  check("切到空分组显示空态、不出卡片", emptyState.cards === 0 && emptyState.emptyShown, emptyState.status);

  /* 切回全部，卡片回来 */
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#selfGroupList .self-group-row')];
    rows.find(x => x.querySelector('.self-group-name').textContent === '全部图片').click();
    return true;
  })()`);
  await sleep(400);
  const back = await cdp.eval(`document.querySelectorAll('#selfResults .card').length`);
  check("切回「全部图片」卡片恢复", back >= 1, back + " 张");

  /* ---------- 7b. 独立打开时不该有「加入已选栏」（那是插件小窗专属） ---------- */
  const standalone = await cdp.eval(`(() => {
    /* 用单独的名字，别跟 2b 那个主探针撞 —— 否则清理时会把主探针一起删掉 */
    window.SELF_META.push({
      file: '__probe_standalone__.png', title: '探针图B', addedAt: Math.floor(Date.now() / 1000),
      meta: { format: 'png', source: 'a1111', positive: 'probe_a', negative: 'probe_neg',
              checkpoint: null, loras: [], params: {}, raw: {}, warnings: [] },
    });
    const rows = [...document.querySelectorAll('#selfGroupList .self-group-row')];
    const all = rows.find(r => r.querySelector('.self-group-name').textContent === '全部图片');
    if (all) all.click();
    window.SelfGallery.renderAll();
    const card = [...document.querySelectorAll('#selfResults .card')]
      .find(c => { const t = c.querySelector('.card-title'); return t && t.textContent === '探针图B'; });
    const btns = card ? [...card.querySelectorAll('.card-actions button')].map(b => b.textContent) : [];
    window.SELF_META = window.SELF_META.filter(r => r.file !== '__probe_standalone__.png');
    window.SelfGallery.renderAll();
    return { found: !!card, btns };
  })()`);
  check("独立打开站点时，图库卡片上没有「加入已选栏」",
    standalone.found && !standalone.btns.some(t => /已选栏/.test(t)),
    JSON.stringify(standalone.btns));

  /* ---------- 8. 上传 → 立刻弹审阅窗，必须先决定 ---------- */
  if (!SAMPLE) {
    console.log("SKIP  上传链路验证 —— self-image/ 与 images/ 里都没有可当样本的图");
  } else {
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#selfGroupList .self-group-row')];
    rows.find(x => x.querySelector('.self-group-name').textContent === '测试分组').click();
    return true;
  })()`);
  await sleep(350);

  const cardsBefore = await cdp.eval(`document.querySelectorAll('#selfResults .card').length`);
  const filesBefore = await cdp.eval(`(window.SELF_META || []).length`);

  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  const q = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#selfFile" });
  await cdp.send("DOM.setFileInputFiles", { files: [SAMPLE], nodeId: q.nodeId });
  await sleep(1800);

  const up = await cdp.eval(`(() => {
    const m = document.getElementById('selfDetail');
    const review = document.getElementById('selfDetailReview');
    const info = document.getElementById('selfDetailInfo');
    return {
      modalOpen: !m.hidden,
      reviewShown: !!review && !review.hidden,
      question: (document.getElementById('selfReviewQuestion') || {}).textContent || '',
      saveText: (document.getElementById('selfReviewSave') || {}).textContent || '',
      skipText: (document.getElementById('selfReviewSkip') || {}).textContent || '',
      closeHidden: !!document.getElementById('selfDetailClose').hidden,
      prompts: info.querySelectorAll('.self-prompt').length,
      models: info.querySelectorAll('.self-model').length,
      warns: info.querySelectorAll('.self-warn').length,
      hasTitle: !!(info.querySelector('.detail-title') || {}).textContent,
      gridCards: document.querySelectorAll('#selfResults .card').length,
      records: (window.SELF_META || []).length,
    };
  })()`);
  check("上传后立刻弹出审阅窗口（不再往网格里塞待保存卡片）",
    up.modalOpen && up.reviewShown && up.gridCards === cardsBefore,
    `网格 ${up.gridCards} 张（上传前 ${cardsBefore} 张）`);
  check("审阅条上明着问「要不要存」", /存进图库|保存/.test(up.question), up.question);
  check("两个决定按钮都在", up.saveText === "保存到图库" && up.skipText === "不保存",
    `[${up.saveText}] [${up.skipText}]`);
  /* 样本是从词库里挑的，那张图不一定带生成参数 —— 所以这里接受两种情况：
     解析出了提示词，或者明确告诉你"图里没有内嵌参数"。两者都算渲染正常。 */
  check("审阅窗渲染出详情（有提示词，或明确提示图里没有参数）",
    up.hasTitle && (up.prompts >= 1 || up.warns >= 1),
    up.prompts >= 1 ? `${up.prompts} 段提示词 / ${up.models} 个模型条目` : `${up.warns} 条提示`);
  check("★ 还没点保存，一张都没落盘", up.records === filesBefore, `记录数 ${filesBefore} → ${up.records}`);

  /* 必须决定：✕ / Esc / 点遮罩都不该把它关掉 */
  const closeAttempts = await cdp.eval(`(() => {
    const m = document.getElementById('selfDetail');
    document.getElementById('selfDetailClose').click();
    m.click();                                   // 点遮罩
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    m.querySelector('.detail-box').click();      // 点弹窗内部空白
    return !m.hidden;
  })()`);
  check("★ 不决定就关不掉（✕ / Esc / 遮罩都拦下）", closeAttempts,
    closeAttempts ? "弹窗仍在" : "被关掉了！");

  const shotReview = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(SHOT_REVIEW, Buffer.from(shotReview.data, "base64"));
  console.log("截图：" + SHOT_REVIEW);

  /* 审阅窗里也能先选分组 */
  const pendGroup = await cdp.eval(`(() => {
    const sel = document.querySelector('#selfDetailInfo .self-group-pick select');
    return sel ? { ok: true, value: sel.value, options: [...sel.options].map(o => o.value) } : { ok: false };
  })()`);
  check("审阅窗里能选分组，且默认跟随当前分组", pendGroup.ok && pendGroup.value === "测试分组",
    JSON.stringify(pendGroup.options));

  /* 反面证据：file:// 下没有后端，保存只能走"让你自己选文件夹"那条路。
     沙盒守卫会拦住它（不会真落盘），这里验证的正是"它确实走了那条路" ——
     这就是为什么要用「启动法典.bat」打开。 */
  const opsBeforeSave = await cdp.eval(`(window.__diskOps || []).length`);
  await cdp.eval(`document.getElementById('selfReviewSave').click()`);
  await sleep(1200);
  const fileMode = await cdp.eval(`({
    ops: (window.__diskOps || []).length,
    stillOpen: !document.getElementById('selfDetail').hidden,
    records: (window.SELF_META || []).length,
  })`);
  check("file:// 下保存确实要走「选文件夹」（bat 启动要解决的就是这个）",
    fileMode.ops > opsBeforeSave && fileMode.stillOpen && fileMode.records === filesBefore,
    `写盘尝试 ${fileMode.ops} 次 / 弹窗留着等重试 / 记录数仍是 ${fileMode.records}`);

  /* 改成「不保存」→ 干净退出，队列里没有下一张就收工 */
  await cdp.eval(`document.getElementById('selfReviewSkip').click()`);
  await sleep(500);
  const afterSkip = await cdp.eval(`({
    modalHidden: document.getElementById('selfDetail').hidden,
    reviewHidden: document.getElementById('selfDetailReview').hidden,
    total: document.querySelectorAll('#selfResults .card').length,
    records: (window.SELF_META || []).length,
  })`);
  check("点「不保存」干净退出，什么都没写",
    afterSkip.modalHidden && afterSkip.reviewHidden && afterSkip.records === filesBefore,
    `记录数仍是 ${afterSkip.records}`);
  check("网格里只有已入库的卡片", afterSkip.total === cardsBefore, `${afterSkip.total} 张`);

  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#selfGroupList .self-group-row')];
    rows.find(x => x.querySelector('.self-group-name').textContent === '全部图片').click();
    return true;
  })()`);
  await sleep(300);
  }

  /* ---------- 9. 截图：图库全貌 + 详情弹窗 + 删除确认 ---------- */
  const shot1 = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(SHOT, Buffer.from(shot1.data, "base64"));
  console.log("截图：" + SHOT);

  /* 截图只是副产品，图库为空时不该把整个验证拖崩 —— 有卡片才拍 */
  const hasCard = await cdp.eval(`!!${PROBE}.querySelector('.card-detail-toggle')`);
  if (!hasCard) {
    console.log("SKIP  详情弹窗 / 删除确认截图 —— 图库里没有卡片");
  } else {
    await cdp.eval(`${PROBE}.querySelector('.card-detail-toggle').click()`);
    await sleep(1600);
    const shot2 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(SHOT_DETAIL, Buffer.from(shot2.data, "base64"));
    console.log("截图：" + SHOT_DETAIL);
    await cdp.eval(`document.getElementById('selfDetailClose').click()`);
    await sleep(200);

    await cdp.eval(`(() => {
      const c = ${PROBE};
      [...c.querySelectorAll('.card-foot button')].find(b => /删除/.test(b.textContent)).click();
      return true;
    })()`);
    await sleep(420);
    const shot3 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(SHOT_CONFIRM, Buffer.from(shot3.data, "base64"));
    console.log("截图：" + SHOT_CONFIRM);
    await cdp.eval(`document.getElementById('selfConfirmCancel').click()`);
    await sleep(200);
  }

  /* ---------- 10. 控制台干净 + 没碰过真实文件 ---------- */
  const diskOps = await cdp.eval(`window.__diskOps || []`);
  const realWrites = diskOps.filter((op) => !op.includes("showDirectoryPicker"));
  check("全程没有真正落盘（只允许被拦的目录选择）", realWrites.length === 0,
    diskOps.length ? diskOps.join(" / ") : "没有任何写盘尝试");

  const ignorable = consoleErrors.filter((e) => !/by-hash|404|Failed to load resource/i.test(e));
  check("无页面异常", ignorable.length === 0, ignorable.slice(0, 2).join(" | ") || "干净");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { console.log("失败项：" + failed.map((f) => f.name).join(" / ")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error("验证脚本出错：" + e.message); process.exitCode = 2; })
  .finally(() => { try { chrome.kill(); } catch (e) {} });
