/* 窗口本体能不能开、iframe 是不是真的加载了线上站点、图库切换通不通。
 *
 * 前面几层都验过了（后端接口、节点逻辑、图库独立页），但"窗口"这个交付物本身
 * 一直没在真浏览器里开过 —— 它引用的东西最多（样式、DOM、跨域 iframe），
 * 靠读代码看不出"其实某个按钮根本没挂上"。
 *
 * 这里起一个假后端：伺服 index、假的 /scripts/app.js（ComfyUI 的模块入口）、
 * 真的 codex_atlas.js 和真的 atlas/ 目录。然后真开一次窗口。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME
  || "C:\\Users\\Cr\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe";
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = process.argv[2] || join(HERE, "..");
const PORT = Number(process.env.PROBE_PORT || 9228);
const SITE_PORT = 8897;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const INDEX = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>harness</title></head><body>
<script>
window.__fakeApp = {
  graph: { _nodes: [], setDirtyCanvas(){}, },
  ui: { settings: { getSettingValue: () => false, addSetting(){} } },
  registerExtension() {},
};
</script>
<script type="module" src="/js/codex_atlas.js"></script>
</body></html>`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "verify-win-"));

const srv = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(INDEX);
    }
    if (path === "/scripts/app.js") {
      res.writeHead(200, { "Content-Type": MIME[".js"] });
      return res.end("export const app = window.__fakeApp;\n");
    }
    let file;
    if (path.startsWith("/js/")) file = join(PKG, normalize(path));
    else if (path.startsWith("/codex_atlas/atlas/")) file = join(PKG, "atlas", normalize(path.replace("/codex_atlas/atlas/", "")));
    else { res.writeHead(404); return res.end("nope"); }
    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found: " + path);
  }
});
await new Promise(r => srv.listen(SITE_PORT, "127.0.0.1", r));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

let ws, nextId = 1, pass = 0, fail = 0;
const pending = new Map();
const errors = [];

const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + " 超时")); } }, 25000);
  });
};

function ok(cond, label, extra) {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; console.log("FAIL  " + label + (extra ? "   — " + extra : "")); }
}

try {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  if (!wsUrl) throw new Error("Chrome 没起来");

  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(String(m.params.exceptionDetails?.exception?.description || "").slice(0, 240));
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url: `http://127.0.0.1:${SITE_PORT}/` });
  await sleep(2500);

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return "异常: " + String(r.exceptionDetails.exception?.description || "").slice(0, 200);
    return r.result?.value;
  };

  ok(await ev("typeof window.__codexAtlas === 'object'"), "模块加载完成（没在顶层抛错）");

  /* 真开一次窗口 */
  const opened = await ev("(() => { try { window.__codexAtlas.openAtlasWindow({}); return 'ok'; } catch (e) { return '抛出: ' + e.message; } })()");
  ok(opened === "ok", "openAtlasWindow 没抛异常", String(opened));
  await sleep(1500);

  ok(await ev("!!document.querySelector('.codex-atlas-mask')"), "窗口遮罩建起来了");
  ok(await ev("!!document.querySelector('.codex-atlas-panel')"), "面板建起来了");
  ok(await ev("!!document.getElementById('codex-atlas-style')"), "样式注入成功");
  ok(await ev("document.querySelectorAll('.ca-tools button').length === 3"),
    "取词工具条三个按钮都在", String(await ev("document.querySelectorAll('.ca-tools button').length")));
  ok(await ev("!!document.querySelector('.ca-favs')"), "收藏板在");
  ok(await ev("document.querySelectorAll('.ca-side-foot button').length === 2"), "清空/推送两个按钮在");

  const src = await ev("document.querySelector('iframe').src");
  ok(String(src).startsWith("https://novelai.quicktagcloud.com/"), "iframe 指向线上站点", String(src));
  ok(String(src).includes("c=artist_nai5_personal") && String(src).includes("p=zuud7l"),
    "默认法典与路径码带上了", String(src));

  /* 等 iframe 把站点拉起来 —— 跨域读不到内容，看 CDP 的 target 列表 */
  await sleep(7000);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const framed = targets.some(t => String(t.url).includes("novelai.quicktagcloud.com"));
  ok(framed, "线上站点真的在 iframe 里加载了（CDP 里能看到那个 frame target）",
    targets.map(t => t.type + ":" + String(t.url).slice(0, 50)).join(" | "));

  /* 图库切换 */
  await ev(`[...document.querySelectorAll('.codex-atlas-bar button')].find(b => b.textContent.trim() === '我的图库').click()`);
  await sleep(2500);
  const libSrc = await ev("document.querySelector('iframe').src");
  ok(String(libSrc).includes("gallery.html"), "点「我的图库」切到图库页", String(libSrc));
  const libBtnText = await ev(`[...document.querySelectorAll('.codex-atlas-bar button')].map(b => b.textContent.trim()).join(',')`);
  ok(String(libBtnText).includes("回到站点"), "按钮文案跟着换（能切回去）", String(libBtnText));

  /* 再切回站点 */
  await ev(`[...document.querySelectorAll('.codex-atlas-bar button')].find(b => b.textContent.trim() === '← 回到站点').click()`);
  await sleep(2000);
  const backSrc = await ev("document.querySelector('iframe').src");
  ok(String(backSrc).includes("novelai.quicktagcloud.com"), "能切回站点", String(backSrc));

  /* 收藏板开关 */
  await ev(`[...document.querySelectorAll('.ca-tools button')].find(b => b.textContent.includes('收藏')).click()`);
  await sleep(400);
  ok(await ev("!document.querySelector('.ca-favs').hidden"), "点「★ 收藏」能打开收藏板");
  ok(await ev("!!document.querySelector('.ca-fav-empty')"), "空收藏时有引导文案");

  /* 关窗 */
  await ev(`[...document.querySelectorAll('.codex-atlas-bar button')].find(b => b.textContent.trim() === '关闭').click()`);
  await sleep(500);
  ok(await ev("!document.querySelector('.codex-atlas-mask')"), "点「关闭」窗口收掉了");
  ok(errors.length === 0, "全程没有未捕获异常", errors.slice(0, 2).join(" | "));

  console.log(`\n===== ${pass}/${pass + fail} 通过 =====`);
} catch (err) {
  console.error("验证失败:", err.message);
  fail++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  srv.close();
  process.exit(fail ? 1 : 0);
}
