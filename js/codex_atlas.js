/* ============================================================================
 * 法典图鉴 · ComfyUI 节点前端
 *
 * 节点形态：tag 框 → [前往词典站寻找灵感] → [随机提示词] → [运行自动随机 开/关]
 *           → 语法切换 → 法典来源 → 负向框
 *
 * 数据一律实时来自线上站点（经后端同源接口，绕开 CORS），
 * 站点更新后插件不用改，新法典会自动出现在下拉里。
 *
 * 语法转换移植自工作区的 convert-nai-to-sdxl.js v3（已跑通 10 部法典 29667 词条）。
 * ==========================================================================*/

import { app } from "/scripts/app.js";

/* 窗口正面 = 线上站点，iframe 直接指过去 —— 站点自己的功能（NAI↔SD 语法、
   Tag 中转站、收藏、灯箱、筛选）原样可用，插件不再自带一份本地站点副本。
   跨域读不到它内部，所以「推送到节点」走剪贴板桥：在站点里点复制，回到这里取一次。 */
const SITE_BASE = "https://novelai.quicktagcloud.com/";
const SITE_CODEX = "artist_nai5_personal";   /* 默认落点：NAI v5 画师词典 */
const SITE_PATH = "zuud7l";                  /* 对应 ?p= 的路径码 */
/* 图库是插件自己伺服的一页（同源），窗口在「站点」和「我的图库」之间切换 */
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

async function apiPost(path, body) {
  const url = new URL(API_BASE + path, window.location.origin);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(`请求 ${url.pathname} 失败：${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`接口返回了非 JSON 内容（HTTP ${res.status}）`);
  if (data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data;
}

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

/* 已选栏落 localStorage：在站点里挑了半天攒起来的一批词，关一下小窗就没了，
   下次还得从头挑一遍 —— 这跟「记录用户行为」是同一件事，都是别让人白忙。
   连两个语法版本一起存，恢复时不用再向后端要一遍。 */
const PICKS_KEY = "qtc-atlas-picks";

function loadPicks() {
  try {
    const arr = JSON.parse(localStorage.getItem(PICKS_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter(p => p && p.codex && p.id) : [];
  } catch (err) { return []; }
}

function savePicks() {
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify(atlas.picks || []));
  } catch (err) { /* 无痕模式禁写存储时静默跳过 */ }
}

/* 拼线上站点的地址。站点的路由认这几个参数（读站点的 router.js 得来的）：
 *   c / codex  法典 id          p         路径码（深链到某个目录）
 *   q          搜索词           scope     搜索范围（codex / site）
 *   entry      直达某条词条      view=favorites  收藏视图
 * 搜到一条好词想把位置记下来，收藏里存的就是这种地址。 */
function buildAtlasUrl({ codexId, query, entry, path, favs } = {}) {
  const url = new URL(SITE_BASE);
  if (favs) {
    url.searchParams.set("view", "favorites");
    return url.href;
  }
  url.searchParams.set("c", codexId || SITE_CODEX);
  if (path !== undefined) {
    if (path) url.searchParams.set("p", path);   /* 显式传空串 = 不回退默认路径 */
  } else if (!codexId && !query) {
    url.searchParams.set("p", SITE_PATH);
  }
  const q = String(query || "").trim();
  if (q) {
    url.searchParams.set("q", q);
    /* 选了法典就在法典内搜，没选才全站搜；进站后还能再手动切范围 */
    url.searchParams.set("scope", codexId ? "codex" : "site");
  }
  if (entry) url.searchParams.set("entry", entry);
  return url.href;
}

/* 图库那一页（同源，插件后端自己伺服的） */
function galleryUrl() {
  return new URL(ATLAS_BASE + "gallery.html", window.location.origin).href;
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
  /* 这里**不清** atlas.picks —— 关窗只是收起来，攒的词留着，
     下次打开由 openAtlasWindow 从 localStorage 恢复。要清空有「清空」按钮。 */
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
    .ca-tools{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid #3f3f46;flex:none;flex-wrap:wrap;}
    .ca-tools button{flex:1;min-width:0;padding:6px 8px;border-radius:6px;cursor:pointer;
      border:1px solid #52525b;background:#27272a;color:#e4e4e7;font-size:12px;font-family:inherit;
      white-space:nowrap;transition:background .12s;}
    .ca-tools button:hover{background:#3f3f46;}
    .ca-tools .ca-tool-main{background:#0f766e;border-color:#14b8a6;color:#e6fffb;font-weight:600;}
    .ca-tools .ca-tool-main:hover{background:#115e59;}
    .ca-field-right{display:flex;align-items:center;gap:8px;}
    .ca-field-btn{padding:2px 9px;border-radius:5px;cursor:pointer;border:1px solid #52525b;
      background:#27272a;color:#d4d4d8;font-size:11px;font-family:inherit;}
    .ca-field-btn:hover{background:#3f3f46;color:#fff;}
    .ca-favs{position:absolute;inset:0;background:#1f1f23;display:flex;flex-direction:column;z-index:2;}
    .ca-favs[hidden]{display:none;}
    .ca-favs-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
      border-bottom:1px solid #3f3f46;font-weight:600;flex:none;}
    .ca-favs-close{border:1px solid #52525b;background:transparent;color:#a1a1aa;border-radius:6px;
      padding:3px 9px;cursor:pointer;font-size:11.5px;font-family:inherit;}
    .ca-favs-close:hover{color:#e4e4e7;border-color:#71717a;}
    .ca-favs-tools{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid #3f3f46;flex:none;flex-wrap:wrap;}
    .ca-favs-tools input{flex:1;min-width:70px;padding:5px 8px;border-radius:6px;background:#18181b;
      color:#e4e4e7;border:1px solid #3f3f46;outline:none;font-size:12px;font-family:inherit;}
    .ca-favs-tools button{padding:5px 9px;border-radius:6px;cursor:pointer;border:1px solid #52525b;
      background:#27272a;color:#e4e4e7;font-size:11.5px;font-family:inherit;white-space:nowrap;}
    .ca-favs-tools button:hover{background:#3f3f46;}
    .ca-favs-list{flex:1;overflow:auto;padding:6px 8px;}
    .ca-fav-empty{color:#71717a;font-size:12px;padding:10px 6px;line-height:1.8;white-space:pre-line;}
    .ca-fav{display:flex;align-items:center;gap:6px;padding:6px;border-radius:6px;margin-bottom:5px;
      background:#27272a;border:1px solid #3f3f46;}
    .ca-fav-body{flex:1;min-width:0;}
    .ca-fav-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .ca-fav-sub{font-size:10.5px;color:#a1a1aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .ca-fav select{background:#18181b;color:#d4d4d8;border:1px solid #3f3f46;border-radius:5px;
      font-size:11px;padding:2px 4px;font-family:inherit;max-width:84px;}
    .ca-fav button{border:1px solid #52525b;background:transparent;color:#a1a1aa;border-radius:5px;
      padding:2px 6px;cursor:pointer;font-size:11px;font-family:inherit;}
    .ca-fav button:hover{color:#e4e4e7;}
    .ca-fav .ca-fav-x:hover{color:#ff6b6b;border-color:#ff6b6b;}
    .codex-atlas-body{flex:1;display:flex;min-height:0;}    .codex-atlas-frame{flex:1;min-width:0;border:0;background:#fff;}
    .codex-atlas-side{width:334px;flex:none;display:flex;flex-direction:column;position:relative;
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
  if (atlas.mask) closeAtlasWindow();
  ensureAtlasStyle();

  atlas.node = node;
  atlas.picks = loadPicks();
  atlas.view = "site";
  atlas.favs = loadFavs();

  const mask = document.createElement("div");
  mask.className = "codex-atlas-mask";

  const panel = document.createElement("div");
  panel.className = "codex-atlas-panel";

  /* ------------------------------- 顶栏 ------------------------------- */
  const bar = document.createElement("div");
  bar.className = "codex-atlas-bar";

  const title = document.createElement("span");
  title.className = "ca-title";
  title.textContent = "◆ 法典图鉴";

  const hint = document.createElement("span");
  hint.className = "ca-hint";
  hint.textContent = "线上站点全功能 · 在站点卡片上点复制，回来点「从剪贴板取词」";

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "在站点里搜词条 / tag…";
  search.autocomplete = "off";
  search.spellcheck = false;

  const goBtn = document.createElement("button");
  goBtn.textContent = "搜索";

  const libBtn = document.createElement("button");
  libBtn.textContent = "我的图库";
  libBtn.title = "上传自己生成的图，读出底模 / LoRA / 提示词（存在插件的 atlas/self-image/）";

  const openBtn = document.createElement("button");
  openBtn.textContent = "浏览器打开";
  openBtn.title = "在独立标签页里打开线上站点";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "关闭";
  closeBtn.className = "ca-close";

  bar.append(title, hint, search, goBtn, libBtn, openBtn, closeBtn);

  /* ------------------------------- 主体 ------------------------------- */
  const body = document.createElement("div");
  body.className = "codex-atlas-body";

  const frame = document.createElement("iframe");
  frame.className = "codex-atlas-frame";
  /* 站点自己要写剪贴板（复制按钮），这里放行；父页面读剪贴板是另一回事，
     走的是 ComfyUI 这个源自己的权限 */
  frame.setAttribute("allow", "clipboard-read; clipboard-write");
  frame.src = buildAtlasUrl({ codexId, query });

  const side = document.createElement("div");
  side.className = "codex-atlas-side";

  /* ---- 取词：站点是跨域的，读不到它选中了什么，只能靠剪贴板过渡 ---- */
  const toolRow = document.createElement("div");
  toolRow.className = "ca-tools";

  const pickPosBtn = document.createElement("button");
  pickPosBtn.className = "ca-tool-main";
  pickPosBtn.textContent = "＋ 从剪贴板取词";
  pickPosBtn.title = "先在站点卡片上点「全部」或「正向」复制，再点这里";

  const pickNegBtn = document.createElement("button");
  pickNegBtn.textContent = "－ 取负面";
  pickNegBtn.title = "先在站点卡片上点「负面」复制，再点这里";

  const favBtn = document.createElement("button");
  favBtn.textContent = "★ 收藏";
  favBtn.title = "把当前已选的内容存进收藏；也能回看存过的词条和网页位置";

  toolRow.append(pickPosBtn, pickNegBtn, favBtn);

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

  /* 预览框：可编辑，字数实时同步；label 右边挂一个动作按钮 */
  const mkField = (label, rows, action) => {
    const field = document.createElement("div");
    field.className = "ca-field";
    const lab = document.createElement("div");
    lab.className = "ca-field-label";
    const nameEl = document.createElement("span");
    nameEl.textContent = label;
    const right = document.createElement("span");
    right.className = "ca-field-right";
    const numEl = document.createElement("span");
    if (action) {
      const btn = document.createElement("button");
      btn.className = "ca-field-btn";
      btn.textContent = action.text;
      btn.title = action.title || "";
      btn.addEventListener("click", () => action.run());
      right.append(btn);
    }
    right.append(numEl);
    lab.append(nameEl, right);
    const area = document.createElement("textarea");
    area.rows = rows;
    area.spellcheck = false;
    const sync = () => { numEl.textContent = `${area.value.length} 字`; };
    /* 手改之后原始 NAI 底稿就作废了 —— 得挂在 atlas.node 上，不能闭包抓参数：
       窗口是公开的调试入口，不传 node 也能开，抓参数就会在 renderPicks 里
       抛「Cannot set properties of undefined」。 */
    area.addEventListener("input", () => {
      sync();
      if (atlas.node) atlas.node.__codexAtlasRaw = null;
    });
    field.append(lab, area);
    return { field, area, sync };
  };

  const posField = mkField("POSITIVE（推送出去的就是这里）", 9, {
    text: "转成 A1111",
    title: "把 NAI 语法（1.3::词::）就地转成 A1111 权重语法（词:1.3）；权重为负的会挪进负向框",
    run: () => {
      const conv = convertTagsString(posField.area.value);
      const merged = mergeTags([conv.positive]);
      posField.area.value = merged;
      posField.sync();
      if (conv.negative) {
        const negMerge = mergeTags([negField.area.value, conv.negative]);
        negField.area.value = negMerge;
        negField.sync();
        toast("已转成 A1111 语法；原本权重为负的那批挪到负向框了", "ok", 4200);
      } else {
        toast("已转成 A1111 语法", "ok", 2600);
      }
    },
  });
  const negField = mkField("NEGATIVE", 6);

  const foot = document.createElement("div");
  foot.className = "ca-side-foot";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "清空";
  const pushBtn = document.createElement("button");
  pushBtn.className = "ca-push";
  pushBtn.textContent = "推送到节点";
  foot.append(clearBtn, pushBtn);

  /* ------------------------------- 收藏板 ------------------------------ */
  const favPanel = document.createElement("div");
  favPanel.className = "ca-favs";
  favPanel.hidden = true;

  const favHead = document.createElement("div");
  favHead.className = "ca-favs-head";
  const favTitle = document.createElement("span");
  favTitle.textContent = "★ 收藏";
  const favClose = document.createElement("button");
  favClose.className = "ca-favs-close";
  favClose.textContent = "← 回到已选栏";
  favHead.append(favTitle, favClose);

  const favTools = document.createElement("div");
  favTools.className = "ca-favs-tools";
  const favGroupInput = document.createElement("input");
  favGroupInput.type = "text";
  favGroupInput.placeholder = "新分类名…";
  const favGroupAdd = document.createElement("button");
  favGroupAdd.textContent = "＋ 建分类";
  const favSavePage = document.createElement("button");
  favSavePage.textContent = "存当前网页位置";
  favSavePage.title = "把窗口里现在这一页（法典 + 路径 + 搜索词）存成收藏，下次一点直接跳过去";
  favTools.append(favGroupInput, favGroupAdd, favSavePage);

  const favList = document.createElement("div");
  favList.className = "ca-favs-list";

  favPanel.append(favHead, favTools, favList);

  side.append(toolRow, sideHead, picks, posField.field, negField.field, foot, favPanel);
  body.append(frame, side);
  panel.append(bar, body);
  mask.appendChild(panel);
  document.body.appendChild(mask);

  atlas.mask = mask;
  atlas.frame = frame;
  atlas.search = search;
  atlas.listEl = picks;
  atlas.posEl = posField.area;
  atlas.negEl = negField.area;
  atlas.countEl = count;
  atlas.favPanel = favPanel;
  atlas.favListEl = favList;
  atlas.favGroupInput = favGroupInput;
  posField.sync();
  negField.sync();
  renderPicks();
  renderFavs();

  /* ------------------------------- 事件 ------------------------------- */
  const runSearch = () => {
    atlas.view = "site";
    syncViewBtn();
    frame.src = buildAtlasUrl({ codexId, query: search.value.trim() });
  };
  goBtn.addEventListener("click", runSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });

  function syncViewBtn() {
    const inLib = atlas.view === "gallery";
    libBtn.textContent = inLib ? "← 回到站点" : "我的图库";
    libBtn.classList.toggle("on", inLib);
    hint.textContent = inLib
      ? "我的图库 · 上传自己生成的图，读出底模 / LoRA / 提示词"
      : "线上站点全功能 · 在站点卡片上点复制，回来点「从剪贴板取词」";
  }

  libBtn.addEventListener("click", () => {
    /* 图库那一页是插件自己伺服的（同源），站点是跨域的 —— 两边都只改 src，
       读内部的事一概不做，跨域那条路本来也读不到。 */
    atlas.view = atlas.view === "gallery" ? "site" : "gallery";
    syncViewBtn();
    frame.src = atlas.view === "gallery"
      ? galleryUrl()
      : buildAtlasUrl({ codexId, query: search.value.trim() });
  });

  openBtn.addEventListener("click", () => {
    window.open(SITE_BASE, "_blank", "noopener");
  });

  closeBtn.addEventListener("click", closeAtlasWindow);
  mask.addEventListener("mousedown", (e) => { if (e.target === mask) closeAtlasWindow(); });
  clearBtn.addEventListener("click", () => {
    atlas.picks = [];
    renderPicks();
  });
  pushBtn.addEventListener("click", pushPicksToNode);

  pickPosBtn.addEventListener("click", () => pickFromClipboard("positive"));
  pickNegBtn.addEventListener("click", () => pickFromClipboard("negative"));
  favBtn.addEventListener("click", () => openFavs(true));
  favClose.addEventListener("click", () => openFavs(false));
  favGroupAdd.addEventListener("click", () => {
    const name = favGroupInput.value.trim();
    if (!name) { toast("先给新分类起个名字", "info", 2600); return; }
    if (!atlas.favs.groups.includes(name)) atlas.favs.groups.push(name);
    favGroupInput.value = "";
    saveFavs(atlas.favs);
    renderFavs();
    toast(`已新建分类：${name}`, "ok", 2600);
  });
  favSavePage.addEventListener("click", () => {
    const url = frame.src;
    if (!url || url === "about:blank") { toast("现在没有可存的页面", "info", 2600); return; }
    const inLib = atlas.view === "gallery";
    addFav({
      kind: "page",
      title: inLib ? "我的图库" : (search.value.trim() ? `站点搜索：${search.value.trim()}` : "站点页面"),
      text: "",
      url,
      group: atlas.favs.groups[0],
    });
  });

  atlas.onKey = (e) => {
    if (e.key === "Escape") {
      /* 收藏板开着就先收收藏板，别一下把整个窗口关了 */
      if (atlas.favPanel && !atlas.favPanel.hidden) { e.stopPropagation(); openFavs(false); return; }
      e.stopPropagation();
      closeAtlasWindow();
    }
  };
  window.addEventListener("keydown", atlas.onKey, true);

  syncViewBtn();
  setTimeout(() => search.focus(), 30);
}

/* ---------------------------------------------------------------------------
 * 已选栏
 *
 * 站点是跨域 iframe，读不到它选中了什么，所以走剪贴板：在站点里点复制，
 * 回来点「从剪贴板取词」→ 进已选栏 → 合并成两份预览 → 推送到节点。
 * 收藏载入的条目也走这里（它们自带文本，不用再去哪儿补）。
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
    empty.textContent = "还没有取到词。\n在右边站点卡片上点「全部」复制，回到这里点「＋ 从剪贴板取词」。";
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

  /* 加入 / 移出 / 清空 / 后端补数据，最后都会走到这里 —— 存这一处就够。 */
  savePicks();
}

/* ============================================================================
 * 收藏
 *
 * 收两样：
 *   词条文本 —— 从站点复制过来的 prompt，带分类存着，下次一点载入已选栏
 *   网页位置 —— 站点深链（c / p / entry / q），点「打开」窗口直接跳过去
 *
 * 存的是 ComfyUI 这个源的 localStorage。站点自己那套收藏在它自己的源底下，
 * 跨域读不到，所以这里是另一份、属于工作流这一侧的收藏。
 * ==========================================================================*/

const FAVS_KEY = "qtc-m8-favs";
const FAV_SRC = "clipboard";   /* 已选栏里 fake 出来的来源名，loadPicks 要求 codex 非空 */

function loadFavs() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVS_KEY) || "null");
    if (raw && Array.isArray(raw.items)) {
      return {
        groups: Array.isArray(raw.groups) && raw.groups.length ? raw.groups : ["默认"],
        items: raw.items.filter(x => x && typeof x === "object" && x.id),
      };
    }
  } catch (err) { /* 坏掉就当没有 */ }
  return { groups: ["默认"], items: [] };
}

function saveFavs(favs) {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify({
      groups: favs.groups,
      items: favs.items.slice(0, 300),   /* 别让它无限长下去 */
    }));
  } catch (err) { /* 存不下就算了，界面照用 */ }
}

function addFav({ kind, title, text, url, group }) {
  const favs = atlas.favs || (atlas.favs = loadFavs());
  const item = {
    id: `f${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    title: String(title || "").slice(0, 60),
    text: String(text || ""),
    url: String(url || ""),
    group: group || favs.groups[0] || "默认",
    ts: Date.now(),
  };
  const dup = favs.items.some(x => (kind === "page" ? x.url && x.url === item.url : x.text === item.text));
  if (dup) { toast("这条已经收藏过了", "info", 2600); return; }
  favs.items.unshift(item);
  saveFavs(favs);
  renderFavs();
  toast(kind === "page" ? "已收藏这个网页位置" : "已收藏这条词条", "ok", 2600);
}

function openFavs(on) {
  if (!atlas.favPanel) return;
  atlas.favPanel.hidden = !on;
  if (on) renderFavs();
}

function renderFavs() {
  const list = atlas.favListEl;
  if (!list) return;
  const favs = atlas.favs || (atlas.favs = loadFavs());
  list.textContent = "";

  if (!favs.items.length) {
    const empty = document.createElement("div");
    empty.className = "ca-fav-empty";
    empty.textContent = "还没有收藏。\n\n"
      + "· 存词条：在右边站点卡片上点「全部」复制 → 点「＋ 从剪贴板取词」→ 点「★ 收藏」\n"
      + "· 存位置：点「存当前网页位置」，把现在这一页记下来，下次一点直接跳过去";
    list.appendChild(empty);
    return;
  }

  for (const item of favs.items) {
    const row = document.createElement("div");
    row.className = "ca-fav";

    const body = document.createElement("div");
    body.className = "ca-fav-body";
    const t = document.createElement("div");
    t.className = "ca-fav-title";
    t.textContent = (item.kind === "page" ? "🔗 " : "◆ ") + (item.title || "(未命名)");
    t.title = item.kind === "page" ? item.url : item.text;
    const sub = document.createElement("div");
    sub.className = "ca-fav-sub";
    sub.textContent = item.kind === "page"
      ? String(item.url).replace(/^https?:\/\/[^/]+/, "")
      : String(item.text).slice(0, 90);
    body.append(t, sub);

    const sel = document.createElement("select");
    for (const g of favs.groups) {
      const o = document.createElement("option");
      o.value = g;
      o.textContent = g;
      sel.appendChild(o);
    }
    sel.value = favs.groups.includes(item.group) ? item.group : favs.groups[0];
    sel.title = "换个分类";
    sel.addEventListener("change", () => {
      item.group = sel.value;
      saveFavs(favs);
      toast(`已移到分类「${sel.value}」`, "ok", 2000);
    });

    const useBtn = document.createElement("button");
    useBtn.textContent = item.kind === "page" ? "打开" : "载入";
    useBtn.title = item.kind === "page" ? "让窗口跳到这一页" : "把这条词条放进已选栏";
    useBtn.addEventListener("click", () => {
      if (item.kind === "page") {
        if (!atlas.frame) return;
        atlas.view = "site";
        atlas.frame.src = item.url;
        openFavs(false);
      } else {
        if (atlas.picks.some(p => p.id === item.id)) {
          toast("这条已经在已选栏里了", "info", 2000);
          return;
        }
        /* 两个语法版本给同一份：取来的是哪版就是哪版，不替用户猜
           （站点自己有 SD 权重开关，它复制出来什么格式，就是用户当时要的格式） */
        atlas.picks.push({
          codex: FAV_SRC, id: item.id, title: item.title,
          tags: item.text, tagsNai: item.text, negative: "", negativeNai: "",
        });
        renderPicks();
        toast(`已载入：${item.title}`, "ok", 2400);
      }
    });

    const del = document.createElement("button");
    del.className = "ca-fav-x";
    del.textContent = "✕";
    del.title = "从收藏里删掉";
    del.addEventListener("click", () => {
      favs.items = favs.items.filter(x => x.id !== item.id);
      saveFavs(favs);
      renderFavs();
    });

    row.append(body, sel, useBtn, del);
    list.appendChild(row);
  }
}

/* 站点复制「正向 + 角色词」时是用换行分段的，这里折成逗号 —— 后面的去重合并
   是按逗号走的。空行和两头空白一并收掉，不然会留下 ", , " 这种碎渣。 */
function normalizeClipText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .join(", ");
}

/* 站点在跨域 iframe 里，读不到它选中了什么，所以用剪贴板过渡一下。
   站点的「全部 / 正向」复制正向串，「负面」复制负向串 —— 分两个按钮，
   这一次取的是哪一路由你点哪个决定。内容原样放进框里，不做自动转换：
   站点自己就有 SD 权重开关，它复制出来什么格式，就是你当时要的格式。 */
async function pickFromClipboard(which) {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    toast("这个环境不让读剪贴板（需要 https 或 127.0.0.1 这种安全上下文）", "error", 6000);
    return;
  }
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    toast(`读剪贴板失败：${err.message}\n浏览器会弹一次授权，点「允许」；实在不行就复制后粘到下面的框里`, "error", 8000);
    return;
  }
  text = String(text || "").trim();
  if (!text) {
    toast("剪贴板是空的 —— 先去右边站点卡片上点一下「全部」或「负面」", "info", 4500);
    return;
  }
  /* 站点复制「正向 + 角色词」时是用换行分段的，这里折成逗号，
     后面的去重合并按逗号走。 */
  text = normalizeClipText(text);

  const area = which === "negative" ? atlas.negEl : atlas.posEl;
  if (!area) return;
  area.value = text;
  area.dispatchEvent(new Event("input"));   /* 让字数统计跟着更新 */
  toast(which === "negative" ? "已取到负向框" : "已取到正向框", "ok", 2400);
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
/* 线上词条只有一份原文：`nai`（原 tags）和 `negative` 都是 NAI 语法。
   A1111 那一版就在这里用现成的转换函数就地生成 —— 不联网、不重新抽词，
   切换语法是原地重渲染，不会丢掉你手改过的内容。 */
function renderEntry(node, entry) {
  const src = entry || {};
  const nai = String(src.nai || src.tags || "");
  const negNai = String(src.negative || "");

  node.__codexAtlasRaw = { nai, negative: negNai };

  if (readSyntax(node) === SYNTAX_NAI) {
    return { text: nai, negative: negNai };
  }
  const conv = convertTagsString(nai);
  const negConv = negNai ? convertTagsString(negNai) : { positive: "", negative: "" };
  return {
    text: conv.positive,
    /* 转换会把正向里权重为负的那批（NAI 的 -1::xxx::）挪出来，
       所以要把三份负向并在一条里，不然转完就丢了一批。 */
    negative: mergeTags([conv.negative, negConv.positive, negConv.negative]),
  };
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

/* 抽一条词写进框里。手点按钮和「运行自动随机」共用这一条路径 ——
   框里看到的就是提交出去的那份，不会出现"自动抽只改后端、界面留着旧词"的两套行为。 */
async function drawOnce(node) {
  const entry = await apiGet("/random", { codex: currentCodexId(node) });
  const rendered = renderEntry(node, entry);
  applyRendered(node, rendered);
  return { entry, rendered };
}

async function onRandom(node) {
  /* 连点会并发出请求，后到的结果覆盖先到的；直接挡住重复触发 */
  if (node.__codexAtlasBusy) return;
  node.__codexAtlasBusy = true;
  toast("正在从本地法典抽词…", "info", 1400);
  try {
    const { entry, rendered } = await drawOnce(node);

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

/* ============================================================================
 * 五之二、运行前自动随机
 *
 * 「每次跑都换一批词」不该靠人手点：手动点一次，抽到的那条就定住了，想再换还得
 * 再点一次，一晚上要点几十回。
 *
 * 挂点选 app.queuePrompt —— 前端所有运行入口最后都从这里过（Run 按钮、
 * Ctrl+Enter、Queue Front、只跑选中的输出节点、队列空时的自动续跑），
 * 在它真正提交之前把词抽好，于是提交上去的就是界面上看得见的那一份。
 *
 * 为什么不放 Python 节点里抽：语法转换（NAI ↔ A1111）和「框里所见即输出」
 * 这两件事都在前端。后端抽词会让框里留着上一次的内容、实际跑的是新词，
 * 抽到什么只能靠翻日志猜。
 * ==========================================================================*/

const AUTORANDOM_PROP = "codexAtlasAutoRandom";

function readAutoRandom(node) {
  return node?.properties?.[AUTORANDOM_PROP] === true;
}

function writeAutoRandom(node, value) {
  node.properties = node.properties || {};
  /* 存 properties，不存 widget 值：按钮 widget 的值不参与工作流序列化，
     存那儿的话存了等于没存，重开一次开关就自己关了。 */
  node.properties[AUTORANDOM_PROP] = !!value;
}

function autoRandomLabel(node) {
  return readAutoRandom(node)
    ? "运行自动随机：开（点击关闭）"
    : "运行自动随机：关（点击开启）";
}

function toggleAutoRandom(node) {
  const next = !readAutoRandom(node);
  writeAutoRandom(node, next);
  const btn = node.__codexAtlasAutoBtn;
  if (btn) btn.name = autoRandomLabel(node);
  toast(next ? "这个节点以后每次运行都会重新抽词" : "已关掉：改回手动点「随机提示词」", "info", 3000);
  app.graph?.setDirtyCanvas(true, true);
}

/* 抽词本身失败（后端没起来、法典数据不在）不该拦住整条工作流 ——
   报一声，然后照常提交，让用户自己决定要不要停下来查。 */
async function autoRandomAllNodes() {
  const all = app.graph?._nodes;
  if (!Array.isArray(all) || !all.length) return 0;
  /* 正被手点抽着的节点跳过，免得两边同时写同一个框 */
  const targets = all.filter(n => readAutoRandom(n) && widgetByName(n, "text") && !n.__codexAtlasBusy);
  if (!targets.length) return 0;

  const results = await Promise.allSettled(targets.map(n => drawOnce(n)));
  const failed = results.filter(r => r.status === "rejected");
  if (failed.length) {
    const reason = failed[0].reason;
    toast(
      `运行前自动随机失败 ${failed.length} 个节点：${reason?.message || reason}\n（已按框里现有内容运行）`,
      "error",
      6000,
    );
  }
  app.graph?.setDirtyCanvas(true, true);
  return targets.length - failed.length;
}

function installAutoRandomHook() {
  if (app.__codexAtlasAutoHooked) return;
  const prev = app.queuePrompt;
  if (typeof prev !== "function") {
    /* 将来前端改名了也不要静默失效 —— 工作流照跑，只是不再自动换词 */
    console.warn("[法典图鉴] 找不到 app.queuePrompt，运行前自动随机未启用（手动点「随机提示词」不受影响）");
    return;
  }
  app.__codexAtlasAutoHooked = true;
  app.queuePrompt = async function (...args) {
    /* 随机失败也要放行：宁可跑一次框里的旧词，也不要把运行整个吞掉 */
    try {
      await autoRandomAllNodes();
    } catch (err) {
      console.warn("[法典图鉴] 运行前自动随机出错：", err);
      toast(`运行前自动随机出错：${err.message}`, "error", 5000);
    }
    return prev.apply(this, args);
  };
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

/* 挂三个按钮。不依赖 addWidget 的返回值（各 ComfyUI 版本行为不一），
   直接按"加之前有几个"切出新增的那几个。 */
function attachButtons(node) {
  const before = node.widgets?.length ?? 0;
  node.addWidget("button", "前往词典站寻找灵感", "", () => onOpenAtlas(node));
  node.addWidget("button", "随机提示词", "", () => onRandom(node));
  node.addWidget("button", autoRandomLabel(node), "", () => toggleAutoRandom(node));
  const added = (node.widgets || []).slice(before);
  /* 第三个按钮要能被 toggleAutoRandom 改名，存一份引用（索引不固定） */
  node.__codexAtlasAutoBtn = added[2] || null;
  return added;
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
  const added = attachButtons(node);
  const syntaxBtn = node.addWidget("button", syntaxButtonLabel(node), "", () => toggleSyntaxOnNode(node));
  node.__codexAtlasSyntaxBtn = (node.widgets || [])[before + added.length] || syntaxBtn || null;

  /* 比原生 CLIP 文本编码多挂了三个按钮 + 一个语法切换，原高度是按单个
     文本框算的，加完就装不下。同样走绝对下限 —— 写成「再加 84」的话，
     工作流每加载一次，节点就会再高一截。 */
  requestAnimationFrame(() => {
    const minW = 330;
    const minH = 320;
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
   * 这个节点比普通节点多三个按钮，text 和 negative 又都是多行框，
   * ComfyUI 给新节点的默认高度装不下 —— 两个按钮会被挤到看不见，
   * 新用户得手动把节点往下拉才找得到「前往词典站寻找灵感」。
   *
   * 为什么不能写成 (当前高度 + 40)：加载已保存的工作流时，node.size
   * 里已经包含这些控件的高度了，再加一次就会越加载越高。
   *
   * 算式（ComfyUI 默认行高）：标题 30 + text 6 行 132 + 三个按钮 84
   * + syntax 28 + codex 28 + negative 74 + 留白 ≈ 408，取下限 430。
   * computeSize() 能算出更大值就听它的 —— 不同前端版本行高不一样。 */
  requestAnimationFrame(() => {
    const minW = 340;
    const minH = 430;
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

    /* 运行入口只有 app.queuePrompt 这一道门，装上钩子后，开了开关的节点
       每次运行都会重新抽词 */
    installAutoRandomHook();

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

/* 供控制台调试与测试用 */
window.__codexAtlas = {
  convertTagsString,
  buildAtlasUrl,
  galleryUrl,
  openAtlasWindow,
  closeAtlasWindow,
  loadCodexIndex,
  drawOnce,
  autoRandomAllNodes,
  readAutoRandom,
  writeAutoRandom,
  pickFromClipboard,
  normalizeClipText,
  loadFavs,
  saveFavs,
  addFav,
  renderFavs,
};
