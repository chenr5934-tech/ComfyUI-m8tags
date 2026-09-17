/* ============================================================================
 * 法典图鉴 · ComfyUI 节点前端
 *
 * 节点形态：tag 框 → [前往词典站寻找灵感] → [随机提示词] → 语法切换 → 法典来源 → 负向框
 *
 * 数据一律实时来自线上站点（经后端同源接口，绕开 CORS），
 * 站点更新后插件不用改，新法典会自动出现在下拉里。
 *
 * 语法转换移植自工作区的 convert-nai-to-sdxl.js v3（已跑通 10 部法典 29667 词条）。
 * ==========================================================================*/

import { app } from "/scripts/app.js";

/* 离线站点由插件后端自己伺服（见 py/routes.py 的 /codex_atlas/atlas/），
   站点文件就在 PROJECTS-项目/本地离线提示词法典 里 —— 同源、不联网。 */
const ATLAS_BASE = "/codex_atlas/atlas/";
const API_BASE = "/codex_atlas";
/* 本插件自己的节点 —— 按钮长在它们自己身上，不去动 ComfyUI 内置的节点 */
const SELF_NODE_TYPES = ["CodexAtlasTag", "CodexAtlasClipEncode"];

const ANY_LABEL = "全部法典（不含 R18）";
const SYNTAX_A1111 = "A1111 语法";
const SYNTAX_NAI = "原始 NAI 语法";

/* ============================================================================
 * 一、NAI → A1111 语法转换
 *
 *  1. w::c::   (w>0)  → (c:w)          NAI 权重组
 *  2. w::c::   (w<0)  → 移入 negative
 *  3. ::c::           → c              空权重组
 *  4. w::c（未闭合）   → (c:w)           单标签权重
 *  5. tag::（裸尾）    → tag
 *  6. {c} n 层        → (c:1.05^n)
 *  7. [c] n 层        → (c:0.95^n)
 *  8. w:tag:          → (tag:w)
 *  9. artist:xxx（含常见笔误）→ xxx
 * 10. (x) / (x:w)     → 保留为 A1111 权重组
 * 11. 标签内字面括号  → \(…\)
 * 12. | 分块 → ,      纯符号权重残留丢弃
 * ==========================================================================*/

function fmtWeight(w) {
  const s = w.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

const ARTIST_PREFIX_RE = /^\s*(?:artist|artists|aritst|arits|atrist|artistt|artis|artsit|atist)\s*:\s*/i;

function stripArtist(s) {
  return s.replace(ARTIST_PREFIX_RE, "");
}

function stripArtistPerTag(s) {
  return String(s).split(",").map(part => stripArtist(part)).join(",");
}

function escapeParens(s) {
  return s.replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/* 平衡括号扫描（跳过转义对） */
function findMatchingClose(s, open, closeChar) {
  let bal = 1;
  let i = open + 1;
  const isEsc = (k) => s[k] === "\\" && k + 1 < s.length && "(){}[]".includes(s[k + 1]);
  while (i < s.length && bal > 0) {
    if (isEsc(i)) { i += 2; continue; }
    if (s[i] === "(" || s[i] === "[" || s[i] === "{") {
      if (s[i] === closeChar) bal++;
      else if (s[i] === (closeChar === ")" ? "(" : closeChar === "]" ? "[" : "{")) bal++;
    } else if (s[i] === ")" || s[i] === "]" || s[i] === "}") {
      if (s[i] === closeChar) bal--;
    }
    i++;
  }
  return bal === 0 ? i - 1 : -1;
}

/* 顶层逗号切分（括号内逗号不切） */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && "()".includes(s[i + 1])) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/* 括号处理：词条起始平衡组保留为 A1111 权重组，其余括号按字面量转义 */
function convertParens(s, allowLeadingGroup = true) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && (s[i + 1] === "(" || s[i + 1] === ")")) { out += ch + s[i + 1]; i += 2; continue; }
    if (ch === "(") {
      let k = i - 1;
      while (k >= 0 && /\s/.test(s[k])) k--;
      const atTokenStart = k < 0 || s[k] === ",";
      const close = findMatchingClose(s, i, ")");
      if (close >= 0 && allowLeadingGroup && atTokenStart) {
        const inner = stripArtistPerTag(s.slice(i + 1, close));
        out += "(" + convertParens(inner, true) + ")";
        i = close + 1;
        continue;
      }
      if (close >= 0) {
        out += "\\(" + convertParens(s.slice(i + 1, close), false) + "\\)";
        i = close + 1;
        continue;
      }
      out += "\\(";
      i++;
      continue;
    }
    if (ch === ")") { out += "\\)"; i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

/* {c}→(c:1.05^n)  [c]→(c:0.95^n)：递归平衡匹配，层数不匹配取 min 丢多余，孤立括号丢弃 */
function convertBraces(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      let run = 0;
      while (s[i + run] === ch) run++;
      let matched = -1;
      let usedRun = 0;
      for (let r = run; r >= 1; r--) {
        let depth = r;
        let j = i + run;
        while (j < s.length && depth > 0) {
          if (s[j] === "\\" && j + 1 < s.length && "(){}[]".includes(s[j + 1])) { j += 2; continue; }
          if (s[j] === ch) depth++;
          else if (s[j] === close) { depth--; if (depth === 0) { matched = j; break; } }
          j++;
        }
        if (matched >= 0) { usedRun = r; break; }
      }
      if (matched >= 0) {
        let inner = s.slice(i + usedRun, matched);
        /* w:tag: 单冒号权重（含 0.3misawa hiroshi: 这类粘连写法） */
        inner = inner.replace(/^([+-]?[\d.]+):?([^:]*):$/, (_m, w, tag) => {
          const t = stripArtist(tag.trim());
          if (!t) return "";
          return `(${escapeParens(t)}:${fmtWeight(parseFloat(w))})`;
        });
        inner = convertBraces(inner);
        const weight = fmtWeight(Math.pow(ch === "{" ? 1.05 : 0.95, usedRun));
        out += `(${stripArtistPerTag(inner)}:${weight})`;
        i = matched + 1;
        continue;
      }
      i += run; /* 未匹配的开括号：丢弃 */
      continue;
    }
    if (ch === "}" || ch === "]") { i++; continue; } /* 孤立闭括号：丢弃 */
    out += ch;
    i++;
  }
  return out;
}

/* 纯文本管线（组内容与普通内容共用） */
function processPlain(s, sink) {
  s = String(s || "").trim();
  if (!s) return "";
  s = s.replace(/([+-]?[\d.]+):([^:(),]+):/g, (_m, w, tag) => {
    const wv = parseFloat(w);
    const t = stripArtist(tag.trim());
    if (!t) return "";
    if (wv < 0) { sink.push(t); return ""; }
    return `(${escapeParens(t)}:${fmtWeight(wv)})`;
  });
  s = convertBraces(s);
  const parts = splitTopLevel(s).map(p => p.trim());
  const out = parts
    .map(p => stripArtist(convertParens(stripArtistPerTag(p), true)))
    .map(p => p.trim())
    /* 只丢带符号的权重残留（如 -3），保留纯数字 tag（如 7010） */
    .filter(p => p && !/^[+-]\d+(?:\.\d+)?$/.test(p));
  return out.join(", ");
}

/* w::c:: 组处理 */
function convertGroup(content, w, sink) {
  const c = processPlain(content, sink);
  if (!c) return "";
  const wv = parseFloat(w);
  if (wv < 0) { sink.push(c); return ""; }
  if (wv > 0 && wv !== 1) return `(${c}:${fmtWeight(wv)})`;
  return c;
}

/* 处理一个 | 分块 */
function processSegment(raw, sink) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/\\\\/g, "\\");
  s = s.replace(/([+-]?[\d.]+)::((?:(?!::).)*?)::/g, (_m, w, content) => convertGroup(content, w, sink));
  s = s.replace(/::((?:(?!::).)*?)::/g, (_m, content) => convertGroup(content, "", sink));
  s = s.replace(/([+-]?[\d.]+)::([^,]+)/g, (_m, w, content) => {
    if (!content.replace(/:/g, "").trim()) return "";
    return convertGroup(content, w, sink);
  });
  s = s.replace(/::/g, "");
  return processPlain(s, sink);
}

/* 转换一条完整 tags 字符串；返回 { positive, negative } */
function convertTagsString(raw) {
  const sink = [];
  const chunks = String(raw || "").split("|").map(chunk => processSegment(chunk, sink));
  const positive = chunks
    .map(c => c.split(",").map(t => t.trim()).filter(Boolean).join(", "))
    .filter(Boolean)
    .join(", ");
  const negative = sink
    .map(t => t.split(",").map(x => x.trim()).filter(Boolean).join(", "))
    .filter(Boolean)
    .join(", ");
  return { positive, negative };
}

/* ============================================================================
 * 二、与后端通信（同源，绕开站点缺 CORS 头的问题）
 * ==========================================================================*/

async function apiGet(path, params) {
  const url = new URL(API_BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    throw new Error(`请求 ${url.pathname} 失败：${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`接口返回了非 JSON 内容（HTTP ${res.status}）`);
  if (data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data;
}

let codexIndexPromise = null;

function loadCodexIndex(force) {
  if (!codexIndexPromise || force) {
    codexIndexPromise = apiGet("/codexes", force ? { refresh: "1" } : {}).catch(err => {
      codexIndexPromise = null; /* 失败不缓存，下次点击会重试 */
      throw err;
    });
  }
  return codexIndexPromise;
}

/* ============================================================================
 * 三、轻量提示条
 * ==========================================================================*/

let toastHost = null;

function toast(message, kind = "info", ms = 2600) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.style.cssText =
      "position:fixed;right:18px;bottom:18px;z-index:100000;display:flex;" +
      "flex-direction:column;gap:8px;pointer-events:none;";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  const accent = kind === "error" ? "#ff6b6b" : kind === "ok" ? "#4ade80" : "#7dd3fc";
  el.style.cssText =
    "max-width:420px;padding:9px 13px;border-radius:8px;font-size:12.5px;line-height:1.5;" +
    "background:rgba(24,24,27,.96);color:#e5e7eb;border:1px solid " + accent +
    ";box-shadow:0 6px 22px rgba(0,0,0,.45);white-space:pre-wrap;word-break:break-word;";
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ============================================================================
 * 四、站内小窗（iframe 浮层）
 *
 * 站点实测无 X-Frame-Options / 无 CSP frame-ancestors，可以嵌入。
 * 跨域下只能单向遥控：改 iframe 的 src 控制它去哪，读不到它内部状态。
 * 可用的遥控参数（来自站点 router.js）：
 *   ?c=<法典id>           指定法典
 *   ?q=<词>&scope=site    全站搜索
 *   ?entry=<词条id>       直达某条词条并开灯箱
 * ==========================================================================*/

const atlas = {
  mask: null, frame: null, search: null, onKey: null,
  node: null,                                    /* 打开小窗的那个节点，推送就推它 */
  picks: [],                                     /* 已选词条 */
  listEl: null, posEl: null, negEl: null, countEl: null,
};

function buildAtlasUrl({ codexId, query } = {}) {
  const url = new URL(ATLAS_BASE + "index.html", window.location.origin);
  if (codexId) url.searchParams.set("c", codexId);
  const q = String(query || "").trim();
  if (q) {
    url.searchParams.set("q", q);
    /* 选了法典就在法典内搜，没选才全站搜；进站后还能再手动切范围 */
    url.searchParams.set("scope", codexId ? "codex" : "site");
  }
  /* 每次都带一个时间戳，逼浏览器重新读 index.html。
     站点里的脚本被浏览器缓存住旧版本时，表现是"某个脚本没跑起来"、
     "按钮点了没反应"，而磁盘上的文件明明是对的 —— 只要入口 HTML 永远
     是新的，它引用的脚本名字/版本也就跟着是新的，这类问题从根上没了。 */
  url.searchParams.set("_", String(Date.now()));
  return url.href;
}

function closeAtlasWindow() {
  if (!atlas.mask) return;
  if (atlas.onKey) window.removeEventListener("keydown", atlas.onKey, true);
  /* 先掐掉 src 再摘 DOM：站点页面不小，别让它在后台继续加载 */
  if (atlas.frame) atlas.frame.src = "about:blank";
  atlas.mask.remove();
  atlas.mask = atlas.frame = atlas.search = atlas.onKey = null;
  atlas.node = null;
  atlas.listEl = atlas.posEl = atlas.negEl = atlas.countEl = null;
  atlas.picks = [];
}

function ensureAtlasStyle() {
  if (document.getElementById("codex-atlas-style")) return;
  const style = document.createElement("style");
  style.id = "codex-atlas-style";
  style.textContent = `
    .codex-atlas-mask{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.66);
      display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);}
    .codex-atlas-panel{width:93vw;height:90vh;display:flex;flex-direction:column;
      border-radius:11px;overflow:hidden;background:#18181b;
      border:1px solid #3f3f46;box-shadow:0 24px 70px rgba(0,0,0,.6);}
    .codex-atlas-bar{display:flex;align-items:center;gap:9px;padding:9px 12px;
      background:#27272a;border-bottom:1px solid #3f3f46;color:#e4e4e7;
      font:13px/1.4 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;flex:none;}
    .codex-atlas-bar .ca-title{font-weight:600;letter-spacing:.3px;white-space:nowrap;}
    .codex-atlas-bar .ca-hint{color:#a1a1aa;font-size:11.5px;white-space:nowrap;overflow:hidden;
      text-overflow:ellipsis;flex:1;min-width:0;}
    .codex-atlas-bar input{flex:0 0 260px;box-sizing:border-box;padding:6px 10px;border-radius:6px;
      border:1px solid #52525b;background:#18181b;color:#e4e4e7;font-size:12.5px;outline:none;}
    .codex-atlas-bar input:focus{border-color:#7dd3fc;}
    .codex-atlas-bar button{padding:6px 13px;border-radius:6px;cursor:pointer;
      border:1px solid #52525b;background:#3f3f46;color:#e4e4e7;font-size:12.5px;
      font-family:inherit;transition:background .12s;}
    .codex-atlas-bar button:hover{background:#52525b;}
    .codex-atlas-bar button.ca-close{background:transparent;border-color:#71717a;}
    .codex-atlas-bar button.ca-close:hover{background:#7f1d1d;border-color:#b91c1c;}
    /* 「我的图库」独立一条，夹在插件标题行和站点之间 ——
       视觉上跟站点自己的顶栏（◆ + 标题 + 说明）一套皮，看起来是一体的 */
    .codex-atlas-libbar{display:flex;align-items:center;gap:9px;padding:8px 12px;
      background:#1f1f23;border-bottom:1px solid #3f3f46;color:#e4e4e7;flex:none;
      font:13px/1.4 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
    .codex-atlas-libbar .ca-lib-dot{color:#34d399;font-size:13px;line-height:1;}
    .codex-atlas-libbar .ca-lib-title{font-weight:600;letter-spacing:.3px;white-space:nowrap;}
    .codex-atlas-libbar .ca-lib-hint{color:#a1a1aa;font-size:11.5px;flex:1;min-width:0;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .codex-atlas-libbar button{padding:5px 15px;border-radius:6px;cursor:pointer;
      border:1px solid #14b8a6;background:#0f766e;color:#e6fffb;font-size:12.5px;
      font-family:inherit;font-weight:600;white-space:nowrap;transition:background .12s;}
    .codex-atlas-libbar button:hover{background:#115e59;}
    .codex-atlas-libbar button.on{background:transparent;border-color:#14b8a6;
      color:#5eead4;font-weight:400;}
    .codex-atlas-body{flex:1;display:flex;min-height:0;}
    .codex-atlas-frame{flex:1;min-width:0;border:0;background:#fff;}
    .codex-atlas-side{width:334px;flex:none;display:flex;flex-direction:column;
      background:#1f1f23;border-left:1px solid #3f3f46;color:#e4e4e7;
      font:12.5px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
    .ca-side-head{display:flex;align-items:center;justify-content:space-between;
      padding:8px 12px;border-bottom:1px solid #3f3f46;font-weight:600;flex:none;}
    .ca-side-head .ca-count{color:#a1a1aa;font-size:11.5px;font-weight:400;}
    .ca-picks{flex:none;max-height:132px;overflow:auto;padding:6px 8px;
      border-bottom:1px solid #3f3f46;}
    .ca-pick{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;}
    .ca-pick:hover{background:#2a2a2f;}
    .ca-pick-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
      white-space:nowrap;font-size:12px;}
    .ca-pick-x{flex:none;border:0;background:transparent;color:#a1a1aa;cursor:pointer;
      font-size:15px;line-height:1;padding:0 2px;}
    .ca-pick-x:hover{color:#ff6b6b;}
    .ca-pick-empty{color:#71717a;font-size:12px;padding:8px 6px;line-height:1.7;
      white-space:pre-line;}
    .ca-field{display:flex;flex-direction:column;padding:8px 10px 0;min-height:0;flex:1;}
    .ca-field-label{display:flex;justify-content:space-between;color:#a1a1aa;
      font-size:11px;margin-bottom:3px;letter-spacing:.4px;flex:none;}
    .ca-field textarea{width:100%;box-sizing:border-box;background:#18181b;color:#e4e4e7;
      border:1px solid #3f3f46;border-radius:5px;padding:6px 8px;outline:none;resize:none;
      font:11.5px/1.5 ui-monospace,Consolas,"Courier New",monospace;flex:1;min-height:54px;}
    .ca-field textarea:focus{border-color:#7dd3fc;}
    .ca-side-foot{display:flex;gap:8px;padding:10px;margin-top:auto;flex:none;}
    .ca-side-foot button{flex:1;padding:8px;border-radius:7px;border:1px solid #52525b;
      background:#3f3f46;color:#e4e4e7;cursor:pointer;font:600 12.5px inherit;
      font-family:inherit;}
    .ca-side-foot button:hover{background:#52525b;}
    .ca-side-foot button.ca-push{background:#0369a1;border-color:#0284c7;}
    .ca-side-foot button.ca-push:hover{background:#0284c7;}
  `;
  document.head.appendChild(style);
}

function openAtlasWindow({ node, codexId, query } = {}) {
  ensureAtlasStyle();
  if (atlas.mask) closeAtlasWindow(); /* 单例：避免叠出多层小窗 */

  atlas.node = node || null;
  atlas.picks = [];

  /* ---- 顶部工具栏 ---- */
  const mask = document.createElement("div");
  mask.className = "codex-atlas-mask";

  const panel = document.createElement("div");
  panel.className = "codex-atlas-panel";

  const bar = document.createElement("div");
  bar.className = "codex-atlas-bar";

  const title = document.createElement("span");
  title.className = "ca-title";
  title.textContent = "◆ 法典图鉴";

  const hint = document.createElement("span");
  hint.className = "ca-hint";
  hint.textContent = "本地离线法典 · 不联网";

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "站内搜索词条 / tag…";
  search.autocomplete = "off";
  search.spellcheck = false;

  const goBtn = document.createElement("button");
  goBtn.textContent = "搜索";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "关闭";
  closeBtn.className = "ca-close";

  /* ---- 「我的图库」独立一条：夹在插件标题行和站点之间 ----
     站点就在下面的 iframe 里，所以图库的完整功能（上传、审阅、分组、删除、
     详情、加入已选栏）跟独立打开站点时一模一样 —— 这一条只是给一个一定
     看得见的入口，不用去 iframe 里翻站点顶栏那个小按钮。 */
  const libBar = document.createElement("div");
  libBar.className = "codex-atlas-libbar";
  const libDot = document.createElement("span");
  libDot.className = "ca-lib-dot";
  libDot.textContent = "◆";

  const libTitle = document.createElement("span");
  libTitle.className = "ca-lib-title";
  libTitle.textContent = "我的图库";

  const libHint = document.createElement("span");
  libHint.className = "ca-lib-hint";
  libHint.textContent = "上传自己生成的图，读出底模 / LoRA / 提示词，存进站点目录的 self-image/";

  const libBtn = document.createElement("button");

  function syncLibBtn() {
    let inLib = false;
    try {
      const w = atlas.frame && atlas.frame.contentWindow;
      const view = w && w.document && w.document.getElementById("selfView");
      inLib = !!view && !view.hidden;
    } catch (e) { /* 拿不到就当在法典视图 */ }
    libBtn.textContent = inLib ? "← 回到法典" : "打开图库";
    libBtn.classList.toggle("on", inLib);
    libHint.textContent = inLib
      ? "正在看我的图库 · 功能和独立打开站点时一致"
      : "上传自己生成的图，读出底模 / LoRA / 提示词，存进站点目录的 self-image/";
  }

  libBtn.addEventListener("click", async () => {
    const w = atlas.frame && atlas.frame.contentWindow;
    if (!w || !w.SelfGallery) {
      /* 光说"没就绪"定位不到东西。主动去问一次服务端：这两个脚本到底
         返回了什么状态码、多少字节 —— 是 404、还是拿到了内容却没执行，
         这两种情况的修法完全不同。 */
      let marks = "";
      try {
        const has = (k) => { try { return k in w; } catch (e) { return false; } };
        const codexOk = has("QTC_META");
        marks = [
          "data " + (codexOk ? "✓" : "✗"),
          "meta " + (has("SelfMeta") ? "✓" : "✗"),
          "app " + (codexOk && w.document.querySelector("#results .card") ? "✓" : "✗"),
          "gallery " + (has("SelfGallery") ? "✓" : "✗"),
        ].join(" · ");
      } catch (e) {
        marks = "（读不到 iframe 内部）";
      }

      let probe = "服务端探测失败";
      try {
        const parts = [];
        for (const f of ["gallery-meta.js", "gallery.js"]) {
          const res = await w.fetch(`${f}?probe=${Date.now()}`, { cache: "no-store" });
          const txt = await res.text();
          const head = txt.slice(0, 40).replace(/\s+/g, " ");
          parts.push(`${f} → HTTP ${res.status} ${txt.length}B 「${head}」`);
        }
        probe = parts.join("\n");
      } catch (e) {
        probe = "服务端探测异常：" + ((e && e.message) || e);
      }

      toast(`脚本状态 ${marks}\n${probe}\n正在重新载入…`, "error", 12000);
      console.warn("[法典图鉴] 图库脚本诊断：", marks, "\n", probe);
      try { atlas.frame.src = buildAtlasUrl({ codexId: "", query: "" }); } catch (e) { /* 忽略 */ }
      return;
    }
    const view = w.document.getElementById("selfView");
    w.SelfGallery.showSelf(!view || view.hidden);
    syncLibBtn();
  });

  libBar.append(libDot, libTitle, libHint, libBtn);
  syncLibBtn();   /* 先把文案摆好，别让按钮空着等第一次 load */

  bar.append(title, hint, search, goBtn, closeBtn);

  /* ---- 主体：左边站点，右边已选栏 ---- */
  const body = document.createElement("div");
  body.className = "codex-atlas-body";

  const frame = document.createElement("iframe");
  frame.className = "codex-atlas-frame";
  frame.setAttribute("allow", "clipboard-write; clipboard-read");
  frame.src = buildAtlasUrl({ codexId, query });
  /* iframe 每次重载（站内搜索、换法典）都会回到法典视图，按钮状态得跟着复位 */
  frame.addEventListener("load", () => { syncLibBtn(); });

  const side = document.createElement("div");
  side.className = "codex-atlas-side";

  const sideHead = document.createElement("div");
  sideHead.className = "ca-side-head";
  const sideTitle = document.createElement("span");
  sideTitle.textContent = "已选栏";
  const count = document.createElement("span");
  count.className = "ca-count";
  count.textContent = "0 条";
  sideHead.append(sideTitle, count);

  const picks = document.createElement("div");
  picks.className = "ca-picks";

  /* 预览框：可编辑，字数实时同步 */
  const mkField = (label, rows) => {
    const field = document.createElement("div");
    field.className = "ca-field";
    const lab = document.createElement("div");
    lab.className = "ca-field-label";
    const nameEl = document.createElement("span");
    nameEl.textContent = label;
    const numEl = document.createElement("span");
    lab.append(nameEl, numEl);
    const area = document.createElement("textarea");
    area.rows = rows;
    area.spellcheck = false;
    const sync = () => { numEl.textContent = `${area.value.length} 字`; };
    area.addEventListener("input", sync);
    field.append(lab, area);
    return { field, area, sync };
  };

  const posField = mkField("POSITIVE", 8);
  const negField = mkField("NEGATIVE", 6);

  const foot = document.createElement("div");
  foot.className = "ca-side-foot";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "清空";
  const pushBtn = document.createElement("button");
  pushBtn.className = "ca-push";
  pushBtn.textContent = "推送到节点";
  foot.append(clearBtn, pushBtn);

  side.append(sideHead, picks, posField.field, negField.field, foot);
  body.append(frame, side);
  panel.append(bar, libBar, body);
  mask.appendChild(panel);
  document.body.appendChild(mask);

  atlas.mask = mask;
  atlas.frame = frame;
  atlas.search = search;
  atlas.listEl = picks;
  atlas.posEl = posField.area;
  atlas.negEl = negField.area;
  atlas.countEl = count;
  posField.sync();
  negField.sync();
  renderPicks();

  const runSearch = () => {
    frame.src = buildAtlasUrl({ codexId, query: search.value.trim() });
  };
  goBtn.addEventListener("click", runSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });
  closeBtn.addEventListener("click", closeAtlasWindow);
  mask.addEventListener("mousedown", (e) => { if (e.target === mask) closeAtlasWindow(); });
  clearBtn.addEventListener("click", () => {
    atlas.picks = [];
    renderPicks();
  });
  pushBtn.addEventListener("click", pushPicksToNode);

  atlas.onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeAtlasWindow(); }
  };
  window.addEventListener("keydown", atlas.onKey, true);

  setTimeout(() => search.focus(), 30);
}

/* ---------------------------------------------------------------------------
 * 已选栏
 *
 * 站点卡片点「＋ 加入已选栏」→ postMessage 过来 → 这里按 codex+id 去后端补齐
 * 两个语法版本（站点自己只有 A1111 那份）→ 合并成两份预览 → 推送进节点。
 * -------------------------------------------------------------------------*/

/* 合并多条词条的 tag：按逗号拆开、忽略大小写去重，保留先出现的写法 */
function mergeTags(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    for (const tag of String(part || "").split(",").map(s => s.trim()).filter(Boolean)) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.join(", ");
}

function renderPicks() {
  if (!atlas.listEl) return;

  atlas.listEl.textContent = "";
  if (!atlas.picks.length) {
    const empty = document.createElement("div");
    empty.className = "ca-pick-empty";
    empty.textContent = "还没有选中词条。\n在左边站点里点卡片上的「＋ 加入已选栏」。";
    atlas.listEl.appendChild(empty);
  } else {
    atlas.picks.forEach((pick, index) => {
      const row = document.createElement("div");
      row.className = "ca-pick";

      const label = document.createElement("span");
      label.className = "ca-pick-title";
      label.textContent = pick.title || pick.id;
      label.title = `${pick.codex} / ${pick.id}`;

      const del = document.createElement("button");
      del.className = "ca-pick-x";
      del.textContent = "×";
      del.title = "从已选栏移出";
      del.addEventListener("click", () => {
        atlas.picks.splice(index, 1);
        renderPicks();
      });

      row.append(label, del);
      atlas.listEl.appendChild(row);
    });
  }

  if (atlas.countEl) atlas.countEl.textContent = `${atlas.picks.length} 条`;

  /* 按节点当前的语法模式取对应版本 */
  const isNai = readSyntax(atlas.node) === SYNTAX_NAI;
  const pos = mergeTags(atlas.picks.map(p => (isNai ? p.tagsNai || p.tags : p.tags)));
  const neg = mergeTags(atlas.picks.map(p => (isNai ? p.negativeNai || p.negative : p.negative)));

  if (atlas.posEl) {
    atlas.posEl.value = pos;
    atlas.posEl.dispatchEvent(new Event("input")); /* 让字数跟着更新 */
  }
  if (atlas.negEl) {
    atlas.negEl.value = neg;
    atlas.negEl.dispatchEvent(new Event("input"));
  }
}

async function addPick({ codex, id, title, kind, tags, negative }) {
  if (!codex || !id) return;
  if (atlas.picks.some(p => p.codex === codex && p.id === id)) {
    toast("这条已经在已选栏里了", "info", 1600);
    return;
  }

  /* 「我的图库」的条目自带正负提示词：它不在法典里，后端 /entry 查不到它，
     所以直接用随消息过来的内容，不用再去补一次。 */
  const selfContained = kind === "self";

  /* 先落一条占位的，界面立刻有反馈；随后补齐两个语法版本 */
  atlas.picks.push({
    codex,
    id,
    title: title || id,
    tags: selfContained ? String(tags || "") : "",
    tagsNai: "",
    negative: selfContained ? String(negative || "") : "",
    negativeNai: "",
  });
  renderPicks();

  if (selfContained) {
    toast(`已加入：${title || id}（来自我的图库）`, "ok", 2600);
    return;
  }

  try {
    const entry = await apiGet("/entry", { codex, id });
    const idx = atlas.picks.findIndex(p => p.codex === codex && p.id === id);
    if (idx >= 0) {
      Object.assign(atlas.picks[idx], entry);
      renderPicks();
    }
  } catch (err) {
    toast(`取词条失败：${err.message}`, "error", 4500);
  }
}

/* 只认自己那个 iframe 发来的消息 */
function onAtlasMessage(event) {
  if (!atlas.mask || !atlas.frame) return;
  if (event.source !== atlas.frame.contentWindow) return;
  const data = event.data;
  if (!data || data.source !== "codex-atlas" || data.type !== "pick") return;
  addPick({
    codex: data.codex,
    id: data.id,
    title: data.title,
    kind: data.kind,          // "self" = 来自我的图库，内容自带
    tags: data.tags,
    negative: data.negative,
  });
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (err2) {
      return false;
    }
  }
}

async function pushPicksToNode() {
  const node = atlas.node;
  if (!node) {
    toast("这个小窗没有关联到节点，关掉重开一次", "error", 4000);
    return;
  }

  const pos = atlas.posEl ? atlas.posEl.value : "";
  const neg = atlas.negEl ? atlas.negEl.value : "";
  if (!pos.trim() && !neg.trim()) {
    toast("已选栏还是空的，先在左边挑几条", "info", 2600);
    return;
  }

  setWidgetValue(node, "text", pos);

  const negWidget = widgetByName(node, "negative");
  if (negWidget) {
    setWidgetValue(node, "negative", neg);
    toast(`✦ 已推送：正向 ${pos.length} 字${neg ? ` · 负向 ${neg.length} 字` : ""}`, "ok", 3400);
  } else if (neg.trim()) {
    /* 内置文本节点只有一个框，负向塞不进去 */
    const ok = await copyToClipboard(neg);
    toast(ok
      ? "这个节点没有负向框：正向已写入，负向已复制到剪贴板，粘到负向编码器即可"
      : "这个节点没有负向框，正向已写入；负向请从已选栏手动复制", "info", 6500);
  } else {
    toast("✦ 已推送到节点", "ok", 2600);
  }

  node.__codexAtlasRaw = null; /* 内容换过了，旧的 NAI 底稿作废 */
  app.graph?.setDirtyCanvas(true, true);
}

/* 站点那边只在被小窗内嵌时才会发消息过来 */
window.addEventListener("message", onAtlasMessage);

/* ============================================================================
 * 五、节点控件
 * ==========================================================================*/

const widgetByName = (node, name) => node?.widgets?.find(w => w.name === name);

function setWidgetValue(node, name, value) {
  const w = widgetByName(node, name);
  if (!w) return;
  w.value = value;
  /* 直接写 DOM 值不会触发 input 事件，因此不会误清掉"原始 NAI 文本"标记 */
  if (w.inputEl) w.inputEl.value = value;
}

/* 语法状态：本插件节点用自己的 syntax widget；挂到 ComfyUI 内置节点上时存进 properties，
   这样会跟着工作流一起序列化，刷新页面也不会丢。 */
function readSyntax(node) {
  const w = widgetByName(node, "syntax");
  if (w) return w.value || SYNTAX_A1111;
  return node?.properties?.codexAtlasSyntax || SYNTAX_A1111;
}

function writeSyntax(node, value) {
  const w = widgetByName(node, "syntax");
  if (w) {
    w.value = value;
    return;
  }
  node.properties = node.properties || {};
  node.properties.codexAtlasSyntax = value;
}

function currentCodexId(node) {
  const w = widgetByName(node, "codex");
  const v = w?.value;
  if (!v || v === ANY_LABEL) return "";
  const map = node.__codexAtlas?.titleToId;
  return (map && map.get(v)) || "";
}

/* 本地数据里两个语法版本都是现成的：tags 是转换后的 A1111、tagsNai 是原始 NAI。
   哪一版缺了就退回另一版，不让框子变空。两份底稿一并留在节点上，切语法时原地重渲染。 */
function renderEntry(node, entry) {
  const src = entry || {};
  const a1111 = String(src.tags || "");
  const naiRaw = String(src.tagsNai || "");
  const negA1111 = String(src.negative || "");
  const negNaiRaw = String(src.negativeNai || "");

  node.__codexAtlasRaw = {
    tags: a1111,
    tagsNai: naiRaw,
    negative: negA1111,
    negativeNai: negNaiRaw,
  };

  return readSyntax(node) === SYNTAX_NAI
    ? { text: naiRaw || a1111, negative: negNaiRaw || negA1111 }
    : { text: a1111, negative: negA1111 };
}

function applyRendered(node, rendered) {
  setWidgetValue(node, "text", rendered.text);
  if (widgetByName(node, "negative")) {
    /* 无条件写，包括空字符串。原来是 `if (!rendered.negative) return;` ——
       先抽到带负向的词条 A，再抽到不带负向的词条 B，正向换成 B 了，
       负向框里还是 A 的旧内容，一提交就把不相干的负向带进工作流。
       「推送」那条路径本来就是无条件写的，两条路径现在一致了。 */
    setWidgetValue(node, "negative", rendered.negative || "");
  } else if (rendered.negative) {
    /* 内置文本节点只有一个框，负向没地方放 —— 至少别让它静默消失 */
    toast(`这个词条还带负向标签：\n${rendered.negative}`, "info", 6500);
  }
}

async function onRandom(node) {
  /* 连点会并发出请求，后到的结果覆盖先到的；直接挡住重复触发 */
  if (node.__codexAtlasBusy) return;
  node.__codexAtlasBusy = true;
  toast("正在从本地法典抽词…", "info", 1400);
  try {
    const entry = await apiGet("/random", { codex: currentCodexId(node) });
    const rendered = renderEntry(node, entry);
    applyRendered(node, rendered);

    if (readSyntax(node) === SYNTAX_NAI && !entry.tagsNai) {
      toast("该词条没有原始 NAI 版本，已按 A1111 显示", "info", 4200);
    }

    const label = entry.codexTitle || entry.codex || "";
    const tagPreview = entry.title || rendered.text.split(",")[0] || "";
    toast(`✦ ${label}\n${tagPreview}`, "ok", 3200);
    app.graph?.setDirtyCanvas(true, true);
  } catch (err) {
    toast(`抽词失败：${err.message}`, "error", 5000);
  } finally {
    node.__codexAtlasBusy = false;
  }
}

function onOpenAtlas(node) {
  openAtlasWindow({ node, codexId: currentCodexId(node) });
}

/* 把按钮插到 tag 框正下方（syntax 之前），符合"框 → 按钮 → 切换"的形态 */
function moveWidgetsAfter(node, widgets, index) {
  const list = node.widgets;
  if (!list) return;
  for (const w of widgets) {
    const i = list.indexOf(w);
    if (i >= 0) list.splice(i, 1);
  }
  list.splice(index, 0, ...widgets);
}

/* 挂两个按钮。不依赖 addWidget 的返回值（各 ComfyUI 版本行为不一），
   直接按"加之前有几个"切出新增的那几个。 */
function attachButtons(node) {
  const before = node.widgets?.length ?? 0;
  node.addWidget("button", "前往词典站寻找灵感", "", () => onOpenAtlas(node));
  node.addWidget("button", "随机提示词", "", () => onRandom(node));
  return (node.widgets || []).slice(before);
}

function syntaxButtonLabel(node) {
  return readSyntax(node) === SYNTAX_A1111
    ? "语法：A1111（点击切换）"
    : "语法：原始 NAI（点击切换）";
}

function toggleSyntaxOnNode(node) {
  const next = readSyntax(node) === SYNTAX_A1111 ? SYNTAX_NAI : SYNTAX_A1111;
  writeSyntax(node, next);
  const btn = node.__codexAtlasSyntaxBtn;
  if (btn) btn.name = syntaxButtonLabel(node);
  const raw = node.__codexAtlasRaw;
  if (raw) applyRendered(node, renderEntry(node, raw));
  app.graph?.setDirtyCanvas(true, true);
}

/* ---------------------------------------------------------------------------
 * 挂到 ComfyUI 内置文本节点上
 *
 * 内置节点只有 text 一个框，所以三个控件按顺序追加在文本框下面。
 * 语法状态存 node.properties，跟着工作流序列化。
 * -------------------------------------------------------------------------*/
function setupInline(node) {
  if (node.__codexAtlasAttached) return; /* 复制 / 重建节点时别重复挂 */
  const textWidget = widgetByName(node, "text");
  if (!textWidget) return; /* 没有文本框的节点不认领 */
  node.__codexAtlasAttached = true;

  if (textWidget.inputEl) {
    textWidget.inputEl.addEventListener("input", () => {
      node.__codexAtlasRaw = null;
    });
  }

  const before = node.widgets?.length ?? 0;
  attachButtons(node);
  node.addWidget("button", syntaxButtonLabel(node), "", () => toggleSyntaxOnNode(node));
  node.__codexAtlasSyntaxBtn = (node.widgets || [])[before + 2] || null;

  /* 比原生 CLIP 文本编码多挂了两个按钮 + 一个语法切换，原高度是按单个
     文本框算的，加完就装不下。同样走绝对下限 —— 写成「再加 84」的话，
     工作流每加载一次，节点就会再高一截。 */
  requestAnimationFrame(() => {
    const minW = 330;
    const minH = 290;
    let needH = minH;
    try {
      const s = node.computeSize?.();
      if (Array.isArray(s) && Number.isFinite(s[1])) needH = Math.max(minH, s[1] + 16);
    } catch (err) { /* 算不出来就用下限兜着 */ }
    const w = Math.max(node.size?.[0] || 0, minW);
    const h = Math.max(node.size?.[1] || 0, needH);
    node.setSize?.([w, h]);
    app.graph?.setDirtyCanvas(true, true);
  });
}

async function fillCodexOptions(node) {
  const widget = widgetByName(node, "codex");
  if (!widget) return;
  const info = await loadCodexIndex();
  const codexes = (info.codexes || []).filter(c => c.id);

  /* combo 只能存字符串，所以 value 用中文标题，实际 id 走映射表。
     标题重名时补上 id —— 否则两个选项会撞成同一个值，选谁都指向同一部法典。 */
  const seen = new Set();
  const labels = [];
  const titleToId = new Map();
  for (const c of codexes) {
    let label = c.title || c.id;
    if (seen.has(label)) label = `${label} (${c.id})`;
    seen.add(label);
    labels.push(label);
    titleToId.set(label, c.id);
  }

  widget.options = widget.options || {};
  widget.options.values = [ANY_LABEL, ...labels];
  if (!widget.options.values.includes(widget.value)) widget.value = ANY_LABEL;

  /* 新版前端的 combo 是真实 DOM select，只换 options 数组有时不重绘，这里补一手 */
  if (widget.element && widget.element.tagName === "SELECT") {
    widget.element.textContent = "";
    for (const v of widget.options.values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      widget.element.appendChild(opt);
    }
    widget.element.value = widget.value;
  }

  node.__codexAtlas = { titleToId, info };
  node.__codexAtlasVersion = `${info.dataMtime || "local"}@${(info.codexes || []).length}`;
  app.graph?.setDirtyCanvas(true, true);
}

function setupNode(node) {
  const textWidget = widgetByName(node, "text");
  if (textWidget?.inputEl) {
    textWidget.inputEl.rows = 6;
    textWidget.inputEl.style.minHeight = "112px";
    textWidget.inputEl.style.resize = "vertical";
    /* 用户手改后，原始 NAI 底稿失效，切语法不再覆盖他写的内容 */
    textWidget.inputEl.addEventListener("input", () => {
      node.__codexAtlasRaw = null;
    });
  }

  const added = attachButtons(node);
  if (added.length) moveWidgetsAfter(node, added, 1);

  const syntaxWidget = widgetByName(node, "syntax");
  if (syntaxWidget) {
    const prev = syntaxWidget.callback;
    syntaxWidget.callback = function (value, ...rest) {
      const r = typeof prev === "function" ? prev.apply(this, [value, ...rest]) : undefined;
      const raw = node.__codexAtlasRaw;
      if (raw) applyRendered(node, renderEntry(node, raw));
      return r;
    };
  }

  fillCodexOptions(node).catch(err => {
    console.warn("[法典图鉴] 法典列表加载失败：", err);
    toast(`法典列表加载失败：${err.message}\n（随机抽词可能不可用，检查网络后重开节点）`, "error", 6000);
  });

  /* 节点尺寸：用「绝对下限」，不用「在当前高度上加多少」。
   *
   * 这个节点比普通节点多两个按钮，text 和 negative 又都是多行框，
   * ComfyUI 给新节点的默认高度装不下 —— 两个按钮会被挤到看不见，
   * 新用户得手动把节点往下拉才找得到「前往词典站寻找灵感」。
   *
   * 为什么不能写成 (当前高度 + 40)：加载已保存的工作流时，node.size
   * 里已经包含这些控件的高度了，再加一次就会越加载越高。
   *
   * 算式（ComfyUI 默认行高）：标题 30 + text 6 行 132 + 两个按钮 56
   * + syntax 28 + codex 28 + negative 74 + 留白 ≈ 380，取下限 400。
   * computeSize() 能算出更大值就听它的 —— 不同前端版本行高不一样。 */
  requestAnimationFrame(() => {
    const minW = 340;
    const minH = 400;
    let needH = minH;
    try {
      const s = node.computeSize?.();
      if (Array.isArray(s) && Number.isFinite(s[1])) needH = Math.max(minH, s[1] + 16);
    } catch (err) { /* 算不出来就用下限兜着 */ }
    const w = Math.max(node.size?.[0] || 0, minW);
    const h = Math.max(node.size?.[1] || 0, needH);
    node.setSize?.([w, h]);
    app.graph?.setDirtyCanvas(true, true);
  });
}

/* ============================================================================
 * 六、注册扩展
 * ==========================================================================*/

app.registerExtension({
  name: "CodexAtlas.TagNode",

  async nodeCreated(node) {
    const type = node.comfyClass || node.type;
    if (!SELF_NODE_TYPES.includes(type)) return;
    try {
      setupNode(node);
    } catch (err) {
      console.error("[法典图鉴] 节点初始化失败：", err);
      toast(`法典图鉴节点初始化失败：${err.message}`, "error", 6000);
    }
  },

  async setup() {
    /* 内置节点上的按钮默认不挂：每个 CLIP 编码节点都长三个控件太碍事，
       做成设置项，用的人自己去打开。 */
    try {
      app.ui.settings.addSetting({
        id: INLINE_SETTING,
        name: "法典图鉴：在「CLIP文本编码」节点上显示按钮",
        tooltip: "打开后，每个 CLIP 文本编码节点底部会多出「前往词典站寻找灵感」「随机提示词」「语法切换」三个控件。改完刷新页面生效。",
        type: "boolean",
        defaultValue: false,
      });
    } catch (err) {
      console.warn("[法典图鉴] 注册设置项失败：", err);
    }

    /* 预热一次法典列表，节点第一次落地时下拉就已就绪 */
    loadCodexIndex().catch(() => {});
  },
});

/* ---------------------------------------------------------------------------
 * 七、把按钮挂到 ComfyUI 内置节点上
 *
 * beforeRegisterNodeDef 在节点类型注册前就能拿到它的原型，这里包一层 onNodeCreated，
 * 于是每一个内置文本节点实例都会自动长出那三个控件。
 * 想再加节点（比如 CLIPTextEncodeSDXL）往 INLINE_TARGETS 里塞名字就行。
 * -------------------------------------------------------------------------*/

const INLINE_TARGETS = ["CLIPTextEncode"];

/* 在内置文本节点上挂按钮这件事默认关掉。
   开了以后每个 CLIP 文本编码节点都会多出三个控件，工作流一复杂就很碍事，
   所以做成设置项，谁想用谁自己开。 */
const INLINE_SETTING = "CodexAtlas.InlineOnClipTextEncode";

app.registerExtension({
  name: "CodexAtlas.InlineOnBuiltIn",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!INLINE_TARGETS.includes(nodeData.name)) return;
    const prevOnCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = typeof prevOnCreated === "function"
        ? prevOnCreated.apply(this, arguments)
        : undefined;
      try {
        if (app.ui?.settings?.getSettingValue(INLINE_SETTING)) setupInline(this);
      } catch (err) {
        console.error("[法典图鉴] 内置节点挂载失败：", err);
      }
      return result;
    };
  },
});

/* 供控制台调试用 */
window.__codexAtlas = { convertTagsString, buildAtlasUrl, openAtlasWindow, closeAtlasWindow, loadCodexIndex };
