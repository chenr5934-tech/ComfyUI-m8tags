/* 我的图库 · 图片元数据解析
 *
 * 从 AI 生成的图片里读出生成参数，支持三种常见内嵌格式：
 *   A1111    ：一段文本，正向 + "Negative prompt: " + 参数行（Steps/Model/Lora hashes…）
 *   ComfyUI  ：PNG 的 prompt / workflow chunk（JSON）
 *   NovelAI  ：PNG 的 Comment chunk（JSON）
 *
 * 载体：
 *   PNG  -> tEXt / iTXt chunk
 *   JPEG -> EXIF UserComment
 *
 * 同时兼容浏览器 <script> 和 Node require，方便跑测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SelfMeta = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LATIN1 = new TextDecoder("latin1");
  const UTF8 = new TextDecoder("utf-8");
  const UTF16LE = new TextDecoder("utf-16le");

  /* ============================ 字节工具 ============================ */

  const u8 = (buf, start, len) => new Uint8Array(buf, start, len);

  function asciiFrom(arr, start, len) {
    let s = "";
    const end = Math.min(arr.length, start + len);
    for (let i = start; i < end; i++) s += String.fromCharCode(arr[i]);
    return s;
  }

  function indexOfByte(arr, byte, from) {
    for (let i = from || 0; i < arr.length; i++) if (arr[i] === byte) return i;
    return -1;
  }

  function isPng(buf) {
    if (buf.byteLength < 8) return false;
    const a = new Uint8Array(buf, 0, 8);
    return a[0] === 0x89 && a[1] === 0x50 && a[2] === 0x4e && a[3] === 0x47;
  }

  function isJpeg(buf) {
    if (buf.byteLength < 3) return false;
    const a = new Uint8Array(buf, 0, 3);
    return a[0] === 0xff && a[1] === 0xd8 && a[2] === 0xff;
  }

  /* 浏览器给的是 ArrayBuffer，Node 里常直接给 Buffer —— 统一成 ArrayBuffer，
     否则 DataView 会报 "First argument to DataView constructor must be an ArrayBuffer" */
  function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    throw new TypeError("需要 ArrayBuffer 或 Uint8Array，收到 " + Object.prototype.toString.call(input));
  }

  /* ============================ PNG chunk ============================ */

  function readPngTextChunks(buf) {
    const view = new DataView(buf);
    const out = {};
    let off = 8; // 跳过 PNG signature

    while (off + 12 <= buf.byteLength) {
      const len = view.getUint32(off);
      const type = asciiFrom(u8(buf, off + 4, 4), 0, 4);
      if (type === "IEND") break;

      const dataOff = off + 8;
      if (dataOff + len > buf.byteLength) break;

      if (type === "tEXt") {
        const d = u8(buf, dataOff, len);
        const z = indexOfByte(d, 0);
        if (z > 0) out[LATIN1.decode(d.subarray(0, z))] = LATIN1.decode(d.subarray(z + 1));
      } else if (type === "iTXt") {
        // keyword \0 compFlag compMethod langTag \0 translatedKeyword \0 text(utf8)
        const d = u8(buf, dataOff, len);
        const z1 = indexOfByte(d, 0);
        if (z1 > 0) {
          const key = LATIN1.decode(d.subarray(0, z1));
          const compFlag = d[z1 + 1];
          let p = z1 + 3;
          const z2 = indexOfByte(d, 0, p);
          if (z2 >= 0) p = z2 + 1;
          const z3 = indexOfByte(d, 0, p);
          if (z3 >= 0) p = z3 + 1;
          if (!compFlag) out[key] = UTF8.decode(d.subarray(p));
        }
      }
      off = dataOff + len + 4; // 尾部还有 4 字节 CRC
    }
    return out;
  }

  /* ============================ JPEG EXIF ============================ */

  function decodeUserComment(arr) {
    let body = arr;
    let charset = "ascii";
    if (arr.length > 8) {
      const head = asciiFrom(arr, 0, 8);
      if (head.startsWith("UNICODE")) { charset = "utf16"; body = arr.subarray(8); }
      else if (head.startsWith("ASCII")) { charset = "ascii"; body = arr.subarray(8); }
      else if (head.startsWith("JIS")) { charset = "ascii"; body = arr.subarray(8); }
      // 没有字符集标识就整段当正文
    }
    let s;
    if (charset === "utf16") {
      try { s = UTF16LE.decode(body); } catch (e) { s = LATIN1.decode(body); }
    } else {
      s = LATIN1.decode(body);
    }
    return s.replace(/\0+$/g, "").trim();
  }

  function readTiffUserComment(buf, tiffStart) {
    const view = new DataView(buf);
    const bo = view.getUint16(tiffStart);
    const le = bo === 0x4949;
    if (!le && bo !== 0x4d4d) return null;

    const rd16 = (o) => view.getUint16(tiffStart + o, le);
    const rd32 = (o) => view.getUint32(tiffStart + o, le);
    if (rd16(2) !== 0x2a) return null;

    const visited = new Set();
    let found = null;

    const scan = (ifdOff) => {
      if (!ifdOff || visited.has(ifdOff) || found) return;
      visited.add(ifdOff);
      const n = rd16(ifdOff);
      if (n <= 0 || n > 800) return;

      for (let i = 0; i < n && !found; i++) {
        const e = ifdOff + 2 + i * 12;
        const tag = rd16(e);
        if (tag === 0x9286) { // UserComment
          const cnt = rd32(e + 4);
          const valOff = cnt > 4 ? rd32(e + 8) : e + 8;
          const start = tiffStart + valOff;
          const take = Math.min(cnt, Math.max(0, buf.byteLength - start));
          if (take > 0) found = decodeUserComment(u8(buf, start, take));
        } else if (tag === 0x8769) { // ExifIFD
          scan(rd32(e + 8));
        }
      }
      if (!found) scan(rd32(ifdOff + 2 + n * 12));
    };

    scan(rd32(4));
    return found;
  }

  function readJpegExif(buf) {
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= buf.byteLength) {
      if (view.getUint8(off) !== 0xff) break;
      const marker = view.getUint8(off + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xda) break; // 到图像数据了
      const segLen = view.getUint16(off + 2);
      if (segLen < 2) break;
      /* 循环条件只保证能读到 off+3。APP1 段是 `FF E1 len(2) "Exif\0\0"`，
         读那 4 个字节需要 off+8 才够 —— 截断的 JPEG 直接抛 RangeError，
         会绕过下面那套 warnings 机制。 */
      if (marker === 0xe1 && off + 8 <= buf.byteLength
          && asciiFrom(u8(buf, off + 4, 4), 0, 4) === "Exif") {
        const tiffAt = off + 10;              // "Exif\0\0" 之后是 TIFF 头
        return tiffAt < buf.byteLength ? readTiffUserComment(buf, tiffAt) : null;
      }
      off += 2 + segLen;
    }
    return null;
  }

  /* ============================ A1111 文本 ============================ */

  function splitParamLine(line) {
    // 按逗号切，但引号里的逗号不切（Lora hashes: "a: h1, b: h2"）
    const parts = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuote = !inQuote;
      if (ch === "," && !inQuote) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur);

    const out = {};
    for (const p of parts) {
      const i = p.indexOf(":");
      if (i < 0) continue;
      const k = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  function looksLikeA1111(text) {
    return typeof text === "string"
      && (text.indexOf("Steps:") >= 0 || text.indexOf("Negative prompt:") >= 0);
  }

  function parseA1111(text) {
    const negMark = "Negative prompt:";
    const negIdx = text.indexOf(negMark);

    const head = negIdx >= 0 ? text.slice(0, negIdx) : text;
    const rest = negIdx >= 0 ? text.slice(negIdx + negMark.length) : "";

    // 参数行从最后一个 "Steps:" 起（提示词里可能正好含这几个字）。
    // 没有 Negative prompt 时参数行会落在前半段，所以要两边都找。
    const stepsInRest = rest.lastIndexOf("Steps:");
    const stepsInHead = head.lastIndexOf("Steps:");

    if (stepsInRest >= 0) {
      return {
        positive: head.trim(),
        negative: rest.slice(0, stepsInRest).trim().replace(/[,\s]+$/, ""),
        params: splitParamLine(rest.slice(stepsInRest)),
      };
    }
    if (stepsInHead >= 0) {
      return {
        positive: head.slice(0, stepsInHead).trim().replace(/[,\s]+$/, ""),
        negative: rest.trim(),
        params: splitParamLine(head.slice(stepsInHead)),
      };
    }
    return { positive: head.trim(), negative: rest.trim(), params: {} };
  }

  /* ============================ ComfyUI ============================ */

  function baseName(p) {
    const s = String(p || "").replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function stripExt(name) {
    return String(name || "").replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "");
  }

  /* 从节点输入里把 LoRA 全部挖出来。
     LoRA 节点种类太多：官方的 LoraLoader / LoraLoaderModelOnly 用 inputs.lora_name；
     rgthree 的 Power Lora Loader 把每个 LoRA 放成 inputs.lora_1 = {lora, strength}；
     还有插件用别的字段名。所以这里不光认标准写法，还会递归找任何形如
     "lora*": "xxx.safetensors" 的键值，尽量不漏。 */
  function harvestLoras(inputs, out) {
    if (!inputs || typeof inputs !== "object") return;

    const push = (rawName, weight) => {
      const file = baseName(String(rawName));
      if (!file) return;
      out.push({
        name: stripExt(file),
        file: file,
        weight: typeof weight === "number" ? weight : 1,
        hash: "",
      });
    };

    /* 标准写法 */
    if (typeof inputs.lora_name === "string") {
      push(inputs.lora_name, inputs.strength_model);
    }

    /* 递归兜底 */
    const walk = (obj, keyHint) => {
      if (!obj || typeof obj !== "object") return;
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string") {
          const looksLikeFile = /\.(safetensors|ckpt|pt|pth|bin)$/i.test(val);
          if (looksLikeFile && /lora/i.test(key)) {
            push(val, obj.strength !== undefined ? obj.strength : obj.strength_model);
          } else if (looksLikeFile && /lora/i.test(String(keyHint || ""))) {
            push(val, obj.strength);
          }
        } else if (val && typeof val === "object" && !Array.isArray(val)) {
          walk(val, key);
        }
      }
    };
    walk(inputs, "");
  }

  function parseComfyPrompt(obj) {
    // API 格式：{ "3": {class_type, inputs}, ... }
    const nodes = {};
    for (const [id, node] of Object.entries(obj || {})) {
      if (node && typeof node === "object" && node.class_type) nodes[id] = node;
    }
    if (!Object.keys(nodes).length) return null;

    const result = { positive: "", negative: "", checkpoint: null, loras: [], params: {} };

    const textOf = (ref) => {
      // ref 形如 ["6", 0]
      if (!Array.isArray(ref)) return null;
      const node = nodes[String(ref[0])];
      if (!node) return null;
      const t = node.inputs && node.inputs.text;
      return typeof t === "string" ? t : null;
    };

    for (const node of Object.values(nodes)) {
      const ct = String(node.class_type || "");
      const inputs = node.inputs || {};

      if (/^(KSampler|KSamplerAdvanced|SamplerCustom)/.test(ct)) {
        const p = textOf(inputs.positive);
        const n = textOf(inputs.negative);
        if (p && !result.positive) result.positive = p;
        if (n && !result.negative) result.negative = n;
        for (const k of ["steps", "cfg", "seed", "sampler_name", "scheduler", "denoise"]) {
          if (inputs[k] !== undefined && result.params[k] === undefined) result.params[k] = inputs[k];
        }
      }

      if (/CheckpointLoader/.test(ct)) {
        const name = inputs.ckpt_name || inputs.checkpoint;
        if (name && !result.checkpoint) {
          result.checkpoint = { name: stripExt(baseName(name)), file: baseName(name), hash: "" };
        }
      }

      if (/lora/i.test(ct)) harvestLoras(inputs, result.loras);

      if (ct === "CLIPTextEncode" && typeof inputs.text === "string" && !result.positive) {
        // 兜底：没从 KSampler 关联上时，先记第一条
        result.fallbackTexts = result.fallbackTexts || [];
        result.fallbackTexts.push(inputs.text);
      }
    }

    if (!result.positive && result.fallbackTexts && result.fallbackTexts.length) {
      result.positive = result.fallbackTexts[0];
    }
    delete result.fallbackTexts;

    // 去重 LoRA
    const seen = new Set();
    result.loras = result.loras.filter((l) => {
      const k = l.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return result;
  }

  /* ============================ NovelAI ============================ */

  function parseNovelAI(obj) {
    const result = { positive: "", negative: "", checkpoint: null, loras: [], params: {} };
    result.positive = String(obj.prompt || obj.input || "").trim();
    result.negative = String(obj.uc || obj.negative_prompt || "").trim();
    const model = obj.model || obj.model_name;
    if (model) result.checkpoint = { name: stripExt(baseName(model)), hash: String(obj.model_hash || "") };
    for (const k of ["steps", "scale", "seed", "sampler", "width", "height"]) {
      if (obj[k] !== undefined) result.params[k] = obj[k];
    }
    // NAI 的 v4/v5 提示词里可能带 <lora:...>
    result.loras = extractLorasFromText(result.positive, {});
    return result;
  }

  /* ============================ LoRA 提取 ============================ */

  function extractLorasFromText(text, params) {
    const map = new Map();

    const re = /<lora:([^:>]+)(?::([\d.]+))?>/gi;
    let m;
    while ((m = re.exec(text || ""))) {
      const name = baseName(m[1].trim());
      map.set(name.toLowerCase(), { name: stripExt(name), file: name, weight: m[2] ? parseFloat(m[2]) : 1, hash: "" });
    }

    // A1111 的 Lora hashes: "名: hash, 名: hash" —— 值被引号包着，先剥掉再切
    const lhRaw = params && params["Lora hashes"];
    if (lhRaw) {
      const lh = String(lhRaw).trim().replace(/^["']|["']$/g, "");
      for (const chunk of lh.split(",")) {
        const i = chunk.lastIndexOf(":");
        if (i < 0) continue;
        const rawName = chunk.slice(0, i).trim().replace(/^["']|["']$/g, "");
        const hash = chunk.slice(i + 1).trim().replace(/^["']|["']$/g, "");
        const name = baseName(rawName);
        const key = name.toLowerCase();
        const cur = map.get(key);
        if (cur) cur.hash = hash;
        else map.set(key, { name: stripExt(name), file: name, weight: 1, hash });
      }
    }
    return [...map.values()];
  }

  /* ============================ 统一入口 ============================ */

  function parseImage(buffer) {
    const result = {
      format: "",
      source: "unknown",
      positive: "",
      negative: "",
      checkpoint: null,
      loras: [],
      params: {},
      raw: {},
      warnings: [],
    };

    let meta = {};
    try {
      buffer = toArrayBuffer(buffer);
    } catch (e) {
      result.warnings.push(e.message);
      return result;
    }

    if (isPng(buffer)) {
      result.format = "png";
      try {
        meta = readPngTextChunks(buffer);
      } catch (e) {
        result.warnings.push("PNG 文本块读坏了：" + e.message);
        return result;
      }
    } else if (isJpeg(buffer)) {
      result.format = "jpeg";
      let uc = null;
      try {
        uc = readJpegExif(buffer);
      } catch (e) {
        /* 截断/损坏的 JPEG 会让 EXIF 段越界访问抛 RangeError。转成 warning，
           别让异常从 parseImage 里逃出去 —— 调用方期待的是"带 warnings 的结果"，
           不是抛错。 */
        result.warnings.push("JPEG 元数据段读坏了：" + e.message);
        return result;
      }
      if (uc) meta.parameters = uc;
    } else {
      result.warnings.push("只认 PNG 和 JPEG，这张图读不出元数据");
      return result;
    }
    result.raw = meta;

    const keys = Object.keys(meta);
    if (!keys.length) {
      result.warnings.push("图片里没有内嵌生成参数（可能被平台抹掉了）");
      return result;
    }

    /* --- A1111：parameters 文本 --- */
    if (looksLikeA1111(meta.parameters)) {
      const a = parseA1111(meta.parameters);
      result.source = "a1111";
      result.positive = a.positive;
      result.negative = a.negative;
      result.params = a.params;
      const modelName = a.params["Model"];
      const modelHash = a.params["Model hash"];
      if (modelName || modelHash) {
        result.checkpoint = {
          name: stripExt(baseName(modelName || "")),
          file: modelName || "",
          hash: String(modelHash || "").replace(/^0x/i, "").toLowerCase(),
        };
      }
      result.loras = extractLorasFromText(a.positive, a.params);
      return result;
    }

    /* --- ComfyUI：prompt / workflow chunk --- */
    const comfyRaw = meta.prompt || meta.workflow;
    if (comfyRaw) {
      let obj = null;
      try { obj = JSON.parse(comfyRaw); } catch (e) { /* 忽略 */ }
      if (obj) {
        let c = parseComfyPrompt(obj.nodes ? {} : obj); // prompt 是对象；workflow 里是 nodes 数组，另行处理
        if (!c && Array.isArray(obj.nodes)) c = parseComfyWorkflow(obj);
        if (c) {
          result.source = "comfyui";
          result.positive = c.positive;
          result.negative = c.negative;
          result.checkpoint = c.checkpoint;
          result.loras = c.loras;
          result.params = c.params;
          // ComfyUI 的提示词里也可能写 <lora:...>
          const extra = extractLorasFromText(c.positive, {});
          for (const l of extra) {
            if (!result.loras.some((x) => x.name.toLowerCase() === l.name.toLowerCase())) result.loras.push(l);
          }
          return result;
        }
      }
    }

    /* --- NovelAI：Comment chunk --- */
    if (meta.Comment) {
      let obj = null;
      try { obj = JSON.parse(meta.Comment); } catch (e) { /* 忽略 */ }
      if (obj && (obj.prompt !== undefined || obj.uc !== undefined)) {
        const n = parseNovelAI(obj);
        result.source = "novelai";
        result.positive = n.positive;
        result.negative = n.negative;
        result.checkpoint = n.checkpoint;
        result.loras = n.loras;
        result.params = n.params;
        return result;
      }
    }

    result.warnings.push("认不出这是哪种生成器写的元数据（见过：" + keys.join(", ") + "）");
    return result;
  }

  /* workflow（UI 格式）兜底解析：widgets_values 按节点类型猜 */
  function parseComfyWorkflow(workflow) {
    const result = { positive: "", negative: "", checkpoint: null, loras: [], params: {} };
    for (const n of workflow.nodes || []) {
      const type = String(n.type || "");
      const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
      if (/CheckpointLoader/.test(type) && wv[0]) {
        result.checkpoint = { name: stripExt(baseName(wv[0])), file: baseName(wv[0]), hash: "" };
      } else if (/lora/i.test(type)) {
        harvestLoras(n.inputs || n, result.loras);
      } else if (type === "CLIPTextEncode" && typeof wv[0] === "string") {
        // 常规模板里第一个是正向、第二个是负向
        if (!result.positive) result.positive = wv[0];
        else if (!result.negative) result.negative = wv[0];
      } else if (/^KSampler/.test(type)) {
        result.params.steps = wv[2];
        result.params.cfg = wv[3];
        result.params.sampler_name = wv[4];
        result.params.seed = wv[1];
      }
    }
    const seen = new Set();
    result.loras = result.loras.filter((l) => {
      const k = l.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return result;
  }

  return {
    parseImage,
    parseA1111,
    parseComfyPrompt,
    parseNovelAI,
    extractLorasFromText,
    readPngTextChunks,
    readJpegExif,
    _internal: { isPng, isJpeg, stripExt, baseName },
  };
});
