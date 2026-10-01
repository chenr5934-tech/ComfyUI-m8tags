/* 图库独立页（atlas/gallery.html）还能不能用。
 *
 * 它以前长在法典站点里，靠 app.js 切视图；现在站点整个删了，它是独立一页。
 * gallery.js 原样复用，但它对外部的依赖是不是真的只有 SELF_META / SelfMeta，
 * 得真打开一次才算数 —— 少一个全局，页面就是白的。
 *
 * 用真浏览器跑，收 console 报错；不看截图（判断靠 DOM 状态，不靠肉眼）。
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
const ROOT = process.argv[2] || join(HERE, "..", "atlas");
const PORT = Number(process.env.PROBE_PORT || 9227);
const SITE_PORT = 8898;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "verify-gal-"));

const srv = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[\\/]+/, "") || "gallery.html";
    const file = join(ROOT, rel);
    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
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
const consoleErrors = [];

const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + " 超时")); } }, 20000);
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
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push(m.params.args.map(a => a.value || a.description || "").join(" ").slice(0, 200));
    }
    if (m.method === "Runtime.exceptionThrown") {
      consoleErrors.push("未捕获异常: " + String(m.params.exceptionDetails?.exception?.description || "").slice(0, 240));
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${SITE_PORT}/gallery.html` });
  await sleep(3500);

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return "异常: " + String(r.exceptionDetails.exception?.description || "").slice(0, 160);
    return r.result?.value;
  };

  ok(await ev("document.title") === "我的图库", "标题正确");
  ok(await ev("typeof window.SelfMeta === 'object'"), "gallery-meta.js 加载了");
  ok(await ev("typeof window.SelfGallery === 'object'"), "gallery.js 加载了（初始化没中途抛错）");
  ok(await ev("typeof window.SELF_META !== 'undefined'"), "self-image/index.js 加载了");
  ok(await ev("!document.getElementById('selfView').hidden"), "#selfView 默认可见");
  ok(await ev("!!document.getElementById('selfDrop')"), "上传区在");
  ok(await ev("!!document.getElementById('selfGroupNew')"), "新建分组按钮在");
  ok(await ev("!!document.getElementById('selfDetail')"), "详情弹窗在");
  ok(await ev("document.querySelectorAll('#selfGroupList [data-group], #selfGroupList *').length >= 0"), "分组列表渲染过");
  ok(consoleErrors.length === 0, "没有 JS 报错", consoleErrors.slice(0, 3).join(" | "));

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
