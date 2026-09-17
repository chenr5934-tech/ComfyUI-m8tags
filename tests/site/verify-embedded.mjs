/* 模拟「ComfyUI 插件小窗」场景验证。

 * 插件的图库小窗本质是一个 iframe 嵌站点（js/codex_atlas.js 里的
 * .codex-atlas-frame，右侧还占着 334px 的已选栏）。这个脚本按同样的尺寸
 * 造一个 iframe，在里面跑完整的上传 → 审阅 → 决定流程，确认新流程在
 * 小窗里照常工作、窄的时候布局会让开。
 *
 *   node tools/verify-embedded.mjs http://127.0.0.1:8788/index.html
 *
 * 只测到"决定"为止，不会写盘。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;
const PORT = 9366;
const SIDE_PANEL = 334;          // 插件小窗右侧已选栏的宽度

const target = process.argv[2];
if (!target) {
  console.error("用法：node tools/verify-embedded.mjs http://127.0.0.1:<端口>/index.html");
  process.exit(2);
}
const origin = new URL(target).origin;

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
  return "chrome.exe";
}

const profile = mkdtempSync(join(tmpdir(), "cdp-embedded-"));
const chrome = spawn(findChrome(), [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--window-size=1680,1100", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageWs() {
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

const ws = new WebSocket(await pageWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve: r } = pending.get(m.id);
    pending.delete(m.id);
    r(m.result);
  } else if (m.method) events.push(m);
};
const send = (method, params = {}) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, { resolve: r }));
};
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error("页面异常：" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: target });

  let loaded = false;
  for (let i = 0; i < 60 && !loaded; i++) {
    if (events.some((e) => e.method === "Page.loadEventFired")) loaded = true;
    else await sleep(200);
  }
  await sleep(1200);

  /* ---------- 1. 按插件小窗的尺寸造一个 iframe ---------- */
  await ev(`(() => {
    const f = document.createElement('iframe');
    f.id = 'fakePluginFrame';
    f.style.cssText = 'position:fixed;left:0;top:0;border:0;height:90vh;' +
                      'width:calc(100vw - ${SIDE_PANEL}px);';
    f.src = 'index.html';
    document.body.appendChild(f);
    return true;
  })()`);
  await sleep(1600);

  const frameInfo = await ev(`(() => {
    const f = document.getElementById('fakePluginFrame');
    return { w: Math.round(f.getBoundingClientRect().width), loaded: !!f.contentWindow.SelfGallery };
  })()`);
  check("iframe 里的站点加载成功（模拟插件小窗宽度）",
    frameInfo.loaded && frameInfo.w > 600, `iframe 宽 ${frameInfo.w}px`);

  /* ---------- 2. iframe 里切到我的图库 ---------- */
  await ev(`document.getElementById('fakePluginFrame').contentWindow.document.getElementById('selfBtn').click()`);
  await sleep(700);
  const viewState = await ev(`(() => {
    const d = document.getElementById('fakePluginFrame').contentWindow.document;
    const r = (sel) => { const n = d.querySelector(sel); return n ? n.getBoundingClientRect() : null; };
    const g = r('.self-groups'), m = r('.self-main'), u = r('.self-upload'), drop = r('#selfDrop');
    return {
      selfVisible: !d.getElementById('selfView').hidden,
      threeCols: !!g && !!m && !!u,
      order: g && m && u ? (g.left < m.left && m.left < u.left) : false,
      uploadTop: drop ? Math.round(drop.top) : null,
      pathText: d.getElementById('selfPathText').textContent,
    };
  })()`);
  check("小窗里「我的图库」正常打开", viewState.selfVisible && viewState.threeCols);
  check("小窗里右栏写着不用选文件夹", /直接写入/.test(viewState.pathText), viewState.pathText);

  /* ---------- 3. 在 iframe 里喂一张图，看审阅窗 ----------
     样本从**词库配图**取，不依赖图库里有没有东西 —— 图库可以是空的。
     文件名加前缀，避免和用户已有的图撞名（这一步不保存，只是喂进去看界面）。 */
  const fed = await ev(`(async () => {
    const f = document.getElementById('fakePluginFrame');
    const w = f.contentWindow;
    const cardImg = document.querySelector('#results .card-img');
    if (!cardImg) return { ok: false, why: '词库卡片还没渲染出来' };
    const src = cardImg.getAttribute('src');
    const name = decodeURIComponent(src.split('/').pop().split('?')[0]);
    const blob = await (await fetch(src)).blob();
    const file = new w.File([blob], '__embed_probe__' + name, { type: 'image/jpeg' });
    w.SelfGallery.handleFiles([file]);
    return { ok: true, name: file.name, bytes: blob.size };
  })()`);
  await sleep(2400);
  check("iframe 里能喂进图片", fed.ok, fed.ok ? `${fed.name}（${fed.bytes} 字节）` : fed.why);

  const review = await ev(`(() => {
    const f = document.getElementById('fakePluginFrame');
    const d = f.contentWindow.document;
    const m = d.getElementById('selfDetail');
    const rv = d.getElementById('selfDetailReview');
    const box = m.querySelector('.detail-box').getBoundingClientRect();
    const fig = m.querySelector('.detail-figure').getBoundingClientRect();
    const info = m.querySelector('.detail-info').getBoundingClientRect();
    return {
      open: !m.hidden,
      reviewShown: !!rv && !rv.hidden,
      boxW: Math.round(box.width),
      boxH: Math.round(box.height),
      stacked: fig.top < info.top && Math.abs(fig.left - info.left) < 2,   // 窄屏时改成了上下排
      sideBySide: fig.left < info.left,
      closeHidden: !!d.getElementById('selfDetailClose').hidden,
      question: (d.getElementById('selfReviewQuestion') || {}).textContent || '',
      btns: [...d.querySelectorAll('.detail-review-actions button')].map(b => b.textContent),
      saveVisible: (() => {
        const b = d.getElementById('selfReviewSave');
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom <= box.bottom + 1;
      })(),
      clipsOutside: box.right > f.contentWindow.innerWidth + 1,
    };
  })()`);
  check("审阅窗在 iframe 里弹出", review.open && review.reviewShown);
  check("审阅窗没被挤出 iframe（宽度自适应）",
    !review.clipsOutside && review.boxW <= 1400,
    `窗口 ${review.boxW}×${review.boxH}px`);
  check("布局按 iframe 宽度自适应（窄了就上下排）",
    review.sideBySide || review.stacked,
    review.stacked ? "上下排（窄）" : "左右排（宽）");
  check("两个决定按钮都在可视区内并可见",
    review.btns.join(",") === "保存到图库,不保存" && review.saveVisible,
    review.btns.join(" / "));
  check("审阅中 ✕ 仍然隐藏（必须先决定）", review.closeHidden);

  /* ---------- 4. 决定「不保存」，干净退出 ---------- */
  const beforeRec = await ev(`document.getElementById('fakePluginFrame').contentWindow.SELF_META.length`);
  await ev(`document.getElementById('fakePluginFrame').contentWindow.document.getElementById('selfReviewSkip').click()`);
  await sleep(700);
  const after = await ev(`(() => {
    const w = document.getElementById('fakePluginFrame').contentWindow;
    return {
      modalHidden: w.document.getElementById('selfDetail').hidden,
      records: w.SELF_META.length,
    };
  })()`);
  check("点「不保存」退出，且没有写入",
    after.modalHidden && after.records === beforeRec,
    `记录数 ${beforeRec} → ${after.records}`);

  /* ---------- 5. 图库卡片上的「＋ 加入已选栏」（插件小窗专属） ----------
     图库可能是空的，往内存里塞一条探针记录 —— 只影响渲染，不碰磁盘。 */
  await ev(`(() => {
    const w = document.getElementById('fakePluginFrame').contentWindow;
    w.SELF_META.push({
      file: '__probe__.png',
      title: '探针图',
      addedAt: Math.floor(Date.now() / 1000),
      meta: {
        format: 'png', source: 'a1111',
        positive: 'probe_a, probe_b', negative: 'probe_neg',
        checkpoint: null, loras: [], params: {}, raw: {}, warnings: [],
      },
    });
    /* 探针没有分组，得切到「全部图片」才看得见 */
    const rows = [...w.document.querySelectorAll('#selfGroupList .self-group-row')];
    const all = rows.find(r => r.querySelector('.self-group-name').textContent === '全部图片');
    if (all) all.click();
    w.SelfGallery.renderAll();
    window.__picks = [];
    window.addEventListener('message', (e) => { window.__picks.push(e.data); });
    return true;
  })()`);
  await sleep(700);

  const pickBtn = await ev(`(() => {
    const w = document.getElementById('fakePluginFrame').contentWindow;
    const cards = [...w.document.querySelectorAll('#selfResults .card')];
    const card = cards.find(c => {
      const t = c.querySelector('.card-title');
      return t && t.textContent === '探针图';
    });
    if (!card) return { found: false, cards: cards.length };
    const btns = [...card.querySelectorAll('.card-actions button')];
    const btn = btns.find(b => /加入已选栏/.test(b.textContent));
    if (!btn) return { found: true, btn: false, btns: btns.map(b => b.textContent) };
    btn.click();
    return { found: true, btn: true, btns: btns.map(b => b.textContent) };
  })()`);
  check("图库被内嵌到插件小窗时，卡片上有「＋ 加入已选栏」",
    pickBtn.found && pickBtn.btn,
    pickBtn.found ? JSON.stringify(pickBtn.btns || []) : `没找到探针卡片（共 ${pickBtn.cards} 张）`);

  await sleep(450);
  const pick = await ev(`(window.__picks || []).filter(p => p && p.type === 'pick').pop() || null`);
  check("★ 宿主收到的消息标了 kind=self（告诉它内容自带）",
    !!pick && pick.kind === 'self' && pick.codex === 'self-image',
    pick ? `kind=${pick.kind} codex=${pick.codex} id=${pick.id}` : "没收到消息");
  check("★ 正负提示词随消息一起过来（宿主不必也无法再去后端查）",
    !!pick && pick.tags === 'probe_a, probe_b' && pick.negative === 'probe_neg',
    pick ? `tags=「${pick.tags}」 negative=「${pick.negative}」` : "");

  /* 探针用完就撤，别留在内存里 */
  await ev(`(() => {
    const w = document.getElementById('fakePluginFrame').contentWindow;
    w.SELF_META = w.SELF_META.filter(r => r.file !== '__probe__.png');
    w.SelfGallery.renderAll();
    return true;
  })()`);

  /* ---------- 6. 站点仍是可独立打开的（不依赖宿主） ---------- */
  const standalone = await ev(`(() => ({
    hasSelfGallery: typeof window.SelfGallery === 'object',
    hasCard: document.querySelectorAll('#results .card').length > 0,
  }))()`);
  check("宿主页面自身不受影响", standalone.hasSelfGallery && standalone.hasCard);

  /* ---------- 7. 模拟插件头部的「我的图库」按钮 ----------
     插件那个按钮做的就是"同源直接调 iframe 里的 showSelf()"。这里验证它
     确实能把视图切过去、切回来，而且切过去之后图库的完整功能都在。 */
  const toLib = await ev(`(() => {
    const w = document.getElementById('fakePluginFrame').contentWindow;
    if (!w.SelfGallery) return { ok: false };
    w.SelfGallery.showSelf(true);
    const view = w.document.getElementById('selfView');
    const r = (sel) => { const n = w.document.querySelector(sel); return n ? n.getBoundingClientRect() : null; };
    const g = r('.self-groups'), m = r('.self-main'), u = r('.self-upload');
    return {
      ok: true,
      inLib: !view.hidden,
      layoutHidden: w.document.querySelector('.layout').hidden,
      sideBtnText: w.document.getElementById('selfBtn').textContent,
      threeCols: !!g && !!m && !!u,
      dropZone: !!r('#selfDrop'),
      groupList: !!r('#selfGroupList'),
    };
  })()`);
  check("★ 从宿主切进图库（插件头部那个按钮做的事）",
    toLib.ok && toLib.inLib && toLib.layoutHidden && toLib.threeCols,
    toLib.ok ? `站点按钮文案变成「${toLib.sideBtnText}」` : "showSelf 不可用");
  check("切进去之后图库功能齐全（分组栏 / 上传区都在）",
    toLib.groupList && toLib.dropZone);

  const backToCodex = await ev(`(() => {
    const w = document.getElementById('fakePluginFrame').contentWindow;
    w.SelfGallery.showSelf(false);
    const view = w.document.getElementById('selfView');
    return { inLib: !view.hidden, layoutHidden: w.document.querySelector('.layout').hidden };
  })()`);
  check("★ 能干净地切回法典检索",
    !backToCodex.inLib && !backToCodex.layoutHidden);

  const ignorable = events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
    .filter((t) => !/by-hash|404|Failed to load resource/i.test(t));
  check("无页面异常", ignorable.length === 0, ignorable.slice(0, 2).join(" | ") || "干净");
} catch (e) {
  console.error("验证出错：" + e.message);
  process.exitCode = 2;
} finally {
  const failed = results.filter((r) => !r.ok);
  if (results.length) {
    console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  }
  if (failed.length) process.exitCode = 1;
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
}
