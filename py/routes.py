"""aiohttp 路由：把本地法典数据喂给前端，并伺服离线站点。

数据全在本地，不联网。这里做三件事：
  1. 给前端提供法典目录与随机抽词（浏览器读不了本地磁盘，得走后端）
  2. 把离线站点整目录伺服出去，供节点上的小窗直接打开（同源，不联网）
  3. 统一 JSON 编码，中文原样返回
"""

from __future__ import annotations

import base64
import json
import os
import random
import shutil
import threading
import time
import urllib.request
from functools import partial
from pathlib import Path

from aiohttp import web

try:
    from server import PromptServer
except ImportError:  # 脱离 ComfyUI 环境（比如跑单元测试）时
    PromptServer = None

from . import store
from .nodes import CODEX_ANY, SYNTAX_OPTIONS

_DUMPS = partial(json.dumps, ensure_ascii=False)


def _json(data, status: int = 200):
    return web.json_response(data, status=status, dumps=_DUMPS)


# ---------------------------------------------------------------------------
# 在线法典数据
#
# 窗口的正面就是线上站点，本地那份站点副本（data/ 词库 + images/ 配图）已经删掉了。
# 但「随机提示词」还得能抽词，所以这里直接读线上那份数据 —— 它挂在 CDN 上、
# 带 Access-Control-Allow-Origin: *，本来就是给外部取的。
#
# 取数链（四跳，逐跳按需，不预先全下）：
#   data-source.json          基址 + 指针文件名
#   → current.json            当前发布号（站点每次更新都会换）
#   → releases/<发布号>/codexes.json        法典清单
#   → releases/<发布号>/<法典id>.json        词条（用到哪部才拉哪部）
#
# 一律不落盘，只放内存。发布号一变（站点更新过）就整个作废重取 ——
# 不然会拿着上一版的词条当最新，而且自己还不知道。
# ---------------------------------------------------------------------------

ONLINE_SOURCE = "https://novelai.quicktagcloud.com/data-source.json"

# 画师词典的 id 前缀。全集随机时默认跳过它们 —— 词典里通篇是画师 tag，
# 一条"某某画师"的权重抵得上一整套普通词，混进来会让结果高度集中在某个画风上，
# 而不是"场景 / 构图 / 服装"那种多样化抽法。想要就切下拉，明确指定时照抽。
ARTIST_CODEX_PREFIX = "artist_"

_ONLINE_TTL = 1800          # 发布指针半小时查一次就够，站点不会这么勤地发版
_online_lock = threading.Lock()
_online = {
    "at": 0.0,
    "release": "",
    "base": "",
    "codexes": None,
    "entries": {},          # codex_id -> entries 列表
}


def _http_json(url, timeout=30):
    with _http_get(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _online_base(force: bool = False) -> tuple[str, str]:
    """拿当前发布号的基址，返回 (base, release)。"""
    now = time.time()
    with _online_lock:
        if not force and _online["base"] and now - _online["at"] < _ONLINE_TTL:
            return _online["base"], _online["release"]

    src = _http_json(ONLINE_SOURCE)
    base_url = str(src.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("data-source.json 里没有 baseUrl")
    pointer = str(src.get("pointer") or "current.json")
    cur = _http_json("{}/{}".format(base_url, pointer))
    release = str(cur.get("release") or "")
    if not release:
        raise RuntimeError("{} 里没有 release".format(pointer))

    base = "{}/releases/{}".format(base_url, release)
    with _online_lock:
        if _online["release"] != release:
            # 站点发了新版：上一版的词条缓存全部作废
            _online["entries"] = {}
            _online["codexes"] = None
        _online.update({"at": now, "release": release, "base": base})
    return base, release


def _online_codexes(force: bool = False) -> list:
    base, _ = _online_base(force=force)
    with _online_lock:
        if not force and _online["codexes"]:
            return _online["codexes"]

    data = _http_json(base + "/codexes.json")
    if not isinstance(data, list):
        raise RuntimeError("codexes.json 不是列表")
    with _online_lock:
        _online["codexes"] = data
    return data


def _online_entries(codex_id: str) -> list:
    """某部法典的全部词条，只有第一次要联网。"""
    base, _ = _online_base()
    with _online_lock:
        hit = _online["entries"].get(codex_id)
        if hit is not None:
            return hit

    data = _http_json("{}/{}.json".format(base, codex_id), timeout=90)
    entries = [e for e in (data.get("entries") or []) if isinstance(e, dict)]
    with _online_lock:
        _online["entries"][codex_id] = entries
    return entries


def _short(meta: dict) -> dict:
    cid = str(meta.get("id") or "")
    return {
        "id": cid,
        "title": meta.get("title") or cid,
        # 线上清单里没有 nsfw 字段，R18 法典按 id 后缀认（suozhang_r18 / mengshen_r18）
        "nsfw": cid.endswith("_r18"),
        "entryCount": meta.get("entryCount") or 0,
        "version": meta.get("version") or "",
    }


async def _handle_codexes(request):
    try:
        codexes = _online_codexes(force=request.query.get("refresh") == "1")
        _, release = _online_base()
    except Exception as exc:   # noqa: BLE001
        return _json({"ok": False, "error": "取线上法典清单失败：{}".format(exc)}, 502)

    return _json({
        "ok": True,
        "online": True,
        "site": ONLINE_SOURCE,
        "release": release,
        "syntaxOptions": SYNTAX_OPTIONS,
        "anyLabel": CODEX_ANY,
        "codexes": [_short(m) for m in codexes if isinstance(m, dict) and m.get("id")],
    })


def _entry_payload(codex_id: str, entry: dict, meta: dict | None = None,
                   codex_title: str = "") -> dict:
    """把一条线上词条整理成前端要的形状。

    线上只有一份原文：`tags` 和 `negative` 都是 NAI 语法（带 1.3::…:: 这种权重）。
    A1111 那一版由前端用现成的转换函数就地生成 —— 这里不做两份，
    也就不会出现"框里是 A1111、切一下就变样"的两边不同步。
    """
    return {
        "codex": codex_id,
        "codexTitle": (meta or {}).get("title") or codex_title or codex_id,
        "nsfw": bool((meta or {}).get("nsfw")),
        "id": entry.get("id") or "",
        "title": entry.get("title") or "",
        "nai": entry.get("tags") or "",
        "negative": entry.get("negative") or "",
        "path": entry.get("path") or [],
        "isNew": bool(entry.get("isNew")),
    }


async def _handle_random(request):
    wanted = (request.query.get("codex") or CODEX_ANY).strip()
    include_nsfw = (request.query.get("nsfw") or "").lower() in ("1", "true", "yes")

    try:
        metas = [_short(m) for m in _online_codexes()
                 if isinstance(m, dict) and m.get("id")]
    except Exception as exc:   # noqa: BLE001
        return _json({"ok": False, "error": "取线上法典清单失败：{}".format(exc)}, 502)

    if not wanted or wanted == CODEX_ANY:
        # 全部法典模式下默认跳过画师词典（artist_*）：那种词典通篇是画师 tag，
        # 一条"某某画师"混进随机结果里，人像风格会被整片带偏，跟抽到普通词条的
        # 感觉完全两码事。想从画师词典抽，就把节点上的「法典来源」切到那一部 ——
        # 明确指定时不受这条影响（见下面的 else 分支）。
        pool = [m for m in metas
                if not m["id"].startswith(ARTIST_CODEX_PREFIX)
                and (include_nsfw or not m["nsfw"])]
        if not pool:
            # 只剩画师词典可选时不要把用户堵死，退回全集照样能抽
            pool = [m for m in metas if include_nsfw or not m["nsfw"]]
    else:
        pool = [m for m in metas if m["id"] == wanted]
        if not pool:
            return _json({"ok": False, "error": "线上没有这部法典：{}".format(wanted)}, 404)

    if not pool:
        return _json({"ok": False, "error": "没有可用的法典（可能都被 R18 过滤掉了）"}, 404)

    # 多法典时先随机挑一部，再随机挑一条，避免总从同一本里抽
    pick = random.choice(pool)
    codex_id = pick["id"]
    try:
        entries = [e for e in _online_entries(codex_id)
                   if str(e.get("tags") or "").strip()]
    except Exception as exc:   # noqa: BLE001
        return _json({"ok": False, "error": "取词条失败：{}".format(exc)}, 502)

    if not entries:
        return _json({"ok": False, "error": "「{}」里没有可用词条".format(pick["title"])}, 404)

    payload = _entry_payload(codex_id, random.choice(entries), pick)
    payload["ok"] = True
    return _json(payload)


# ---------------------------------------------------------------------------
# 我的图库：浏览器不能凭一个磁盘路径直接写文件（安全模型决定的），所以交给后端落盘。
# 目录固定为站点里的 self-image/，与词库的 images/ 分开。
# ---------------------------------------------------------------------------

_SELF_DIR_NAME = "self-image"

# 这几个名字在 self-image/ 里有特殊用途，绝不能被当成图片文件名写进去 ——
# 一张叫 index.js 的"图"会把索引本身覆盖成 PNG 字节，整个图库当场报废，
# 而且后面每次读写索引都会炸。撞上了就改名，不拒绝。
_RESERVED_NAMES = {"index.js", "index.js.bak", "delete-log.txt", "index.js.tmp"}

# 索引的改动都是「读出来 → 改 → 写回去」。aiohttp 是单进程多连接，两个请求
# 同时进来时后写的会把先写的整个覆盖掉 —— 连存两张图只留一张。
# 临界区里必须全是同步代码（_read/_write 都不 await），否则会卡住事件循环。
_INDEX_LOCK = threading.Lock()


def _self_image_dir() -> Path:
    directory = store.ATLAS_DIR / _SELF_DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _append_delete_log(directory: Path, entry: str) -> None:
    """把每次删除记一行流水。

    删图不可逆，出现过「图没了但不知道谁删的」的情况。留个流水，
    下次看时间 + 来源就能对上是谁点的。
    """
    try:
        with (directory / "delete-log.txt").open("a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  " + entry + "\n")
    except OSError:
        pass


def _clean_header(value, limit: int = 200) -> str:
    """请求头里塞进换行就能往日志里插伪造行，先把控制字符掐掉。"""
    return "".join(ch for ch in str(value or "") if ch >= " " or ch == "\t")[:limit]


def _safe_filename(name) -> str:
    """只取文件名本身，挡掉路径分隔符、Windows 非法字符和保留名。

    前端那边写索引时用的是同一套规则 —— 两边写出来的文件名要能互相认，
    否则「存的时候叫 A、读的时候找 B」，图就凭空不见了。
    """
    base = os.path.basename(str(name or "").replace("\\", "/")).strip()
    base = "".join(ch for ch in base if ch not in '<>:"/\\|?*' and ord(ch) >= 32)
    if not base:
        return "untitled.png"
    if base.lower() in _RESERVED_NAMES:
        return "image_" + base
    return base


def _parse_index_text(text: str):
    """从索引文件文本里切出数组并解析，返回 (entries, ok)。

    不能用 /window\\.SELF_META\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;/ 这种非贪婪正则 ——
    只要某条记录的提示词或文件名里出现 `];`（比如提示词写了 `[artist:foo];`），
    捕获就会在那里提前断掉，JSON 必然解析失败，接着整份索引会被当成空的。
    改成从左定位开头、从右定位结尾，取中间那一段。
    """
    start = text.find("window.SELF_META")
    if start < 0:
        return None, False
    open_idx = text.find("[", start)
    close_idx = text.rfind("]")
    if open_idx < 0 or close_idx <= open_idx:
        return None, False
    try:
        return json.loads(text[open_idx:close_idx + 1]), True
    except json.JSONDecodeError:
        return None, False


def _index_state(directory: Path):
    """读索引，返回 (entries, ok)。

    ok=False 表示"文件在那里，但读不出来"（编码坏了 / 格式坏了）。
    这种情况**绝不能当成空索引继续往下写** —— 下一步就是把已有记录全抹掉、
    再用新内容覆盖索引文件，等于永久损坏。宁可这次请求直接失败。

    注意 UnicodeDecodeError 不是 OSError 的子类，漏了它整个接口会 500。
    """
    path = directory / "index.js"
    if not path.is_file():
        return [], True                       # 还没建索引，是正常状态
    try:
        text = path.read_text("utf-8")
    except (OSError, UnicodeError):
        return [], False
    data, ok = _parse_index_text(text)
    if not ok or not isinstance(data, list):
        return [], False
    return data, True


def _read_self_index(directory: Path) -> list:
    return _index_state(directory)[0]


def _write_self_index(directory: Path, entries: list) -> None:
    """索引写成一份 js 文件（`window.SELF_META = [...]`），页面直接当脚本加载。

    落笔之前先把旧的那份留成 index.js.bak —— 索引本身不大，却是图库里
    唯一记着「这张图是什么底模 / 哪些 LoRA 出的」的地方。真被清空了，
    还能照着 .bak 把记录找回来，不用重新解析每一张图。
    """
    path = directory / "index.js"
    if path.is_file():
        try:
            shutil.copyfile(path, directory / "index.js.bak")
        except OSError:
            pass  # 备份失败不该挡住正常写入
    text = (
        "/* 我的图库索引 — 由「我的图库」页面写入，勿手改 */\n"
        "window.SELF_META = " + json.dumps(entries, ensure_ascii=False, indent=1) + ";\n"
    )
    # 先写临时文件再原子替换：直接 write_text 的话，另一条线程正好在读，
    # 就会读到写了一半的文件（JSON 断在中间），然后被当成损坏索引。
    # 临时名带上 pid 和线程 id。固定叫 index.js.tmp 的话，用户上传一张
    # 同名"图片"会正好落在这个位置，随后被索引覆盖、再改名成 index.js ——
    # 提示是"保存成功"，图却没了，索引里还留下一条指向不存在文件的死记录。
    tmp = path.with_name(f"index.js.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text, "utf-8")
    os.replace(tmp, path)


async def _handle_self_image_save(request):
    """存一张图：原图 + 索引。

    前端优先打这个接口 —— 后端跑在本机，本来就知道站点目录在哪，
    不需要用户选文件夹（网页直接写磁盘路径是被安全模型禁止的）。
    """
    try:
        payload = await request.json()
    except Exception:
        return _json({"ok": False, "error": "请求体不是合法 JSON"}, 400)

    name = _safe_filename(payload.get("file"))
    b64 = payload.get("data") or ""
    meta = payload.get("meta") or {}
    group = str(payload.get("group") or "").strip()

    if not b64:
        return _json({"ok": False, "error": "没带图片数据"}, 400)

    try:
        # validate=True：默认模式下非法字符会被悄悄忽略，解出空字节也不报错
        raw = base64.b64decode(b64, validate=True)
    except Exception as exc:
        return _json({"ok": False, "error": f"base64 解不开：{exc}"}, 400)

    if not raw:
        return _json({"ok": False, "error": "图片数据是空的"}, 400)

    # 光"非空"不够：一个 1 字节的文件也能过。按文件头确认真是图片，
    # 免得图库里混进打不开的垃圾条目（点开详情一片空白，还占着索引）。
    if _sniff_image_mime(bytes(raw[:12])) is None:
        return _json({
            "ok": False,
            "error": "这不是 PNG / JPEG / WebP / GIF —— 文件头对不上，没有保存",
        }, 400)

    directory = _self_image_dir()
    try:
        (directory / name).write_bytes(raw)
    except OSError as exc:
        return _json({"ok": False, "error": f"写图片失败：{exc}"}, 500)

    entry = {
        "file": name,
        "title": Path(name).stem,
        "size": len(raw),
        "addedAt": int(time.time()),
        "meta": meta,
    }
    if group:
        entry["group"] = group

    with _INDEX_LOCK:
        entries, ok = _index_state(directory)
        if not ok:
            return _json({
                "ok": False,
                "error": "图库索引读不出来（文件可能坏了）—— 这次保存先停下，"
                         "免得把已有记录一起冲掉。可以拿 index.js.bak 对照修复。",
            }, 500)
        idx = next((i for i, e in enumerate(entries)
                    if isinstance(e, dict) and e.get("file") == name), -1)
        if idx >= 0:
            entries[idx] = entry
        else:
            entries.append(entry)

        try:
            _write_self_index(directory, entries)
        except OSError as exc:
            return _json({"ok": False, "error": f"写索引失败：{exc}"}, 500)

    return _json({"ok": True, "file": name, "total": len(entries), "dir": str(directory)})


async def _handle_self_image_group(request):
    """把某张图挪到某个分组（分组名就是索引里的一条字段，空串 = 未分组）。

    分组只是索引里的元信息，不动磁盘上的图片文件；前端在写不进索引时会
    先在本机 localStorage 里记住，等这个接口可用再收敛回来。
    """
    try:
        payload = await request.json()
    except Exception:
        return _json({"ok": False, "error": "请求体不是合法 JSON"}, 400)

    name = _safe_filename(payload.get("file"))
    group = str(payload.get("group") or "").strip()

    directory = _self_image_dir()
    with _INDEX_LOCK:
        entries, ok = _index_state(directory)
        if not ok:
            return _json({
                "ok": False,
                "error": "图库索引读不出来（文件可能坏了）—— 这次分组先停下，"
                         "免得把已有记录一起冲掉。",
            }, 500)
        target = next((e for e in entries
                       if isinstance(e, dict) and e.get("file") == name), None)
        if target is None:
            return _json({"ok": False, "error": f"索引里没有这张图：{name}"}, 404)

        if group:
            target["group"] = group
        else:
            target.pop("group", None)

        try:
            _write_self_index(directory, entries)
        except OSError as exc:
            return _json({"ok": False, "error": f"写索引失败：{exc}"}, 500)

    groups = sorted({e.get("group") for e in entries if isinstance(e, dict) and e.get("group")})
    return _json({"ok": True, "file": name, "group": group, "groups": groups})


async def _handle_self_image_delete(request):
    """把一张图从图库删掉（原图 + 索引记录）。

    默认 keepFile=False：原图一起删。前端在调这个接口之前会弹一个模态警告框 ——
    unlink 在 Windows 上不进回收站，删错了没法找回，所以确认这一步必须在。
    传 keepFile=true 可以只摘索引、把文件留在原地。
    """
    try:
        payload = await request.json()
    except Exception:
        return _json({"ok": False, "error": "请求体不是合法 JSON"}, 400)

    name = _safe_filename(payload.get("file"))
    keep_file = payload.get("keepFile")
    keep_file = False if keep_file is None else bool(keep_file)
    directory = _self_image_dir()

    target = _resolve_under(directory, name)  # 只允许动自己目录里的文件
    if target is None:
        return _json({"ok": False, "error": "文件名不合法"}, 400)

    removed = False
    if not keep_file and target.is_file():
        try:
            target.unlink()
            removed = True
        except OSError as exc:
            return _json({"ok": False, "error": f"删文件失败：{exc}"}, 500)

    if removed:
        _append_delete_log(
            directory,
            "删除 " + name
            + "  | 来源 " + (_clean_header(request.headers.get("Referer")) or "（无）")
            + "  | UA " + (_clean_header(request.headers.get("User-Agent"), 70) or "（无）"),
        )
    else:
        _append_delete_log(directory, f"摘索引 {name}（文件保留或本来就不在）")

    with _INDEX_LOCK:
        entries, ok = _index_state(directory)
        if not ok:
            return _json({
                "ok": False,
                "error": "图库索引读不出来（文件可能坏了）—— 原图已按你的选择处理，"
                         "但记录没能更新。可以拿 index.js.bak 对照修复。",
            }, 500)
        entries = [e for e in entries
                   if not (isinstance(e, dict) and e.get("file") == name)]
        try:
            _write_self_index(directory, entries)
        except OSError as exc:
            return _json({"ok": False, "error": f"写索引失败：{exc}"}, 500)

    return _json({
        "ok": True,
        "removed": removed,
        "keptFile": bool(keep_file) and target.is_file(),
        "total": len(entries),
    })


def _resolve_under(root: Path, tail: str) -> Path | None:
    """把 tail 解析到 root 之下；越界（路径穿越）返回 None。"""
    if not tail:
        return None
    try:
        target = (root / tail).resolve()
        root_resolved = root.resolve()
    except OSError:
        return None
    return target if target.is_relative_to(root_resolved) else None


_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}


def _sniff_image_mime(head: bytes) -> str | None:
    """按文件头判断图片类型（纯函数，不碰文件系统）。"""
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:3] == b"GIF":
        return "image/gif"
    return None


def _sniff_mime(path: Path) -> str | None:
    """读文件头判断图片类型。

    下载时为压体积把 PNG 源图也统一转成了 JPEG，但文件名仍是 .png。
    若只按扩展名给 Content-Type，浏览器会拿到 image/png 配 JPEG 数据 ——
    多数浏览器容错，但没必要赌这个。
    """
    try:
        with path.open("rb") as fh:
            return _sniff_image_mime(fh.read(12))
    except OSError:
        return None


# 站点里会被浏览器缓存、又经常改动的资源。伺服 index.html 时给它们打上版本戳，
# 治的就是"磁盘上文件是对的、浏览器还在跑旧版"——表现成"脚本没跑起来"、
# "按钮点了没反应"，还特别难往缓存上想。
# 本地站点整个删了，只剩图库这一页要用。改动其中任何一个，页面上的版本号就跟着变，
# 免得浏览器拿着上一版的脚本把新页面跑歪（这个坑踩过：改名之后旧文件还留着，
# 缓存命中的是旧内容，看起来像"改了没生效"）。
_SITE_ASSETS = (
    "app.css", "gallery.js", "gallery-meta.js",
)


def _site_asset_stamp(root: Path) -> str:
    """拿这些文件里最新的那个修改时间当版本号。改任何一个，URL 就变。"""
    stamps = []
    for rel in _SITE_ASSETS:
        path = root / rel
        try:
            if path.is_file():
                stamps.append(int(path.stat().st_mtime))
        except OSError:
            pass
    return str(max(stamps) if stamps else 0)


def _render_gallery_page(root: Path, target: Path) -> str:
    """给图库页的脚本引用打上版本号。"""
    html = target.read_text("utf-8")
    stamp = _site_asset_stamp(root)
    for rel in _SITE_ASSETS:
        # 只动本站自己的引用，外链和已经带过参数的都不碰
        html = html.replace(f'"{rel}"', f'"{rel}?v={stamp}"')
    return html


async def _handle_atlas_static(request):
    """伺服图库页那一小块（gallery.html + app.css + gallery*.js + self-image/）。

    法典站点本身不再伺服了 —— 窗口正面是线上站点，这边只负责「我的图库」。
    """
    tail = request.match_info.get("tail", "") or "gallery.html"
    target = _resolve_under(store.ATLAS_DIR, tail)
    if target is None:
        raise web.HTTPNotFound(text="图库文件不存在")

    # 图库索引是后端存图时才生成的，新装或清空后它并不存在；而 gallery.html
    # 里有一条 <script src="self-image/index.js"> 会去加载它。
    # 真回 404 的话，页面顶部那条自检横幅会误报「脚本没加载成功」，
    # 还把人往浏览器缓存上引 —— 其实只是文件还没有。这里直接给个空索引。
    if not target.is_file() and target.name == "index.js" \
            and target.parent.name == "self-image":
        return web.Response(
            text="window.SELF_META = [];\n",
            content_type="application/javascript", charset="utf-8",
            headers={"Cache-Control": "no-store"},
        )

    if not target.is_file():
        raise web.HTTPNotFound(text="图库文件不存在")

    if target.suffix.lower() in _IMAGE_SUFFIXES:
        mime = _sniff_mime(target)
        if mime:
            # 存进图库的图不会原地改（换图是新文件名），可以放心长缓存
            return web.FileResponse(target, headers={
                "Content-Type": mime,
                "Cache-Control": "public, max-age=86400",
            })
        return web.FileResponse(target, headers={"Cache-Control": "public, max-age=86400"})

    if target.name == "gallery.html":
        return web.Response(
            text=_render_gallery_page(store.ATLAS_DIR, target),
            content_type="text/html", charset="utf-8",
            headers={"Cache-Control": "no-store"},
        )

    # 其余页面和脚本一律 no-cache（每次拿 Last-Modified 验一次，没变就 304）
    return web.FileResponse(target, headers={"Cache-Control": "no-cache"})


async def _handle_status(request):
    return _json({
        "ok": True,
        "online": True,
        "site": ONLINE_SOURCE,
        # 站点那份也返回 mode，但值是 "local-server"。前端用它决定提示哪来的后端，
        # 靠"字段缺失"做隐式分支太脆 —— 两边都显式给出自己的身份。
        "mode": "comfyui-plugin",
        # 前端靠这个判断"能不能走后端存图"，别只看到 /status 有响应就以为能存
        "features": ["self-image", "self-image-group"],
    })


def _http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "codex-atlas-online"})
    return urllib.request.urlopen(req, timeout=timeout)


def register_routes():
    """把接口挂到 ComfyUI 的 aiohttp 上。

    时机是安全的：main.py 先建 PromptServer（instance 就位）→ 加载 custom_nodes（走这里）
    → 最后才调 prompt_server.add_routes() 把 routes 收进 app。
    """
    server = getattr(PromptServer, "instance", None) if PromptServer is not None else None
    if server is None:
        # 脱离 ComfyUI（单元测试）或极端的启动顺序下不硬崩，插件其余部分照常可用
        return False
    server.routes.get("/codex_atlas/codexes")(_handle_codexes)
    server.routes.get("/codex_atlas/random")(_handle_random)
    server.routes.get("/codex_atlas/status")(_handle_status)
    server.routes.get("/codex_atlas/atlas/{tail:.*}")(_handle_atlas_static)
    server.routes.post("/codex_atlas/self-image")(_handle_self_image_save)
    server.routes.post("/codex_atlas/self-image/delete")(_handle_self_image_delete)
    server.routes.post("/codex_atlas/self-image/group")(_handle_self_image_group)
    return True


register_routes()
