/* 运行前自动随机的行为测试。
 *
 * 不起浏览器、不连 ComfyUI：把 codex_atlas.js 里那行裸模块 import
 * （`import { app } from "/scripts/app.js"`）换成注入的假 app，然后照 ComfyUI
 * 的真实调用顺序手工走一遍 —— registerExtension 收好 → setup() → nodeCreated()
 * → 点开关 → queuePrompt()。断言的是行为：开着开关的节点在提交前被重新抽词、
 * 关着的原样不动、抽词失败也不拦住运行。
 *
 * 只做静态文本断言（"文件里有 installAutoRandomHook 字样"）测不出这些 ——
 * 少写一次 await、过滤条件写反，文本断言照样绿。
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "js", "codex_atlas.js");
const IMPORT_LINE = 'import { app } from "/scripts/app.js";';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${extra ? "   — " + extra : ""}`);
  }
}
const flush = () => new Promise(r => setTimeout(r, 0));

/* ------------------------------------------------------------------ 环境桩 */

const extensions = [];
const queueCalls = [];
let fetchCalls = [];
let randomPayload = null;
let originalQueue = null;

const app = {
  graph: { _nodes: [], setDirtyCanvas() {} },
  ui: { settings: { getSettingValue: () => false, addSetting() {} } },
  registerExtension(ext) { extensions.push(ext); },
  async queuePrompt(...args) {
    queueCalls.push(args);
    return "queued";
  },
};

function stubDocument() {
  const mkEl = () => ({
    style: {},
    textContent: "",
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
  });
  globalThis.document = {
    createElement: mkEl,
    body: { appendChild() {} },
    head: { appendChild() {} },
    querySelector: () => null,
    addEventListener() {},
  };
}

function installGlobals() {
  globalThis.window = globalThis;
  globalThis.__app = app;
  globalThis.addEventListener = () => {};   /* 模块顶层挂了一个 message 监听（小窗回传） */
  globalThis.removeEventListener = () => {};
  globalThis.location = { origin: "http://comfy.test" };
  globalThis.requestAnimationFrame = (fn) => { try { fn(); } catch (err) { /* 尺寸计算无关本次断言 */ } };
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  stubDocument();
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    fetchCalls.push(path);
    if (path.endsWith("/codexes")) {
      return json({ ok: true, codexes: [{ id: "demo", title: "演示法典" }], dataMtime: 1 });
    }
    if (path.endsWith("/random")) {
      if (!randomPayload) return json({ ok: false, error: "抽词接口挂了" }, 500);
      return json({ ok: true, ...randomPayload });
    }
    return json({ ok: false, error: "not found" }, 404);
  };
}

const json = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return payload; },
});

async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), "codexatlas-"));
  const file = join(dir, "codex_atlas.mjs");
  const src = readFileSync(SRC, "utf8");
  if (src.indexOf(IMPORT_LINE) < 0) {
    throw new Error(`codex_atlas.js 里找不到那行模块 import，改写失败：${IMPORT_LINE}`);
  }
  writeFileSync(file, src.replace(IMPORT_LINE, "const app = globalThis.__app;"), "utf8");
  await import(pathToFileURL(file).href);
}

/* ------------------------------------------------------------ 假节点 / 工具 */

function plainWidget(name, value) {
  return { name, value };
}

function makeNode(type = "CodexAtlasTag") {
  const node = {
    comfyClass: type,
    properties: {},
    size: [400, 500],
    widgets: [],
    addWidget(kind, name, value, callback) {
      const w = { kind, name, value, callback };
      node.widgets.push(w);
      return w;
    },
    setSize(s) { node.size = s; },
    computeSize() { return [400, 500]; },
  };
  /* 后端按 INPUT_TYPES 生成的顺序：required 先，optional 后 */
  node.widgets.push(plainWidget("text", ""));
  node.widgets.push(plainWidget("syntax", "A1111 语法"));
  node.widgets.push(plainWidget("codex", "全部法典（不含 R18）"));
  node.widgets.push(plainWidget("negative", ""));
  return node;
}

const w = (node, name) => node.widgets.find(x => x.name === name);
const AUTO_PREFIX = "运行自动随机：";

async function newNode(type = "CodexAtlasTag") {
  const node = makeNode(type);
  await extensions.find(e => e.name === "CodexAtlas.TagNode").nodeCreated(node);
  await flush(); /* fillCodexOptions 是异步的，等它落地 */
  return node;
}

/* -------------------------------------------------------------------- 跑 */

installGlobals();
await loadModule();

const tagExt = extensions.find(e => e.name === "CodexAtlas.TagNode");
ok(!!tagExt, "扩展注册成功");
ok(!!globalThis.window.__codexAtlas, "模块导出了调试入口 window.__codexAtlas");

originalQueue = app.queuePrompt;
await tagExt.setup();
await flush();

ok(typeof app.queuePrompt === "function" && app.queuePrompt !== originalQueue,
  "setup() 后 app.queuePrompt 被包了一层（运行入口的钩子装上了）");

/* 用例 2：默认关 */
const n1 = await newNode();
const autoBtn = w(n1, AUTO_PREFIX + "关（点击开启）");
ok(!!autoBtn, "节点上有一个「运行自动随机」开关按钮");
ok(n1.properties.codexAtlasAutoRandom === undefined, "默认没写开关状态（即默认关）");
ok(n1.__codexAtlasAutoBtn === autoBtn, "开关按钮的引用存在节点上（改标签要用）");

/* 用例 3 / 4：点开、点关 */
autoBtn.callback();
ok(n1.properties.codexAtlasAutoRandom === true, "点一下：开关变开，状态写进 properties");
ok(!!w(n1, AUTO_PREFIX + "开（点击关闭）"), "按钮标签同步改成「开」");
w(n1, AUTO_PREFIX + "开（点击关闭）").callback();
ok(n1.properties.codexAtlasAutoRandom === false, "再点一下：开关变回关");

/* 用例 5：状态存 properties 而不是 widget 值 —— widget 值不参与工作流序列化 */
const trueBtn = w(n1, AUTO_PREFIX + "关（点击开启）");
ok(trueBtn && trueBtn.value === "", "开关状态没有塞进按钮 widget 的 value（那玩意儿不落盘）");

/* 用例 6：开着的节点在提交前被抽词 */
w(n1, AUTO_PREFIX + "关（点击开启）").callback(); /* 开 */
app.graph._nodes = [n1];
randomPayload = { codex: "demo", codexTitle: "演示法典", title: "词条甲", tags: "抽到的 A1111 文本", tagsNai: "抽到的 NAI 文本", negative: "", negativeNai: "" };
fetchCalls = [];
queueCalls.length = 0;
const ret = await app.queuePrompt(0, 1, { intent: "test" });

ok(fetchCalls.filter(p => p.endsWith("/random")).length === 1, "queuePrompt 提交前抽了一次词", fetchCalls.join(","));
ok(w(n1, "text").value === "抽到的 A1111 文本", "抽到的词已经写进 text 框", JSON.stringify(w(n1, "text").value));
ok(queueCalls.length === 1, "原 queuePrompt 照常被调用（工作流跑起来了）");
ok(ret === "queued", "返回值原样透传");
ok(JSON.stringify(queueCalls[0]) === JSON.stringify([0, 1, { intent: "test" }]), "调用参数原样透传", JSON.stringify(queueCalls[0]));

/* 用例 7：关着的节点不许被碰 */
const n2 = await newNode();
w(n2, "text").value = "我自己手写的词";
app.graph._nodes = [n2];
fetchCalls = [];
queueCalls.length = 0;
await app.queuePrompt(0, 1, {});
ok(fetchCalls.filter(p => p.endsWith("/random")).length === 0, "关着开关的节点不会被抽词");
ok(w(n2, "text").value === "我自己手写的词", "手写内容原样保留");
ok(queueCalls.length === 1, "没有目标节点时也照常提交");

/* 用例 8：一开一关，只抽开着的那个 */
w(n2, AUTO_PREFIX + "关（点击开启）").callback(); /* n2 开 */
n1.properties.codexAtlasAutoRandom = false; /* n1 关 */
app.graph._nodes = [n1, n2];
fetchCalls = [];
queueCalls.length = 0;
await app.queuePrompt(0, 1, {});
ok(fetchCalls.filter(p => p.endsWith("/random")).length === 1, "两个节点一开一关：只抽了开着的那个", fetchCalls.join(","));
ok(w(n2, "text").value === "抽到的 A1111 文本", "开着的那台抽到了新词");
ok(w(n1, "text").value === "抽到的 A1111 文本", "关着的那台没被重抽（值还是上次抽的）");

/* 用例 9：抽词失败不阻断运行 */
randomPayload = null; /* 让 /random 返 500 */
fetchCalls = [];
queueCalls.length = 0;
await app.queuePrompt(0, 1, {});
ok(queueCalls.length === 1, "抽词接口报错时，工作流照样提交（不被拦住）");
ok(fetchCalls.filter(p => p.endsWith("/random")).length === 1, "失败的那次确实尝试过");

/* 用例 10：手点「随机提示词」不受开关影响 */
randomPayload = { codex: "demo", codexTitle: "演示法典", title: "词条乙", tags: "手点抽到的词", tagsNai: "", negative: "", negativeNai: "" };
n2.properties.codexAtlasAutoRandom = false;
app.graph._nodes = [n2];
await w(n2, "随机提示词").callback();
await flush();
ok(w(n2, "text").value === "手点抽到的词", "开关关着时，手动点「随机提示词」照抽不误");

/* 用例 11：NAI 语法下抽到的是 NAI 那一版 */
randomPayload = { codex: "demo", codexTitle: "演示法典", title: "词条丙", tags: "A1111 版", tagsNai: "NAI 版", negative: "", negativeNai: "" };
w(n2, "syntax").value = "原始 NAI 语法";
n2.properties.codexAtlasAutoRandom = true;
app.graph._nodes = [n2];
await app.queuePrompt(0, 1, {});
ok(w(n2, "text").value === "NAI 版", "自动随机也尊重语法切换（NAI 模式下抽的是原始写法）", JSON.stringify(w(n2, "text").value));

/* 用例 12：内置 CLIP 文本编码节点那条路径（inline）——默认关，开了之后行为一致 */
app.ui.settings.getSettingValue = () => true;
const proto = {};
extensions.find(e => e.name === "CodexAtlas.InlineOnBuiltIn").beforeRegisterNodeDef(
  { prototype: proto },
  { name: "CLIPTextEncode" },
);

const inl = makeNode("CLIPTextEncode");
inl.widgets = inl.widgets.filter(x => x.name === "text"); /* 内置节点只有 text 一个框 */
proto.onNodeCreated.call(inl);
await flush();
const inlBtn = w(inl, AUTO_PREFIX + "关（点击开启）");
ok(!!inlBtn, "打开设置后，内置 CLIP 文本编码节点上也有自动随机开关");

inlBtn.callback();
randomPayload = { codex: "demo", codexTitle: "演示法典", title: "词条丁", tags: "inline 抽到的词", tagsNai: "", negative: "", negativeNai: "" };
app.graph._nodes = [inl];
await app.queuePrompt(0, 1, {});
ok(w(inl, "text").value === "inline 抽到的词", "inline 节点的自动随机同样生效", JSON.stringify(w(inl, "text").value));
ok(inl.properties.codexAtlasAutoRandom === true,
  "inline 节点没有 syntax widget，开关状态照样落在 properties 上（能跟着工作流走）");

console.log(`\n===== ${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);
