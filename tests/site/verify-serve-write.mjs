/* 「serve.py 本地服务」的真实写盘验证：确认从 bat/http 打开时，
 * 上传的图真的落进 self-image/，并且用完后自己清理干净。
 *
 *   node tools/verify-serve-write.mjs http://127.0.0.1:8788/index.html
 *
 * 和 e2e-self-gallery.mjs 不同，这个脚本**故意**允许写盘 —— 它要验证的
 * 就是"不用选文件夹也能存图"。所以它只碰自己新建的那一张，收尾必删。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;
/* 站点源码已经并进插件的 atlas/，所以站点根是 HERE/../../atlas */
const SITE_DIR = resolve(HERE, "..", "..", "atlas");
const SELF_DIR = join(SITE_DIR, "self-image");
const INDEX_JS = join(SELF_DIR, "index.js");
const PORT = 9355;

const target = process.argv[2];
if (!target) {
  console.error("用法：node tools/verify-serve-write.mjs http://127.0.0.1:<端口>/index.html");
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

/* 拿一张词库里的图当上传样本。
 *
 * **必须避开图库里已有的同名文件**：上传接口是"同名就覆盖"，而收尾又要真删
 * 那个名字。撞上的话就会先把用户自己那张覆盖掉、再删掉，永久丢失
 * （unlink 不进回收站）。宁可换一张样本，也不冒这个险。 */
function pickSample() {
  const imagesRoot = join(SITE_DIR, "images");
  let existing;
  try { existing = new Set(readdirSync(SELF_DIR)); } catch (e) { existing = new Set(); }
  try {
    for (const codex of readdirSync(imagesRoot)) {
      for (const f of readdirSync(join(imagesRoot, codex))) {
        if (!/\.(png|jpe?g)$/i.test(f)) continue;
        if (existing.has(f)) continue;
        return join(imagesRoot, codex, f);
      }
    }
  } catch (e) { /* 没有就算了 */ }
  return null;
}

const SAMPLE = pickSample();
const profile = mkdtempSync(join(tmpdir(), "cdp-serve-"));
const chrome = spawn(findChrome(), [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--window-size=1680,1200", "about:blank",
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
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面异常：" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function indexCount() {
  try {
    const s = readFileSync(INDEX_JS, "utf8");
    const at = s.indexOf("window.SELF_META");
    if (at < 0) return 0;
    const open = s.indexOf("[", at);
    const close = s.lastIndexOf("]");
    if (open < 0 || close <= open) return 0;
    return JSON.parse(s.slice(open, close + 1)).length;
  } catch (e) {
    return -1;
  }
}

let created = null;
/* 这两个要在 try 之外声明：finally 里要用它们还原被测试弄脏的文件，
   而在 try 块里用 let 声明的话 finally 根本看不到（块作用域）。 */
let bakBackup = null;
let logLines = 0;

try {
  if (!SAMPLE) throw new Error("images/ 里找不到可当上传样本的图");

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: target });

  let loaded = false;
  for (let i = 0; i < 60 && !loaded; i++) {
    if (events.some((e) => e.method === "Page.loadEventFired")) loaded = true;
    else await sleep(200);
  }
  await sleep(1200);

  const before = indexCount();
  if (before < 0) {
    /* 索引读不出来时 after 也会是 -1，于是 "+1" 和 "回到原样" 两条断言
       会以 -1 的方式双双"成立" —— 最严重的状态被当成成功放过。 */
    check("能读出图库索引", false, "索引本身读不出来，本次验证无效");
    throw new Error("索引读不出来，中止验证");
  }
  const beforeExists = SAMPLE
    ? existsSync(join(SELF_DIR, SAMPLE.split(/[\\/]/).pop()))
    : false;

  /* 这个脚本会真的写盘，副作用不止"多了一张图"：
     写索引前留的 index.js.bak 会被含测试图的中间态覆盖，
     删图还会往 delete-log.txt 追加一行。用户的回滚备份和审计流水
     不该被测试弄脏 —— 先把它们记下来，收尾还原。 */
  try { bakBackup = readFileSync(join(SELF_DIR, "index.js.bak"), "utf8"); } catch (e) { /* 没有就算了 */ }
  try {
    logLines = readFileSync(join(SELF_DIR, "delete-log.txt"), "utf8").split("\n").filter(Boolean).length;
  } catch (e) { /* 没有就算了 */ }

  /* ---------- 1. 后端认出来了 ---------- */
  const status = await ev(`fetch('/codex_atlas/status', {cache:'no-store'}).then(r => r.json())`);
  check("本地服务的 /codex_atlas/status 可用",
    status && status.ok && (status.features || []).includes("self-image"),
    "mode=" + (status && status.mode));

  await ev(`document.getElementById('selfBtn').click()`);
  await sleep(600);

  /* 哨兵：装一个会记账、且立刻抛错的 showDirectoryPicker。
     只要"保存到图库"真的需要用户选文件夹，就一定会走到它，计数不为 0、
     保存也会当场失败。整条链路跑完计数是 0，才算证明了"不用选文件夹"。 */
  await ev(`(() => {
    window.__pickerCalls = 0;
    window.showDirectoryPicker = async () => {
      window.__pickerCalls++;
      throw new DOMException('不该被调用：这说明还需要用户选文件夹', 'AbortError');
    };
    return true;
  })()`);

  const pathText = await ev(`document.getElementById('selfPathText').textContent`);
  check("右栏显示「本地服务直接写入、不用选文件夹」",
    /本地服务直接写入/.test(pathText) && /不用选文件夹/.test(pathText), pathText);

  /* ---------- 2. 上传一张词库图 ---------- */
  const doc = await send("DOM.getDocument", { depth: -1 });
  const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#selfFile" });
  await send("DOM.setFileInputFiles", { files: [SAMPLE], nodeId: q.nodeId });
  await sleep(1600);

  const reviewInfo = await ev(`(() => {
    const m = document.getElementById('selfDetail');
    const rv = document.getElementById('selfDetailReview');
    return {
      modalOpen: !m.hidden,
      reviewShown: !!rv && !rv.hidden,
      question: (document.getElementById('selfReviewQuestion') || {}).textContent || '',
      buttons: [...document.querySelectorAll('.detail-review-actions button')].map(b => b.textContent),
      records: (window.SELF_META || []).length,
    };
  })()`);
  check("上传后弹出审阅窗，必须先决定存不存",
    reviewInfo.modalOpen && reviewInfo.reviewShown && reviewInfo.buttons.length === 2,
    reviewInfo.question + " → " + reviewInfo.buttons.join(" / "));
  check("★ 还没点保存，记录数没变", reviewInfo.records === before, `记录数 ${before}`);

  /* ---------- 3. 点「保存到图库」—— 这一步才真写盘 ---------- */
  await ev(`document.getElementById('selfReviewSave').click()`);
  await sleep(2200);

  const after = indexCount();
  const sampleName = SAMPLE.split(/[\\/]/).pop();
  const landed = existsSync(join(SELF_DIR, sampleName));
  /* 只有"跑之前不存在、跑完才出现"的才算我们建的，才允许收尾删掉。
     样本选取已经避开撞名，这里是第二道保险。 */
  created = (landed && !beforeExists) ? sampleName : null;

  check("图真的写进了 self-image/（没让你选文件夹）", landed, sampleName);
  check("索引记录数 +1", after === before + 1, `${before} → ${after}`);

  const pickerCalls = await ev(`window.__pickerCalls`);
  check("保存全程没有调用过「选文件夹」（showDirectoryPicker）",
    pickerCalls === 0, pickerCalls === 0 ? "调用 0 次" : `调用了 ${pickerCalls} 次！`);

  const stillOpen = await ev(`!document.getElementById('selfDetail').hidden`);
  check("保存后审阅窗自动关闭", !stillOpen, stillOpen ? "还开着" : "已关");

  const shown = await ev(`(() => {
    const c = [...document.querySelectorAll('#selfResults .card')].find(x => x.querySelector('.card-path') && x.querySelector('.card-path').textContent.includes(${JSON.stringify(sampleName)}));
    return c ? { badge: (c.querySelector('.badge-new') || {}).textContent, img: !!c.querySelector('.card-img') } : null;
  })()`);
  check("新卡片出现在网格里并带「已入库」徽标", !!shown && !!shown.img, shown ? shown.badge : "没找到");

  /* ---------- 4. 清理：删掉刚才那张，索引回到原样 ---------- */
  const delRes = await ev(`fetch('/codex_atlas/self-image/delete', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ file: ${JSON.stringify(sampleName)} })
  }).then(r => r.json())`);
  check("清理接口把这张删掉了", delRes && delRes.ok && delRes.removed, JSON.stringify(delRes));
  created = null;

  const final = indexCount();
  check("索引恢复到测试前的条数", final === before, `${before} → ${final}`);
  check("self-image/ 里没有残留测试文件", !existsSync(join(SELF_DIR, sampleName)));

  const ignorable = events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
    .filter((t) => !/by-hash|404|Failed to load resource/i.test(t));
  check("无页面异常", ignorable.length === 0, ignorable.slice(0, 2).join(" | ") || "干净");
} catch (e) {
  console.error("验证出错：" + e.message);
  process.exitCode = 2;
} finally {
  /* 万一中途炸了，也要把可能落下的那张清掉 */
  if (created) {
    try {
      await fetch(`${origin}/codex_atlas/self-image/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: created }),
      });
      console.log("已补清理：" + created);
    } catch (e) { /* 尽力而为 */ }
  }

  /* 还原被这次验证弄脏的两样东西：回滚备份和删除流水。
     写索引前留的 .bak 会被含测试图的中间态覆盖；删图会往流水末尾追加一行。
     两个都是给"出事时回看"用的，不该混进测试的痕迹。 */
  if (bakBackup !== null) {
    try {
      writeFileSync(join(SELF_DIR, "index.js.bak"), bakBackup, "utf8");
      console.log("已还原 index.js.bak");
    } catch (e) { /* 尽力而为 */ }
  }
  if (logLines > 0) {
    try {
      const cur = readFileSync(join(SELF_DIR, "delete-log.txt"), "utf8").split("\n");
      const kept = cur.slice(0, logLines);
      writeFileSync(join(SELF_DIR, "delete-log.txt"),
        kept.join("\n") + (kept[kept.length - 1] === "" ? "" : "\n"), "utf8");
      console.log("已清掉本次追加的删除流水");
    } catch (e) { /* 尽力而为 */ }
  }

  const failed = results.filter((r) => !r.ok);
  if (results.length) {
    console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  }
  if (failed.length) process.exitCode = 1;
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
}
