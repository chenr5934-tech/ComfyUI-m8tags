/* 我的图库 · 上传图片 -> 解析生成参数 -> 反查 Civitai 链接
 *
 * 只做解析和给链接，不下载任何模型 —— 拿到 C 站页面后自己去 LoRA-Manager 装。
 *
 * 界面跟法典主界面同构：左栏分组 / 中栏卡片网格 / 右栏上传。
 * 卡片直接复用 app.css 里的 .card 一套类，所以长得和法典的卡片一模一样：
 *   点卡片（含大图）= 复制全部提示词；点单个 tag = 复制那个 tag；
 *   卡片下方「查看详情」= 展开底模 / LoRA / 参数 / 原始元数据。
 *
 * 反查策略（关键）：
 *   Civitai 的 model-versions/by-hash 接口要完整 SHA256，而 A1111 元数据里只写
 *   `Model hash: 0d9bd1b873`（SHA256 前 10 位）。但 Civitai 每个文件的 hashes 里
 *   有 AutoV2 字段 —— 它正好就是那 10 位。所以：用名称搜出候选，再拿候选的
 *   AutoV2 / SHA256 跟图片里的短 hash 比对，命中即精确匹配。
 *   没有 hash 的（比如 ComfyUI 只留文件名）就退化成名称搜索结果列表。
 */
(function () {
  "use strict";

  const API = "https://civitai.com/api/v1";
  const API_BASE = "/codex_atlas";   // 本站自己的后端（ComfyUI 插件 或 serve.py 提供的）
  const searchCache = new Map();

  /* ============================ Civitai ============================ */

  function normHash(v) {
    return String(v || "").trim().toLowerCase().replace(/^0x/, "");
  }

  const hashCache = new Map();

  /* 按 hash 直接查。
     Civitai 的 by-hash 支持 8 / 10 / 12 / 64 位前缀，而 A1111 元数据里的
     Model hash 与 Lora hashes 正好是 10 位（也就是 Civitai 的 AutoV2）——
     实测四种长度都能精确命中，比名称搜索可靠得多
     （图片里存的是文件名，C 站上挂的是模型名，名字经常对不上）。 */
  async function byHash(hash) {
    if (hashCache.has(hash)) return hashCache.get(hash);

    let out = null;
    try {
      const res = await fetch(API + "/model-versions/by-hash/" + encodeURIComponent(hash), {
        headers: { "Accept": "application/json" },
      });
      if (res.ok) {
        const v = await res.json();
        const f = (v.files || [])[0] || {};
        out = {
          modelId: v.modelId,
          modelName: (v.model && v.model.name) || "",
          versionId: v.id,
          versionName: v.name || "",
          baseModel: v.baseModel || "",
          pageUrl: "https://civitai.com/models/" + (v.modelId || "") + "?modelVersionId=" + v.id,
          fileName: f.name || "",
          hashes: f.hashes || {},
          trainedWords: v.trainedWords || [],
          nsfw: Boolean(v.model && v.model.nsfw),
        };
      }
    } catch (e) {
      out = null; // 网络不通当作查不到，不算错误
    }
    hashCache.set(hash, out);
    return out;
  }

  async function searchCivitai(name, kind) {
    const key = kind + "|" + name.toLowerCase();
    if (searchCache.has(key)) return searchCache.get(key);

    const url = new URL(API + "/models");
    url.searchParams.set("query", name);
    url.searchParams.set("limit", "12");
    url.searchParams.set("types", kind === "checkpoint" ? "Checkpoint" : "LORA");

    let data;
    try {
      const res = await fetch(url.href, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) {
      const out = { ok: false, error: "查 Civitai 失败：" + e.message, candidates: [] };
      searchCache.set(key, out);
      return out;
    }

    const candidates = [];
    for (const model of data.items || []) {
      for (const v of model.modelVersions || []) {
        const f = (v.files || [])[0] || {};
        candidates.push({
          modelId: model.id,
          modelName: model.name,
          versionId: v.id,
          versionName: v.name,
          baseModel: v.baseModel || "",
          pageUrl: "https://civitai.com/models/" + model.id + "?modelVersionId=" + v.id,
          fileName: f.name || "",
          hashes: f.hashes || {},
          trainedWords: v.trainedWords || [],
          nsfw: Boolean(model.nsfw),
        });
      }
    }
    const out = { ok: true, candidates };
    searchCache.set(key, out);
    return out;
  }

  /* 查一个模型：有 hash 就按 hash 精确查；没 hash 才退化成名称搜索 */
  async function resolveModel(target) {
    const name = String(target.name || "").trim();
    const hash = normHash(target.hash);
    if (!name && !hash) return { status: "none", candidates: [] };

    /* 首选：按 hash 精确查（一个请求搞定，且不受名字对不上影响） */
    if (hash.length >= 8) {
      const hit = await byHash(hash);
      if (hit) return { status: "exact", best: hit, candidates: [hit] };
    }

    /* 兜底：没有 hash，或 hash 在 C 站查不到（常见于 ComfyUI 只留文件名）。
       先按原样搜，搜不到再拿第一个词放宽一次 —— 但结果只能算候选，得自己核对。 */
    if (name) {
      let found = await searchCivitai(name, target.kind);
      if (found.ok && found.candidates.length) {
        const same = found.candidates.filter(
          (c) => stripExt(c.fileName).toLowerCase() === stripExt(name).toLowerCase()
        );
        if (same.length === 1) return { status: "name", best: same[0], candidates: found.candidates };
        return { status: "guess", candidates: found.candidates };
      }

      const firstWord = name.split(/[-_.\s]+/).filter(Boolean)[0];
      if (firstWord && firstWord.length >= 4 && firstWord.toLowerCase() !== name.toLowerCase()) {
        found = await searchCivitai(firstWord, target.kind);
        if (found.ok && found.candidates.length) {
          return { status: "guess", candidates: found.candidates, relaxed: firstWord };
        }
      }
    }

    return { status: "none", candidates: [] };
  }

  function stripExt(s) {
    return String(s || "").replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "");
  }

  /* ============================ DOM 助手 ============================ */

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* app.js 已经提供 toast / flashCopied；单独打开本文件时不至于炸 */
  function notify(msg) {
    try { if (typeof toast === "function") { toast(msg); return; } } catch (e) { /* 忽略 */ }
  }
  function flash(card) {
    try { if (typeof flashCopied === "function") { flashCopied(card); return; } } catch (e) { /* 忽略 */ }
    if (!card) return;
    card.classList.add("copied");
    setTimeout(() => card.classList.remove("copied"), 420);
  }

  async function copyText(text) {
    const s = String(text == null ? "" : text);
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = s;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function stem(name) {
    return String(name || "").replace(/\.[^.]+$/, "");
  }

  /* ============================ 分组 ============================
   *
   * 真相源是站点里的 self-image/index.js（每条记录一个 group 字段）。
   * 但改分组要写文件，而后端存图接口要服务起来才有；文件协议下更是没后端。
   * 所以再叠一层本机覆盖（localStorage）：写不进 index.js 时先记住，
   * 下次能写进去了会自动收敛过去 —— 覆盖层只装"还没落盘的那部分"。
   */

  const OV_KEY = "qtc-self-group-override";     // { 文件名: 分组名 }
  const GNAME_KEY = "qtc-self-group-names";     // ["空分组也要留住的名字"]
  const UNGROUPED = "";
  const VIEW_ALL = "__all__";

  const view = { group: VIEW_ALL, shown: 0 };
  const PAGE = 200;

  let ovCache = null;

  function lsGet(key, dflt) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : dflt;
    } catch (e) {
      return dflt;
    }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  function getOverride() {
    if (!ovCache) ovCache = lsGet(OV_KEY, {}) || {};
    return ovCache;
  }
  function setOverride(file, group) {
    const m = getOverride();
    if (group) m[file] = group; else delete m[file];
    lsSet(OV_KEY, m);
  }

  /* 记录（只认有文件名的） */
  function records() {
    const list = Array.isArray(window.SELF_META) ? window.SELF_META : [];
    return list.filter((r) => r && r.file);
  }

  function groupOf(rec) {
    const ov = getOverride();
    if (Object.prototype.hasOwnProperty.call(ov, rec.file)) return ov[rec.file] || UNGROUPED;
    return rec.group || UNGROUPED;
  }

  /* 分组名 = 记录里出现过的 + 本机声明过的（允许暂时是空分组） */
  function groupNames() {
    const set = new Set();
    for (const n of lsGet(GNAME_KEY, []) || []) if (n) set.add(String(n));
    for (const r of records()) {
      const g = groupOf(r);
      if (g) set.add(g);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }

  function addGroupName(name) {
    const list = lsGet(GNAME_KEY, []) || [];
    if (!name || list.includes(name)) return;
    list.push(name);
    lsSet(GNAME_KEY, list);
  }

  function dropGroupName(name) {
    lsSet(GNAME_KEY, (lsGet(GNAME_KEY, []) || []).filter((n) => n !== name));
  }

  /* 一次遍历算完所有分组的计数。
     左栏每个分组都单独扫一遍全表，图库上千张、分组几十个时就是几万次
     groupOf 调用（每次都碰 localStorage 缓存），不值当。 */
  function countByGroup() {
    const counts = new Map();
    let total = 0;
    for (const r of records()) {
      total++;
      const g = groupOf(r);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    counts.set(VIEW_ALL, total);
    return counts;
  }

  /* 写分组到 index.js：优先找后端（本机跑着，不用授权），否则用文件系统方案 */
  async function groupViaBackend(file, group) {
    const res = await fetch(API_BASE + "/self-image/group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: file, group: group || "" }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error("后端接口没找到（HTTP " + res.status + "）—— 重启一次服务（ComfyUI 或「启动法典.bat」）再试");
      }
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }
    if (!data || data.ok === false) throw new Error((data && data.error) || "分组没写进去");
    return true;
  }

  async function groupViaDir(dir, file, group) {
    const list = await readIndexFrom(dir);
    const rec = list.find((x) => x && x.file === file);
    if (!rec) throw new Error("索引里没有这张图（" + file + "）");
    if (group) rec.group = group; else delete rec.group;
    await writeTextFile(dir, "index.js", renderIndexJs(list));
    return true;
  }

  async function persistGroup(file, group) {
    if (location.protocol !== "file:") {
      try {
        return await groupViaBackend(file, group);
      } catch (err) {
        const msg = String((err && err.message) || err);
        /* 只有"后端压根不在"才降级；404/405 是"后端在但接口没注册"，得说出来 */
        const backendMissing = /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED|URL scheme|HTTP 0\b/i.test(msg);
        if (!backendMissing) throw err;
      }
    }
    const dir = await getSelfDir();
    return groupViaDir(dir, file, group);
  }

  async function setGroup(file, group) {
    const rec = records().find((r) => r.file === file);
    if (!rec) return false;
    const target = group || UNGROUPED;
    if (groupOf(rec) === target) return true;

    rec.group = target;        // 内存先落定，界面立刻响应
    setOverride(file, "");
    if (target) addGroupName(target);

    try {
      await persistGroup(file, target);
      notify("已归入：" + (target || "未分组"));
      return true;
    } catch (e) {
      setOverride(file, target);   // 落不了盘就先在本机记住
      notify("已在本机记住分组（还写不进 self-image/index.js：" + ((e && e.message) || e) + "）");
      return false;
    }
  }

  /* ============================ 渲染：卡片 ============================ */

  function placeholderEl() {
    const ph = el("div", "card-img-placeholder");
    ph.appendChild(el("span", "ph-icon", "🖼"));
    ph.appendChild(el("span", null, "没有预览"));
    return ph;
  }

  /* 卡片上那行元数据摘要：一眼看清这图是什么模型出的。
     细节（C 站链接、权重、完整参数）都在「查看详情」里。 */
  const SOURCE_LABEL = {
    a1111: "A1111 / WebUI",
    comfyui: "ComfyUI",
    novelai: "NovelAI",
    unknown: "格式未知",
  };

  function metaSummary(meta) {
    const bits = [];
    if (meta.checkpoint && meta.checkpoint.name) bits.push("底模 " + meta.checkpoint.name);
    if (meta.loras && meta.loras.length) {
      bits.push("LoRA " + meta.loras.map((l) => l.name).filter(Boolean).join(" / "));
    }
    const p = meta.params || {};
    if (p.Size) bits.push(p.Size);
    if (p.Steps) bits.push("Steps " + p.Steps);
    if (meta.source) bits.push(SOURCE_LABEL[meta.source] || meta.source);
    return bits.join(" · ");
  }

  function modelRow(target) {
    const row = el("div", "self-model");
    const head = el("div", "self-model-head");
    head.appendChild(el("span", "self-model-name", target.name || "(未命名)"));
    if (target.hash) head.appendChild(el("code", "self-hash", target.hash.slice(0, 10)));
    if (target.weight !== undefined && target.weight !== 1 && target.kind === "lora") {
      head.appendChild(el("span", "self-weight", "权重 " + target.weight));
    }
    row.appendChild(head);

    const slot = el("div", "self-model-links");
    slot.appendChild(el("span", "dim", "查询中…"));
    row.appendChild(slot);

    resolveModel(target).then((r) => {
      slot.textContent = "";
      if (r.status === "error") { slot.appendChild(el("span", "self-err", r.error)); return; }

      if (r.status === "exact" || r.status === "name") {
        const b = r.best;
        const a = el("a", "self-link exact", "★ " + b.modelName + " · " + b.versionName);
        a.href = b.pageUrl; a.target = "_blank"; a.rel = "noreferrer";
        slot.appendChild(a);
        slot.appendChild(el("span", "self-badge", r.status === "exact" ? "hash 精确匹配" : "文件名匹配"));
        if (b.baseModel) slot.appendChild(el("span", "dim", "底模 " + b.baseModel));
        return;
      }

      if (r.status === "guess") {
        slot.appendChild(el("span", "dim", r.relaxed
          ? "图片里只留了文件名、没有 hash，按「" + r.relaxed + "」搜到的候选，请自己核对："
          : "没查到精确匹配，下面是搜索结果："));
        const list = el("div", "self-cands");
        r.candidates.slice(0, 6).forEach((c) => {
          const a = el("a", "self-link", c.modelName + " · " + c.versionName + (c.baseModel ? " (" + c.baseModel + ")" : ""));
          a.href = c.pageUrl; a.target = "_blank"; a.rel = "noreferrer";
          list.appendChild(a);
        });
        slot.appendChild(list);
        return;
      }

      slot.appendChild(el("span", "dim", "C 站没搜到"));
    });

    return row;
  }

  function copyBtn(label, text) {
    const b = el("button", "self-copy", label);
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await copyText(text);
      b.textContent = ok ? "已复制" : "复制失败";
      setTimeout(() => { b.textContent = label; }, 1200);
    };
    return b;
  }

  /* 详情内容：底模 / LoRA / 提示词 / 参数 / 原始元数据 / 分组
     —— 返回的是一个片段，塞进弹窗右栏；卡片上不再内联展开。 */
  function buildDetailBody(spec) {
    const meta = spec.meta || {};
    const box = el("div");

    const srcName = SOURCE_LABEL[meta.source] || meta.source || "未知";
    box.appendChild(el("div", "self-source", "格式：" + srcName + " · " + String(meta.format || "?").toUpperCase()));

    (meta.warnings || []).forEach((w) => box.appendChild(el("div", "self-warn", "⚠ " + w)));

    if (meta.checkpoint && meta.checkpoint.name) {
      box.appendChild(el("h4", null, "底模"));
      box.appendChild(modelRow({ kind: "checkpoint", name: meta.checkpoint.name, hash: meta.checkpoint.hash }));
    }

    if (meta.loras && meta.loras.length) {
      box.appendChild(el("h4", null, "LoRA（" + meta.loras.length + "）"));
      meta.loras.forEach((l) => box.appendChild(modelRow({
        kind: "lora", name: l.name, hash: l.hash, weight: l.weight,
      })));
    }

    if (meta.positive) {
      box.appendChild(el("h4", null, "正向提示词"));
      box.appendChild(el("div", "self-prompt", meta.positive));
      box.appendChild(copyBtn("复制正向", meta.positive));
    }
    if (meta.negative) {
      box.appendChild(el("h4", null, "负向提示词"));
      box.appendChild(el("div", "self-prompt neg", meta.negative));
      box.appendChild(copyBtn("复制负向", meta.negative));
    }

    const keys = Object.keys(meta.params || {}).filter((k) => meta.params[k] !== undefined && meta.params[k] !== "");
    if (keys.length) {
      box.appendChild(el("h4", null, "参数"));
      box.appendChild(el("div", "self-params", keys.map((k) => k + ": " + meta.params[k]).join("  ·  ")));
    }

    /* 原始元数据（排查用）：解析不出东西时，自己能看一眼图里到底写了什么 */
    const rawKeys = Object.keys(meta.raw || {});
    if (rawKeys.length) {
      const det = document.createElement("details");
      det.className = "self-raw";
      const sum = document.createElement("summary");
      sum.textContent = "查看图片里的原始元数据（排查用）";
      det.appendChild(sum);
      for (const k of rawKeys) {
        const pre = document.createElement("pre");
        pre.textContent = "【" + k + "】\n" + String(meta.raw[k]).slice(0, 6000);
        det.appendChild(pre);
      }
      box.appendChild(det);
    }

    /* 分组：已入库的写回索引；待保存的先记在这张卡片上，保存时一起带过去 */
    if (spec.onGroupChange) {
      box.appendChild(groupPicker(spec.group || "", async (next) => {
        await spec.onGroupChange(next);
        spec.group = next || "";   // 重画弹窗时选中新分组
        refreshDetail(spec);
      }));
    }

    return box;
  }

  function groupPicker(current, onChange) {
    const row = el("div", "self-group-pick");
    row.appendChild(el("span", null, "分组"));

    const sel = document.createElement("select");
    const mk = (v, t) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      if (v === current) o.selected = true;
      return o;
    };
    sel.appendChild(mk(UNGROUPED, "未分组"));
    groupNames().forEach((n) => sel.appendChild(mk(n, n)));
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "＋ 新建分组…";
    sel.appendChild(newOpt);

    sel.onclick = (ev) => ev.stopPropagation();
    sel.onchange = async (ev) => {
      ev.stopPropagation();
      let g = sel.value;
      if (g === "__new__") {
        const name = (window.prompt("新分组名称") || "").trim();
        if (!name) { sel.value = current; return; }
        addGroupName(name);
        g = name;
      }
      await onChange(g);
    };

    row.appendChild(sel);
    return row;
  }

  /* 卡片骨架：图片窗位 + 标题 + 路径行 + tags + 负面 + 操作条
     ——标签和结构与 app.js 的 renderCard 一致，所以样式直接沿用法典的。 */
  function makeCard(spec) {
    const meta = spec.meta || {};
    const card = el("div", "card");
    if (spec.key) card.dataset.file = spec.key;

    /* 图（点它等于点卡片 = 复制全部，跟法典一样） */
    const imgWrap = el("div", "card-img-wrap");
    if (spec.imgSrc) {
      const img = el("img", "card-img");
      img.loading = "lazy";
      img.alt = spec.title;
      img.src = spec.imgSrc;
      img.onerror = () => { img.remove(); imgWrap.appendChild(placeholderEl()); };
      imgWrap.appendChild(img);
    } else {
      imgWrap.appendChild(placeholderEl());
    }
    if (spec.badges && spec.badges.length) {
      const bd = el("div", "card-badges");
      for (const b of spec.badges) bd.appendChild(el("span", "badge-new " + (b.cls || ""), b.text));
      imgWrap.appendChild(bd);
    }
    card.appendChild(imgWrap);

    /* 正文 */
    const body = el("div", "card-body");

    const titleRow = el("div", "card-title-row");
    titleRow.appendChild(el("h3", "card-title", spec.title));
    body.appendChild(titleRow);

    if (spec.pathLine) body.appendChild(el("div", "card-path", spec.pathLine));

    const summary = metaSummary(meta);
    if (summary) body.appendChild(el("div", "card-meta", summary));

    /* 正向提示词：按逗号拆成一个个 tag，点单个 tag 复制单个（法典行为） */
    const tagsBox = el("div", "card-tags");
    const parts = String(meta.positive || "").split(/,\s*/).map((t) => t.trim()).filter(Boolean);
    if (parts.length) {
      for (const p of parts) {
        const span = el("span", "tag", p);
        span.title = "点击复制此 tag";
        span.onclick = async (ev) => {
          ev.stopPropagation();
          const ok = await copyText(p);
          flash(card);
          notify(ok ? "已复制：" + p.slice(0, 50) : "复制失败");
        };
        tagsBox.appendChild(span);
        tagsBox.appendChild(document.createTextNode(", "));
      }
    } else {
      tagsBox.appendChild(el("span", "dim", "这张图里没有可读的正向提示词"));
    }
    body.appendChild(tagsBox);

    if (meta.negative) body.appendChild(el("div", "card-neg", meta.negative));

    /* 卡片下方常驻一行：查看详情 + 该卡片自己的操作 */
    const foot = el("div", "card-foot");
    const toggle = el("button", "card-detail-toggle", "查看详情");
    toggle.title = "左图右详情：底模 / LoRA 的 C 站链接、参数、原始元数据";
    toggle.onclick = (ev) => {
      ev.stopPropagation();
      openDetail(spec);
    };
    foot.appendChild(toggle);
    (spec.footExtra || []).forEach((b) => foot.appendChild(b));
    body.appendChild(foot);

    /* hover 才露出来的复制条（跟法典一致） */
    const allText = [meta.positive || "", meta.negative ? "负面: " + meta.negative : ""].filter(Boolean).join("\n");
    const actions = el("div", "card-actions");
    const mkCopy = (label, text, primary) => {
      const b = el("button", primary ? "primary" : null, label);
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const ok = await copyText(text);
        flash(card);
        notify(ok ? "已复制 " + label : "复制失败");
      };
      return b;
    };
    actions.appendChild(mkCopy("复制全部", allText, true));
    if (meta.positive) actions.appendChild(mkCopy("复制正向", meta.positive));
    if (meta.negative) actions.appendChild(mkCopy("复制负面", meta.negative));

    /* 被插件小窗内嵌时，多一个「加入已选栏」——独立打开站点时不会出现。
       图库条目不在法典里，宿主后端查不到它，所以正负提示词随消息一起发过去
       （kind: "self" 就是告诉宿主"自带内容，别再跑去查了"）。
       没有正向提示词的图不显示这个按钮 —— 推过去也是空的。 */
    if (meta.positive && typeof hostedInPlugin === "function" && hostedInPlugin()) {
      const pick = el("button", "primary", "＋ 加入已选栏");
      pick.title = "加入插件小窗右侧的已选栏，凑齐后一次推送到节点";
      pick.onclick = (ev) => {
        ev.stopPropagation();
        postPick(
          { id: spec.pickId || spec.title, title: spec.title },
          {
            kind: "self",
            codex: "self-image",
            tags: meta.positive || "",
            negative: meta.negative || "",
          }
        );
        flash(card);
        notify("已加入已选栏：" + spec.title);
      };
      actions.insertBefore(pick, actions.firstChild);
    }

    body.appendChild(actions);

    card.appendChild(body);

    /* 点卡片任意处（含大图）= 复制全部 */
    card.onclick = async () => {
      const ok = await copyText(allText);
      flash(card);
      notify(ok ? "已复制「" + spec.title + "」" : "复制失败");
    };
    return card;
  }

  /* ============================ 详情弹窗（左图右详情） ============================
   *
   * 不内联展开卡片 —— 详情内容长（底模 + 一堆 LoRA + 提示词 + 参数 + 原始元数据），
   * 塞进 230px 宽的卡片里会把瀑布流撑得没法看。改成弹一个长方形窗口：
   * 左边整图（长边贴合、不裁切），右边详情自己滚。
   */

  function refreshDetail(spec) {
    const info = $("selfDetailInfo");
    if (!info) return;
    info.innerHTML = "";

    const head = el("div", "detail-head");
    head.appendChild(el("h3", "detail-title", spec.title || ""));
    if (spec.pathLine) head.appendChild(el("div", "card-path", spec.pathLine));
    info.appendChild(head);

    info.appendChild(buildDetailBody(spec));
  }

  /* opts.review = true 时进入"上传审阅"模式：
     右栏底部出现固定的保存/不保存条，✕ 隐藏、遮罩和 Esc 都不生效 ——
     必须先明确决定存还是不存，才会关掉。 */
  function openDetail(spec, opts) {
    const modal = $("selfDetail");
    const img = $("selfDetailImg");
    if (!modal || !img) return;

    const reviewing = !!(opts && opts.review);
    detailReviewing = reviewing;
    reviewSpec = reviewing ? spec : null;

    const meta = spec.meta || {};
    const allText = [meta.positive || "", meta.negative ? "负面: " + meta.negative : ""].filter(Boolean).join("\n");

    img.src = spec.imgSrc || "";
    img.alt = spec.title || "";
    img.onerror = () => { img.removeAttribute("src"); };
    /* 这里的图片也跟卡片一样：点一下就复制全部提示词 */
    img.onclick = async () => {
      const ok = await copyText(allText);
      notify(ok ? "已复制「" + spec.title + "」的全部提示词" : "复制失败");
    };

    const hint = $("selfDetailHint");
    if (hint) hint.textContent = allText ? "点图片复制全部提示词" : "这张图里没有可读的提示词";

    const closeBtn = $("selfDetailClose");
    if (closeBtn) closeBtn.hidden = reviewing;

    const review = $("selfDetailReview");
    if (review) review.hidden = !reviewing;
    if (reviewing) {
      const saveBtn = $("selfReviewSave");
      const skipBtn = $("selfReviewSkip");
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "保存到图库"; saveBtn.onclick = () => finishReview(true); }
      if (skipBtn) { skipBtn.disabled = false; skipBtn.onclick = () => finishReview(false); }
      renderReviewHead();
    }

    refreshDetail(spec);
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  /* 审阅条上那句问话：写清"正在决定哪一张"，多张连传时顺带报还剩几张 */
  function renderReviewHead() {
    const q = $("selfReviewQuestion");
    if (!q) return;
    const cur = uploadQueue[0];
    q.textContent = "";
    q.appendChild(document.createTextNode("要存进图库吗？"));
    if (cur && cur.file && cur.file.name) {
      /* 多张连传时右下角只有缩略图，不写文件名根本认不出在决定哪一张 */
      q.appendChild(el("span", "detail-review-queue", cur.file.name));
    }
    const rest = Math.max(0, uploadQueue.length - 1);
    if (rest > 0) {
      q.appendChild(el("span", "detail-review-queue", `后面还有 ${rest} 张`));
    }
  }

  function closeDetail(force) {
    const modal = $("selfDetail");
    if (!modal || modal.hidden) return;
    /* 审阅中不许随便关：遮罩点击、Esc、✕ 都得让路，只能点保存或不保存 */
    if (detailReviewing && !force) return;
    modal.hidden = true;
    detailReviewing = false;
    reviewSpec = null;
    const review = $("selfDetailReview");
    if (review) review.hidden = true;      // 收起来，别留给下一次普通详情的展示
    const img = $("selfDetailImg");
    if (img) { img.removeAttribute("src"); img.onclick = null; }
    document.body.style.overflow = "";
  }

  /* ============================ 确认框 ============================
   * 删原图不可逆，不用原生 confirm（长得像系统提示，容易被无脑点掉），
   * 自建一个带警示色的模态框，把"会删什么、不会动什么"讲清楚。
   */

  function askConfirm(opts) {
    return new Promise((resolve) => {
      const modal = $("selfConfirm");
      if (!modal) { resolve(window.confirm((opts.warning || "") + "\n\n" + (opts.text || ""))); return; }

      $("selfConfirmTitle").textContent = opts.title || "确认？";

      const body = $("selfConfirmBody");
      body.innerHTML = "";
      if (opts.warning) body.appendChild(el("div", "warn-line", opts.warning));
      if (opts.text) body.appendChild(el("div", "confirm-file", opts.text));
      if (opts.bullets && opts.bullets.length) {
        const ul = document.createElement("ul");
        opts.bullets.forEach((b) => ul.appendChild(el("li", null, b)));
        body.appendChild(ul);
      }

      const okBtn = $("selfConfirmOk");
      const cancelBtn = $("selfConfirmCancel");
      okBtn.textContent = opts.okText || "确认";
      okBtn.disabled = false;
      cancelBtn.disabled = false;

      const finish = (value) => {
        modal.hidden = true;
        /* 详情弹窗可能还开着，别抢它的滚动锁 */
        const detail = $("selfDetail");
        document.body.style.overflow = (detail && !detail.hidden) ? "hidden" : "";
        okBtn.onclick = cancelBtn.onclick = modal.onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(value);
      };
      const onKey = (e) => { if (e.key === "Escape") finish(false); };

      okBtn.onclick = () => finish(true);
      cancelBtn.onclick = () => finish(false);
      modal.onclick = (e) => { if (e.target === modal) finish(false); };
      document.addEventListener("keydown", onKey);

      modal.hidden = false;
      document.body.style.overflow = "hidden";
      setTimeout(() => cancelBtn.focus(), 0);
    });
  }

  /* ============================ 渲染：网格与左栏 ============================ */

  /* ============================ 上传审阅队列 ============================
   *
   * 上传的图不再直接进网格当"待保存卡片"，而是立刻弹详情弹窗让人当场决定：
   * 存进 self-image/，还是不要。只有点了「保存到图库」才会写盘。
   * 一次选多张就排成队，一张决定完自动弹下一张。
   */

  const uploadQueue = [];
  let reviewSpec = null;          // 当前正在审阅的那张
  let detailReviewing = false;    // 详情弹窗是不是在审阅模式

  /* 把一条上传项还回去：从队列里摘掉，并释放预览 URL。
     延迟释放：弹窗里那张 <img> 可能还指着这个 blob，立刻 revoke 会当场破图。 */
  function releaseUpload(item) {
    const i = uploadQueue.indexOf(item);
    if (i >= 0) uploadQueue.splice(i, 1);
    setTimeout(() => { try { URL.revokeObjectURL(item.url); } catch (e) { /* 忽略 */ } }, 1500);
  }

  /* 弹下一张；已经有一张在审阅中就不动 */
  function processUploadQueue() {
    if (detailReviewing) return;
    const next = uploadQueue[0];
    if (!next) return;
    openDetail(uploadSpec(next), { review: true });
  }

  /* 上传项的 spec 形状 —— 和卡片共用同一套详情渲染 */
  function uploadSpec(item) {
    return {
      title: stem(item.file.name),
      imgSrc: item.url,
      meta: item.meta,
      pathLine: item.file.name + " · 待决定",
      group: item.group,
      onGroupChange: async (next) => {
        const g = next || "";
        const base = item.initialGroup || "";
        item.group = g;
        /* 一次连传好几张时，在某一张上改分组通常是想让这一批都进去 ——
           把后面那些「还停在初始分组、没被单独改过」的也一起带上。
           单独改过的保持原样，不覆盖用户的明确选择。 */
        for (const other of uploadQueue) {
          if (other === item) continue;
          if ((other.initialGroup || "") === base && (other.group || "") === base) {
            other.group = g;
          }
        }
        const alsoOthers = uploadQueue.length > 1 ? "（后面同批的一起改了）" : "";
        notify("这张会存进：" + (g || "未分组") + alsoOthers);
      },
    };
  }

  async function finishReview(save) {
    const item = uploadQueue[0];
    if (!item) { closeDetail(true); return; }

    if (!save) {
      releaseUpload(item);
      closeDetail(true);
      renderAll();
      notify("已跳过，没有写入 self-image/");
      processUploadQueue();
      return;
    }

    const saveBtn = $("selfReviewSave");
    const skipBtn = $("selfReviewSkip");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    if (skipBtn) skipBtn.disabled = true;

    try {
      const r = await saveToGallery(item.file, item.meta, null, item.group);
      releaseUpload(item);
      closeDetail(true);
      renderPathStatus();
      renderAll();
      notify(r.via === "backend"
        ? "已存进 self-image/（后端直接写入）"
        : "已存进你选的目录");
      processUploadQueue();
    } catch (e) {
      /* 保存失败就把弹窗留着，让人重试或者改成不保存 —— 不能悄悄吞掉 */
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "保存到图库"; }
      if (skipBtn) skipBtn.disabled = false;
      if (e && e.name === "AbortError") {
        /* 用户在文件夹选择框里按了取消 —— 这不算失败，别把英文原始错误糊到脸上 */
        notify("你取消了选择文件夹，这张还没保存");
      } else {
        notify("保存失败：" + ((e && e.message) || e));
      }
    }
  }

  function storedImg(rec) {
    return "self-image/" + encodeURIComponent(rec.file);
  }

  function storedCards() {
    const g = view.group;
    const recs = records().filter((r) => (g === VIEW_ALL ? true : groupOf(r) === g));
    /* 新的排前面 */
    return recs.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  function renderCards() {
    const box = $("selfResults");
    if (!box) return;
    box.innerHTML = "";
    view.shown = 0;

    const recs = storedCards();
    const slice = recs.slice(0, PAGE);
    for (const rec of slice) box.appendChild(storedCard(rec));
    view.shown = slice.length;

    if (recs.length > view.shown) {
      const btn = el("button", "more-btn", "加载更多（" + (recs.length - view.shown) + "）");
      btn.onclick = () => {
        const more = recs.slice(view.shown, view.shown + PAGE);
        more.forEach((r) => box.insertBefore(storedCard(r), btn));
        view.shown += more.length;
        if (view.shown >= recs.length) btn.remove();
        else btn.textContent = "加载更多（" + (recs.length - view.shown) + "）";
      };
      box.appendChild(btn);
    }

    const empty = $("selfEmpty");
    if (empty) empty.hidden = recs.length > 0;
  }

  function storedCard(rec) {
    const meta = rec.meta || {};
    const g = groupOf(rec);
    const badges = [
      { text: "已入库", cls: "badge-stored" },
      g ? { text: g, cls: "badge-group" } : null,
    ].filter(Boolean);

    const del = el("button", "card-detail-toggle danger-btn", "从图库删除");
    del.title = "从图库删掉这张图，原图文件也会一起删掉";
    del.onclick = async (ev) => {
      ev.stopPropagation();

      const yes = await askConfirm({
        title: "从图库删除「" + (rec.title || rec.file) + "」？",
        warning: "原图文件会被永久删除，不进回收站，删掉就找不回来了。",
        text: rec.file,
        bullets: [
          "会删掉：站点 self-image/ 里的这张图片文件",
          "会删掉：图库索引 index.js 里的这条记录",
          "不会动：法典的词库和 images/ 目录",
        ],
        okText: "我知道，删除",
      });
      if (!yes) return;

      del.disabled = true;
      del.textContent = "删除中…";
      try {
        await removeFromGallery(rec.file, false);   // keepFile=false：连原图一起删
        notify("已从图库删除：" + rec.file);
        renderAll();
      } catch (e) {
        del.disabled = false;
        del.textContent = "从图库删除";
        notify("删除失败：" + ((e && e.message) || e));
      }
    };

    return makeCard({
      key: rec.file,
      pickId: rec.file,               // 「加入已选栏」用的稳定 id
      title: rec.title || stem(rec.file),
      imgSrc: storedImg(rec),
      meta: meta,
      pathLine: rec.file + (rec.addedAt ? " · " + new Date(rec.addedAt * 1000).toLocaleString() : ""),
      badges: badges,
      group: g,
      onGroupChange: async (next) => { await setGroup(rec.file, next); renderAll(); },
      footExtra: [del],
    });
  }

  function renderGroups() {
    const box = $("selfGroupList");
    if (!box) return;
    box.innerHTML = "";

    const mkRow = (label, value, count, deletable) => {
      const row = el("div", "self-group-row" + (view.group === value ? " active" : ""));
      row.appendChild(el("span", "self-group-name", label));
      row.appendChild(el("span", "self-group-count", String(count)));
      if (deletable) {
        const del = el("button", "self-group-del", "✕");
        del.title = "删掉这个分组（里面的图不会删，只是回到未分组）";
        del.onclick = async (ev) => {
          ev.stopPropagation();
          if (!window.confirm("删除分组「" + label + "」？里面的图片不会删，只会回到未分组。")) return;
          const recs = records().filter((r) => groupOf(r) === label);
          for (const r of recs) await setGroup(r.file, UNGROUPED);
          dropGroupName(label);
          if (view.group === label) view.group = VIEW_ALL;
          renderAll();
        };
        row.appendChild(del);
      }
      row.onclick = () => { view.group = value; renderCards(); renderGroups(); renderStatLine(); };
      return row;
    };

    const counts = countByGroup();
    box.appendChild(mkRow("全部图片", VIEW_ALL, counts.get(VIEW_ALL) || 0, false));
    for (const n of groupNames()) box.appendChild(mkRow(n, n, counts.get(n) || 0, true));
    box.appendChild(mkRow("未分组", UNGROUPED, counts.get(UNGROUPED) || 0, false));
  }

  function renderStatLine() {
    const counts = countByGroup();
    const total = counts.get(VIEW_ALL) || 0;
    const box = $("selfGroupStats");
    if (box) box.textContent = "共 " + total + " 张 · " + groupNames().length + " 个分组";
    const st = $("selfStatus");
    if (st) {
      const n = counts.get(view.group) || 0;
      const where = view.group === VIEW_ALL ? "全部图片" : (view.group || "未分组");
      st.textContent = "「" + where + "」共 " + n + " 张 · 点卡片或大图复制全部提示词，点单个 tag 复制那一个，点卡片下方「查看详情」看底模 / LoRA 链接";
    }
  }

  function renderAll() {
    renderGroups();
    renderCards();
    renderStatLine();
  }

  /* ============================ 处理上传 ============================ */

  async function handleFiles(fileList) {
    const files = [...fileList].filter((f) => /image\/(png|jpeg|jpg)$/i.test(f.type) || /\.(png|jpe?g)$/i.test(f.name));
    if (!files.length) { notify("没有可处理的图片（只支持 PNG / JPEG）"); return; }

    /* 正看着某个分组时上传，默认就往那个分组里放（弹窗里的下拉会显示它） */
    const initialGroup = (view.group === VIEW_ALL || view.group === UNGROUPED) ? "" : view.group;

    let queued = 0;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const meta = window.SelfMeta.parseImage(buf);
        uploadQueue.push({
          file: file,
          meta: meta,
          url: URL.createObjectURL(file),
          group: initialGroup,
          initialGroup: initialGroup,   // 记住初始分组，改分组时用它判断"哪些还没单独改过"
        });
        queued++;
      } catch (e) {
        notify("解析 " + file.name + " 失败：" + ((e && e.message) || e));
      }
    }

    if (!queued) return;
    /* 不落网格：直接弹审阅窗，一张一张决定。落盘只发生在点「保存到图库」之后。 */
    if (queued > 1) notify(`已解析 ${queued} 张，逐张确认要不要保存`);
    processUploadQueue();
  }

  /* ============================ 落盘（self-image/） ============================
   *
   * 存法跟法典对称：原图直接放目录里，索引写成 index.js（window.SELF_META = [...]），
   * 页面靠 <script src="self-image/index.js"> 一读就有，下次打开无需重新解析。
   *
   * 浏览器写文件夹要用 File System Access API，它要求安全上下文：
   *   file:// 直接双击打开  -> 不可用
   *   http://127.0.0.1:...  -> 可用（即从 ComfyUI 的小窗进来）
   * 目录句柄存在 IndexedDB 里，所以只需授权一次。
   */

  const IDB_NAME = "codex-self-gallery";
  const IDB_STORE = "handles";

  function fsSupported() {
    return typeof window.showDirectoryPicker === "function";
  }

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(key) {
    return idb().then((db) => new Promise((resolve) => {
      const r = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    })).catch(() => null);
  }

  function idbPut(key, val) {
    return idb().then((db) => new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    })).catch(() => false);
  }

  async function ensurePermission(handle) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return (await handle.requestPermission(opts)) === "granted";
  }

  async function getSelfDir() {
    if (!fsSupported()) {
      throw new Error("当前打开方式不允许写文件夹。请用 Chrome/Edge 从 ComfyUI 打开（http://127.0.0.1:8188）再用");
    }
    const saved = await idbGet("selfDir");
    if (saved) {
      try { if (await ensurePermission(saved)) return saved; } catch (e) { /* 失效就重选 */ }
    }
    const handle = await window.showDirectoryPicker({ id: "codex-self-image", mode: "readwrite" });
    await idbPut("selfDir", handle);
    return handle;
  }

  async function writeTextFile(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  function renderIndexJs(list) {
    return "/* 我的图库索引 — 由「我的图库」页面写入，勿手改 */\n"
      + "window.SELF_META = " + JSON.stringify(list, null, 1) + ";\n";
  }

  /* 别用非贪婪正则切 JSON：记录里的提示词一旦含 `];`（比如 `[artist:foo];`），
     捕获就会在那里提前断掉，整份索引会被当成空的。改成从左定位开头、
     从右定位结尾，取中间那一段 —— 和 serve.py / 插件的解析规则保持一致。 */
  function parseIndexJs(text) {
    const s = String(text || "");
    const at = s.indexOf("window.SELF_META");
    if (at < 0) return [];
    const open = s.indexOf("[", at);
    const close = s.lastIndexOf("]");
    if (open < 0 || close <= open) return [];
    try { return JSON.parse(s.slice(open, close + 1)); } catch (e) { return []; }
  }

  async function readIndexFrom(dir) {
    try {
      const fh = await dir.getFileHandle("index.js");
      return parseIndexJs(await (await fh.getFile()).text());
    } catch (e) {
      return [];
    }
  }

  /* 走后端存：后端跑在本机，本来就知道站点目录在哪，所以不用用户选文件夹 */
  async function saveViaBackend(file, meta, group) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    /* 分块转 base64 —— 一次性 apply 到大数组会爆栈 */
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    const res = await fetch(API_BASE + "/self-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: file.name, data: btoa(bin), meta: meta, group: group || "" }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      /* 404/405 说明后端在、但接口没注册（多半是 ComfyUI 没重启），
         这要明确报出来，不能悄悄换成"让你选文件夹" */
      if (res.status === 404 || res.status === 405) {
        throw new Error(`后端接口没找到（HTTP ${res.status}）—— 重启一次服务（ComfyUI 或「启动法典.bat」）再试`);
      }
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }
    if (!data) throw new Error("后端返回的不是 JSON");
    if (data.ok === false) throw new Error(data.error || "保存失败");
    return { file: data.file || file.name, via: "backend", dir: data.dir, total: data.total };
  }

  /* 本地内存里的 SELF_META 也要跟着变，否则界面要刷新才看得到新图 */
  function rememberRecord(rec) {
    if (!Array.isArray(window.SELF_META)) window.SELF_META = [];
    const i = window.SELF_META.findIndex((x) => x && x.file === rec.file);
    if (i >= 0) window.SELF_META[i] = rec; else window.SELF_META.push(rec);
  }

  function forgetRecord(file) {
    if (!Array.isArray(window.SELF_META)) return;
    window.SELF_META = window.SELF_META.filter((x) => !(x && x.file === file));
    setOverride(file, "");
  }

  /* 走浏览器（File System Access API）：站点独立打开、后端够不着时才用 */
  async function saveViaDir(file, meta, dir, group) {
    const fh = await dir.getFileHandle(file.name, { create: true });
    const w = await fh.createWritable();
    await w.write(file);
    await w.close();

    const list = await readIndexFrom(dir);
    const entry = {
      file: file.name,
      title: stem(file.name),
      size: file.size || 0,
      addedAt: Math.floor(Date.now() / 1000),
      meta: meta,
    };
    if (group) entry.group = group;
    const i = list.findIndex((x) => x && x.file === file.name);
    if (i >= 0) list[i] = entry; else list.push(entry);

    await writeTextFile(dir, "index.js", renderIndexJs(list));
    return { file: file.name, via: "fsa" };
  }

  async function saveToGallery(file, meta, dirOverride, group) {
    const g = group || "";
    let out;
    if (dirOverride) {
      out = await saveViaDir(file, meta, dirOverride, g); // 测试注入用
    } else {
      /* file:// 下没有后端可调（fetch 不支持 file 协议），直接走浏览器方案，别去试 */
      out = null;
      if (location.protocol !== "file:") {
        try {
          out = await saveViaBackend(file, meta, g);
        } catch (err) {
          const msg = String((err && err.message) || err);
          /* 只有"真的连不上后端"才退到浏览器方案。
             404 / 405 是"后端在但接口没注册"，属于要报出来的错误，不能降级 ——
             否则用户会莫名其妙被弹一个选文件夹的窗。 */
          const backendMissing = /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED|URL scheme|HTTP 0\b/i.test(msg);
          if (!backendMissing) throw err;
        }
      }
      if (!out) {
        const dir = await getSelfDir();
        out = await saveViaDir(file, meta, dir, g);
      }
    }

    /* 内存同步，界面不用刷新就能看到刚存的图 */
    const rec = {
      file: out.file || file.name,
      title: stem(out.file || file.name),
      size: file.size || 0,
      addedAt: Math.floor(Date.now() / 1000),
      meta: meta,
    };
    if (g) rec.group = g;
    rememberRecord(rec);
    if (g) addGroupName(g);
    setOverride(rec.file, "");
    return out;
  }

  /* 后端摘索引：keepFile=true 时原图留着，只把记录从 index.js 里去掉 */
  async function removeViaBackend(file, keepFile) {
    const res = await fetch(API_BASE + "/self-image/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: file, keepFile: !!keepFile }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error("后端接口没找到（HTTP " + res.status + "）—— 重启一次服务（ComfyUI 或「启动法典.bat」）再试");
      }
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }
    if (!data || data.ok === false) throw new Error((data && data.error) || "移除失败");
    return true;
  }

  async function removeViaDir(dir, file, keepFile) {
    if (!keepFile) {
      try { await dir.removeEntry(file); } catch (e) { /* 文件不在了也算成功 */ }
    }
    const list = (await readIndexFrom(dir)).filter((x) => !(x && x.file === file));
    await writeTextFile(dir, "index.js", renderIndexJs(list));
    return true;
  }

  /* keepFile 默认 false：删就是真删（前端会先弹确认框警告） */
  async function removeFromGallery(file, keepFile) {
    const keep = !!keepFile;
    if (location.protocol !== "file:") {
      try {
        await removeViaBackend(file, keep);
        forgetRecord(file);
        return true;
      } catch (err) {
        const msg = String((err && err.message) || err);
        const backendMissing = /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED|URL scheme|HTTP 0\b/i.test(msg);
        if (!backendMissing) throw err;
      }
    }
    const dir = await getSelfDir();
    await removeViaDir(dir, file, keep);
    forgetRecord(file);
    return true;
  }

  /* 保存位置那条：说清图会存到哪，并给一个改路径的入口 */
  async function renderPathStatus() {
    const text = $("selfPathText");
    if (!text) return;

    /* file:// 下没有后端（fetch 也不支持 file 协议），别去探测，否则控制台冒红字 */
    if (location.protocol !== "file:") {
      try {
        const res = await fetch(API_BASE + "/status", { cache: "no-store" });
        if (res.ok) {
          const d = await res.json();
          /* 光有 /status 不代表能存图 —— 要后端明确声明支持 self-image，
             否则服务还没起来（存图接口没注册）也会显示"后端直接写入"，误导人 */
          if (d && d.ok && (d.features || []).includes("self-image")) {
            /* 站点服务返回 mode: "local-server"，插件返回 "comfyui-plugin"。
               两边都显式给，别靠"字段有没有"猜来源 —— 猜错就是提示一条错的路径。 */
            const where = d.mode === "local-server"
              ? "本地服务直接写入"
              : d.mode === "comfyui-plugin"
                ? "由 ComfyUI 后端直接写入"
                : "由本地后端直接写入";
            text.textContent = "站点目录下的 self-image/（" + where + "，不用选文件夹）";
            return;
          }
          if (d && d.ok && d.dir) {
            /* 只说"站点根目录下的 self-image/"，不把本机绝对路径糊到界面上 */
            text.textContent = "后端还没加载存图接口 —— 重启一次服务后即可自动写入站点根目录下的 self-image/";
            return;
          }
        }
      } catch (e) { /* 后端不在，那就看浏览器方案 */ }
    }

    const handle = await idbGet("selfDir");
    text.textContent = handle
      ? "你授权的文件夹：" + handle.name + "（记在本机浏览器里）"
      : "未设置 —— 首次保存时请选择默认保存路径";
  }

  async function changeSavePath() {
    if (!fsSupported()) {
      notify("这个打开方式不能选文件夹；从 ComfyUI 打开站点就不需要选了");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: "codex-self-image", mode: "readwrite" });
      await idbPut("selfDir", handle);
      await renderPathStatus();
      notify("保存路径已更新：" + handle.name);
    } catch (e) {
      if (e && e.name === "AbortError") return; /* 用户自己取消的，不用报 */
      notify("换路径失败：" + ((e && e.message) || e));
    }
  }

  /* ============================ 视图切换 ============================ */

  function showSelf(on) {
    const main = document.querySelector(".layout");
    const view_ = $("selfView");
    const foot = document.querySelector(".foot");
    if (!view_) return;
    view_.hidden = !on;
    if (main) main.hidden = on;
    if (foot) foot.hidden = on;
    const btn = $("selfBtn");
    if (btn) {
      btn.classList.toggle("on", on);
      btn.textContent = on ? "← 回到法典" : "＋ 我的图库";
    }
    if (on) {
      renderAll();
      view_.scrollIntoView({ block: "start" });
    } else {
      window.scrollTo({ top: 0 });
    }
  }

  /* ============================ 初始化 ============================ */

  function newGroup() {
    const name = (window.prompt("新分组名称（建好后在卡片的「查看详情」里把图片归进去）") || "").trim();
    if (!name) return;
    addGroupName(name);
    /* 建完停在当前视图 —— 刚建的分组是空的，切过去只会让人找不到图 */
    renderAll();
    notify("已新建分组：" + name + "，可在卡片「查看详情」里把图片归进去");
  }

  function init() {
    const btn = $("selfBtn");
    if (btn) btn.onclick = () => showSelf($("selfView").hidden);

    renderAll();          // 已收录的先摆出来
    renderPathStatus();   // 保存位置

    const pathBtn = $("selfPathBtn");
    if (pathBtn) pathBtn.onclick = changeSavePath;

    const groupNew = $("selfGroupNew");
    if (groupNew) groupNew.onclick = newGroup;

    /* 详情弹窗：右上角 ✕ / 点遮罩 / Esc 都能关 */
    const modal = $("selfDetail");
    if (modal) {
      const closeBtn = $("selfDetailClose");
      /* 一定要包一层箭头函数：直接 `onclick = closeDetail` 会把 MouseEvent
         当第一个参数传进去，而那个参数是 force —— 事件对象是 truthy，
         「审阅中不许关」的拦截就被整条绕过去了。 */
      if (closeBtn) closeBtn.onclick = () => closeDetail();
      modal.addEventListener("click", (e) => { if (e.target === modal) closeDetail(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
    }

    const drop = $("selfDrop");
    const input = $("selfFile");
    if (!drop || !input) return;

    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { handleFiles(input.files); input.value = ""; });

    ["dragenter", "dragover"].forEach((t) =>
      drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); })
    );
    ["dragleave", "drop"].forEach((t) =>
      drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); })
    );
    drop.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    /* 整页也能接收拖拽，省得非要对准那个框 */
    window.addEventListener("dragover", (e) => {
      if (!$("selfView") || $("selfView").hidden) return;
      e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
      if (!$("selfView") || $("selfView").hidden) return;
      e.preventDefault();
      /* 拖到右栏框里时由框自己处理，别重复解析一次 */
      if (drop.contains(e.target)) return;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
  }

  /* 先把出口挂上，再跑初始化。
     顺序反过来的话，init() 里任何一处抛错都会让 IIFE 提前中断，
     window.SelfGallery 永远不定义 —— 插件小窗那边就只能一直显示
     "站点还在加载"，而且看起来像是加载问题，其实早就加载完了。 */
  window.SelfGallery = {
    handleFiles,
    showSelf,
    renderAll,
    searchCivitai,
    resolveModel,
    saveToGallery,       // 第三参可注入目录句柄、第四参可带分组，便于测试
    removeFromGallery,
    setGroup,
    groupNames,
    groupOf,
    records,
    parseIndexJs,
    renderIndexJs,
  };

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  } catch (e) {
    console.error("[我的图库] 初始化失败：", e);
    try { notify("图库初始化出错：" + ((e && e.message) || e)); } catch (e2) { /* 忽略 */ }
  }
})();
