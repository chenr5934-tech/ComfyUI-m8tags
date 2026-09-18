"""aiohttp 路由：把本地法典数据喂给前端，并伺服离线站点。

数据全在本地，不联网。这里做三件事：
  1. 给前端提供法典目录与随机抽词（浏览器读不了本地磁盘，得走后端）
  2. 把离线站点整目录伺服出去，供节点上的小窗直接打开（同源，不联网）
  3. 统一 JSON 编码，中文原样返回
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import shutil
import subprocess
import threading
import time
import urllib.error
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


def _short(meta: dict) -> dict:
    return {
        "id": meta.get("id"),
        "title": meta.get("title") or meta.get("id") or "",
        "nsfw": bool(meta.get("nsfw")),
        "entryCount": meta.get("entryCount") or 0,
        "version": meta.get("version") or "",
    }


async def _handle_codexes(request):
    try:
        metas = store.get_meta_list(force=request.query.get("refresh") == "1")
    except store.CodexAtlasError as exc:
        return _json({"ok": False, "error": str(exc)}, 500)

    version = store.data_version()
    return _json({
        "ok": True,
        "site": version["dir"],
        "release": version["release"],
        "publishedAt": version["publishedAt"],
        "dataMtime": version["mtimeText"],
        "hasRaw": store.raw_dir() is not None,  # 「原始 NAI」模式是否可用
        "syntaxOptions": SYNTAX_OPTIONS,
        "anyLabel": CODEX_ANY,
        "codexes": [_short(m) for m in metas if m.get("id")],
    })


def _entry_payload(codex_id: str, entry: dict, meta: dict | None = None,
                   codex_title: str = "") -> dict:
    """把一条本地词条整理成前端要的形状。

    两个语法版本都带上：data/*.js 存的是转换后的 A1111（负向压成短名 n），
    原始 NAI 写法在 raw 里按 entry id 配对，取不到就留空让前端退化。
    """
    raw = store.get_raw_tags(codex_id).get(entry.get("id") or "") or {}
    image = entry.get("img") or ""
    return {
        "codex": codex_id,
        "codexTitle": (meta or {}).get("title") or codex_title or codex_id,
        "nsfw": bool((meta or {}).get("nsfw")),
        "id": entry.get("id") or "",
        "title": entry.get("title") or "",
        "tags": entry.get("tags") or "",           # A1111
        "tagsNai": raw.get("tags") or "",           # 原始 NAI（可能为空）
        "negative": entry.get("n") or "",           # A1111
        "negativeNai": raw.get("negative") or "",
        "path": entry.get("path") or [],
        "image": image,
        "imageUrl": f"/codex_atlas/atlas/images/{codex_id}/{image}" if image else "",
        "characterPrompts": entry.get("cp") or [],
        "note": entry.get("note") or "",
        "isNew": bool(entry.get("new")),
    }


# 画师词典的 id 前缀。全集随机时默认跳过它们 —— 词典里通篇是画师 tag，
# 一条"某某画师"的权重抵得上一整套普通词，混进来会让结果高度集中在某个画风上，
# 而不是"场景 / 构图 / 服装"那种多样化抽法。想要就切下拉，明确指定时照抽。
ARTIST_CODEX_PREFIX = "artist_"


async def _handle_random(request):
    wanted = (request.query.get("codex") or CODEX_ANY).strip()
    include_nsfw = (request.query.get("nsfw") or "").lower() in ("1", "true", "yes")

    try:
        metas = store.get_meta_list()
    except store.CodexAtlasError as exc:
        return _json({"ok": False, "error": str(exc)}, 500)

    if not wanted or wanted == CODEX_ANY:
        # 全部法典模式下默认跳过画师词典（artist_*）：那种词典通篇是画师 tag，
        # 一条"某某画师"混进随机结果里，人像风格会被整片带偏，跟抽到普通词条的
        # 感觉完全两码事。想从画师词典抽，就把节点上的「法典来源」切到那一部 ——
        # 明确指定时不受这条影响（见下面的 else 分支）。
        pool = [
            m for m in metas
            if m.get("id")
            and not str(m.get("id")).startswith(ARTIST_CODEX_PREFIX)
            and (include_nsfw or not m.get("nsfw"))
        ]
        if not pool:
            # 只剩画师词典可选时不要把用户堵死，退回全集照样能抽
            pool = [m for m in metas if m.get("id") and (include_nsfw or not m.get("nsfw"))]
    else:
        pool = [m for m in metas if m.get("id") == wanted]
        if not pool:
            return _json({"ok": False, "error": f"本地没有这部法典：{wanted}"}, 404)

    if not pool:
        return _json({"ok": False, "error": "没有可用的法典（可能都被 R18 过滤掉了）"}, 404)

    # 多法典时先随机挑一部，再随机挑一条，避免总从同一本里抽
    pick = random.choice(pool)
    codex_id = pick["id"]
    try:
        data = store.get_codex(codex_id)
    except store.CodexAtlasError as exc:
        return _json({"ok": False, "error": str(exc)}, 500)

    entries = [
        e for e in (data.get("entries") or [])
        if isinstance(e, dict) and str(e.get("tags") or "").strip()
    ]
    if not entries:
        return _json({"ok": False, "error": f"「{pick.get('title') or codex_id}」里没有可用词条"}, 404)

    entry = random.choice(entries)
    payload = _entry_payload(codex_id, entry, pick)
    payload["ok"] = True
    return _json(payload)


async def _handle_entry(request):
    """按 id 取一条词条。

    小窗里点「加入已选栏」时，前端拿站点给的 codex+id 来这里补齐两个语法版本
    —— 站点自己只有 A1111 那一份。
    """
    codex_id = (request.query.get("codex") or "").strip()
    entry_id = (request.query.get("id") or "").strip()
    if not codex_id or not entry_id:
        return _json({"ok": False, "error": "需要 codex 和 id 两个参数"}, 400)

    try:
        entry = store.find_entry(codex_id, entry_id)
    except store.CodexAtlasError as exc:
        return _json({"ok": False, "error": str(exc)}, 404)

    if entry is None:
        return _json({"ok": False, "error": f"找不到词条：{codex_id}/{entry_id}"}, 404)

    metas = store.get_meta_list()
    meta = next((m for m in metas if m.get("id") == codex_id), None)
    payload = _entry_payload(codex_id, entry, meta)
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

    和站点 serve.py 里的规则保持一致 —— 两边写出来的文件名要能互相认。
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
    """索引写成跟法典 data/index.js 一个样子的 js 文件。

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
_SITE_ASSETS = (
    "app.js", "app.css", "gallery.js", "gallery-meta.js", "favs.js",
    "data/index.js",
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


def _render_site_index(root: Path, target: Path) -> str:
    html = target.read_text("utf-8")
    stamp = _site_asset_stamp(root)
    for rel in _SITE_ASSETS:
        # 只动本站自己的引用，外链和已经带过参数的都不碰
        html = html.replace(f'"{rel}"', f'"{rel}?v={stamp}"')
    return html


async def _handle_atlas_static(request):
    """伺服离线站点整目录（index.html / data / images）。"""
    tail = request.match_info.get("tail", "") or "index.html"
    target = _resolve_under(store.ATLAS_DIR, tail)
    if target is None:
        raise web.HTTPNotFound(text="法典站点文件不存在")

    # 图库索引是后端存图时才生成的，新装或清空后它并不存在；而站点的
    # index.html 里有一条 <script src="self-image/index.js"> 会去加载它。
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
        raise web.HTTPNotFound(text="法典站点文件不存在")

    if target.suffix.lower() in _IMAGE_SUFFIXES:
        mime = _sniff_mime(target)
        if mime:
            # 词库配图下载完就不动了，可以放心长缓存
            return web.FileResponse(target, headers={
                "Content-Type": mime,
                "Cache-Control": "public, max-age=86400",
            })
        return web.FileResponse(target, headers={"Cache-Control": "public, max-age=86400"})

    if target.name == "index.html":
        return web.Response(
            text=_render_site_index(store.ATLAS_DIR, target),
            content_type="text/html", charset="utf-8",
            headers={"Cache-Control": "no-store"},
        )

    # 其余页面和脚本一律 no-cache（每次拿 Last-Modified 验一次，没变就 304）
    return web.FileResponse(target, headers={"Cache-Control": "no-cache"})


async def _handle_status(request):
    version = store.data_version()
    raw = store.raw_dir()
    try:
        metas = store.get_meta_list()
        count = len(metas)
        error = None
    except store.CodexAtlasError as exc:
        count = 0
        error = str(exc)

    return _json({
        "ok": error is None,
        "error": error,
        "dir": version["dir"],
        "rawDir": version["rawDir"],
        "dataMtime": version["mtimeText"],
        "codexCount": count,
        # 站点那份也返回 mode，但值是 "local-server"。前端用它决定提示哪来的后端，
        # 靠"字段缺失"做隐式分支太脆 —— 两边都显式给出自己的身份。
        "mode": "comfyui-plugin",
        # 前端靠这个判断"能不能走后端存图"，别只看到 /status 有响应就以为能存
        "features": ["self-image", "self-image-group"],
    })


# ============================================================================
# 例图自动拉取
#
# 例图 1.3 GB，走 GitHub Release 的 7z 分卷。不该要求用户「自己下 4 个卷、装 7-Zip、
# 解压、放对位置」，所以做成一次点击：
#   1. 先找本机的 7z.exe（常见安装路径 + PATH）
#   2. 找不到就下官方那个免安装的 7zr.exe（约 588 KB）放进插件目录 ——
#      比让人装 7-Zip 轻得多，也不用管理员权限
#   3. 下齐所有卷（带断点续传），逐个校验 SHA256
#   4. 解压到 atlas/ —— -aoa 只覆盖同名文件，**不删**用户已有的任何东西
#   5. 解压完成后显式重写 images/README.txt
# ============================================================================

_REPO = "chenr5934-tech/ComfyUI-m8tags"
_RELEASE_TAG = "images-v1"
_RELEASE_BASE = "https://github.com/{}/releases/download/{}".format(_REPO, _RELEASE_TAG)
_SEVEN_ZIP_CANDIDATES = (
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
    r"D:\7z\7-Zip\7z.exe",
)
_7ZR_URL = "https://www.7-zip.org/a/7zr.exe"

# 解压完成后会把这个写进 atlas/images/README.txt。
# 为什么要显式写：atlas/images/ 在解压前就已经存在（仓库里带着这个说明文件），
# 解压是往目录里合并、不是重建，所以不能指望它随包进来。
_IMAGES_README = """配图目录
========

这里放法典卡片的配图，按法典分目录：

    images/<法典id>/<图片文件名>

由插件里的「拉取例图」下载解压而来（约 1.3 GB / 37684 张），也可以自己往里放。
没有配图也能正常用：检索、搜索、复制 tag、加入已选栏、推送到节点都不依赖图片，
卡片上显示占位块而已。

解压只会覆盖同名文件，不会删掉这个目录里别的东西。
"""

_fetch_lock = threading.Lock()
_fetch_state = {
    "stage": "idle",      # idle|checking|tool|downloading|extracting|done|error
    "message": "",
    "done": 0,
    "total": 0,
    "error": None,
    "startedAt": 0.0,
    "usedTool": "",
}
_fetch_thread = None


def _images_dir() -> Path:
    return store.ATLAS_DIR / "images"


_COUNT_TTL = 5.0
_count_cache = {"at": 0.0, "n": 0, "dir": None}


def _images_count(force: bool = False) -> int:
    """数 atlas/images/ 下的配图（不含说明文件）。

    4.5 万个文件，实测一次 rglob 要 0.45 秒；而前端每 2 秒就会来问一次
    （拉取期间靠 status 轮询进度），照原样等于让后端一直半秒半秒地翻目录。
    加个 5 秒短缓存：拉取收尾时强制重算一次，轮询期间最多 5 秒遍历一回。
    缓存带上目录路径 —— 目录一换（换 config、跑测试用的临时目录）就当没缓存。
    """
    d = _images_dir()
    now = time.time()
    if (not force and _count_cache["dir"] == str(d)
            and now - _count_cache["at"] < _COUNT_TTL):
        return _count_cache["n"]

    if not d.is_dir():
        n = 0
    else:
        n = sum(1 for p in d.rglob("*") if p.is_file() and p.name.lower() != "readme.txt")

    _count_cache.update({"at": now, "n": n, "dir": str(d)})
    return n


def _fetch_tmp_dir() -> Path:
    return store.PLUGIN_DIR / "bin" / "_fetch_tmp"


def _tmp_usage() -> dict:
    """下载缓存占了多大地方。

    失败时会故意留着已经下好的分卷（重试就不必从零再来），代价是它真的占磁盘 ——
    这是个 1.3 GB 量级的东西躺在插件目录里。用户有权看见它，也该有地方一键清掉，
    所以把占用报给前端，由提示条上的「清理下载缓存」按钮负责清。
    """
    d = _fetch_tmp_dir()
    files = 0
    total = 0
    if d.is_dir():
        for p in d.rglob("*"):
            if p.is_file():
                files += 1
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    return {"files": files, "bytes": total, "dir": str(d)}


def _set_stage(stage=None, message="", done=None, total=None, error=None):
    """刷新拉取进度。

    stage 允许省略：每下完一个分卷只推进 done 计数，阶段还是「downloading」。
    早先这里把 stage 写成了必填位置参数，`_set_stage(done=idx)` 直接抛
    TypeError —— 表现为「第一个卷下完就报拉取失败」，而下卷、校验、解压
    每个单独的步骤看起来都是好的。
    """
    with _fetch_lock:
        if stage:
            _fetch_state["stage"] = stage
        if message:
            _fetch_state["message"] = message
        if done is not None:
            _fetch_state["done"] = done
        if total is not None:
            _fetch_state["total"] = total
        if error is not None:
            _fetch_state["error"] = error


def _find_7z():
    """先找本机装的 7-Zip；都没有再看插件目录里以前下过的 7zr。"""
    for c in _SEVEN_ZIP_CANDIDATES:
        if Path(c).is_file():
            return Path(c), "本机已装 7-Zip"
    which = shutil.which("7z") or shutil.which("7za")
    if which:
        return Path(which), "PATH 里的 7z"
    local = store.PLUGIN_DIR / "bin" / "7zr.exe"
    if local.is_file():
        return local, "插件目录里已有的 7zr.exe"
    return None, ""


def _http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "codex-atlas-fetch"})
    return urllib.request.urlopen(req, timeout=timeout)


def _download(url, dest: Path):
    """流式下载 + 断点续传。先写 .part 再改名，免得半截文件被当成完整的。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.is_file() else 0

    headers = {"User-Agent": "codex-atlas-fetch"}
    if have:
        headers["Range"] = "bytes={}-".format(have)
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as exc:
        # 416「区间越界」只有一种常见成因：.part 已经装下了整个文件 ——
        # 上一次下完了、但还没走到改名就被中断（关掉 ComfyUI、断电）。
        # 这不是失败，按「下完了」处理。真假交给上层的 SHA256 判：
        # 判不过就再点一次，那时 part 已经改名走了，从头下，自愈。
        # 不加这一条的话，这里会永远 416，重试多少次都一样。
        if exc.code == 416 and have:
            os.replace(part, dest)
            return dest
        raise
    with resp:
        if have and getattr(resp, "status", 200) != 206:
            have = 0        # 服务器不认 Range，返回的是全量，那就从头写
        with part.open("ab" if have else "wb") as fh:
            while True:
                block = resp.read(1 << 20)
                if not block:
                    break
                fh.write(block)
    os.replace(part, dest)
    return dest


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _release_parts():
    """分卷名 + 校验和，取自 Release 上的 SHA256SUMS.txt（打包时生成的那份）。"""
    try:
        with _http_get("{}/SHA256SUMS.txt".format(_RELEASE_BASE), timeout=30) as r:
            text = r.read().decode("utf-8", "replace")
        parts = []
        for line in text.splitlines():
            bits = line.strip().split(None, 1)
            if len(bits) == 2:
                parts.append((bits[0], bits[1].strip()))
        if parts:
            return parts
    except Exception:   # noqa: BLE001
        pass
    # 兜底：按约定拼名字，跳过校验（总比直接失败强）
    return [("", "m8tags-images.7z.{:03d}".format(i)) for i in range(1, 5)]


def _fetch_worker():
    tmp = _fetch_tmp_dir()
    try:
        _set_stage("checking", "检查 7-Zip 与分卷清单…")

        tool, howfound = _find_7z()
        if tool is None:
            _set_stage("tool", "本机没有 7-Zip，正在下载官方免安装版（约 588 KB）…")
            tool = store.PLUGIN_DIR / "bin" / "7zr.exe"
            _download(_7ZR_URL, tool)
            howfound = "刚下载的 7zr.exe"
        with _fetch_lock:
            _fetch_state["usedTool"] = "{}（{}）".format(tool, howfound)

        parts = _release_parts()
        tmp.mkdir(parents=True, exist_ok=True)
        first = None
        for idx, (want_sha, name) in enumerate(parts, 1):
            dest = tmp / name
            if want_sha and dest.is_file() and _sha256_of(dest) == want_sha:
                # 上一轮已经下完并校验过的卷：直接用，不重下。
                # 1.3 GB 的包，失败一次就从零再来一遍太亏。
                _set_stage("downloading",
                           "已有 {}/{}：{}（跳过重下）".format(idx, len(parts), name),
                           done=idx - 1, total=len(parts))
            else:
                _set_stage("downloading",
                           "正在下载 {}/{}：{}".format(idx, len(parts), name),
                           done=idx - 1, total=len(parts))
                dest = _download("{}/{}".format(_RELEASE_BASE, name), dest)
                if want_sha:
                    got = _sha256_of(dest)
                    if got != want_sha:
                        raise RuntimeError("{} 校验不符（下载可能被截断），可以再点一次重试".format(name))
            if first is None:
                first = dest
            _set_stage(done=idx)

        _set_stage("extracting", "正在解压到 atlas/images/…")
        target = store.ATLAS_DIR
        target.mkdir(parents=True, exist_ok=True)
        # -aoa：只覆盖同名文件。7z 解压是往目标目录里合并，不会删掉别的东西 ——
        # atlas/images/ 里原有的 README.txt、用户自己放的图都不受影响。
        # 只喂第一个卷：分卷是同一个包切开的多段，7z 认了 .001 会自己去接后面的。
        cmd = [str(tool), "x", str(first), "-o{}".format(target),
               "-aoa", "-y", "-bso0", "-bsp0"]
        proc = subprocess.run(cmd, cwd=str(tmp))
        if proc.returncode != 0:
            raise RuntimeError("7z 解压失败，退出码 {}".format(proc.returncode))

        try:
            # 先建目录再写：解压包里本该带着 images/ 这一层，但那是包的内部结构，
            # 不该假设它一定在 —— 少了它 write_text 会 FileNotFoundError，
            # 然后被下面的 except 默默吞掉，说明文件就凭空不见了。
            img_dir = _images_dir()
            img_dir.mkdir(parents=True, exist_ok=True)
            (img_dir / "README.txt").write_text(_IMAGES_README, encoding="utf-8")
        except OSError:
            pass

        n = _images_count(force=True)
        _set_stage("done", "完成：atlas/images/ 里现在有 {} 个文件".format(n),
                   done=len(parts), total=len(parts))
    except Exception as exc:   # noqa: BLE001
        # 故意不清 bin/_fetch_tmp：已经下完并校验过的分卷留在那儿，再点一次会跳过它们；
        # 半截的 .part 也在，_download 会带着 Range 接着往下写。
        # 代价是它占着磁盘，所以 status 会把占用量报给前端，提示条上能一键清掉。
        _set_stage("error",
                   "拉取失败：{}（已下好的分卷留在插件目录 bin/_fetch_tmp，重试会跳过；"
                   "不想留就点「清理下载缓存」）".format(exc),
                   error=str(exc))
    else:
        shutil.rmtree(tmp, ignore_errors=True)


async def _handle_images_status(request):
    return _json({
        "ok": True,
        "count": _images_count(),
        "dir": str(_images_dir()),
        "running": bool(_fetch_thread and _fetch_thread.is_alive()),
        "fetch": dict(_fetch_state),
        # 拉挂一次就会在插件目录里压下一个 1.3 GB 量级的下载缓存，报出来让用户能看见
        "tmp": _tmp_usage(),
    })


async def _handle_images_clean(request):
    """清掉下载缓存（bin/_fetch_tmp）—— 分卷、半截的 .part 都在那儿。

    那不是图，图在 atlas/images/，这个接口碰都不碰它。
    正在拉的时候不给清：那会把 worker 正在写的文件从底下抽走。
    """
    if _fetch_thread and _fetch_thread.is_alive():
        return _json({"ok": False, "error": "正在拉取中，等它停下来再清"}, 409)

    usage = _tmp_usage()
    shutil.rmtree(_fetch_tmp_dir(), ignore_errors=True)
    # 顺手收掉 bin/ 下没改完名的半截文件（下 7zr 时中断就是 7zr.exe.part）。
    # 7zr.exe 本体留着：那是能用的工具，下次拉取还要靠它，且只有 588 KB。
    for stray in _fetch_tmp_dir().parent.glob("*.part"):
        try:
            stray.unlink()
        except OSError:
            pass
    left = _tmp_usage()
    if left["files"]:
        return _json({
            "ok": False,
            "error": "还有 {} 个文件没删掉（可能被别的程序占着），关掉 ComfyUI 后手动删 {}".format(
                left["files"], left["dir"]),
        }, 500)
    return _json({"ok": True, "freed": usage["bytes"], "files": usage["files"]})


async def _handle_images_fetch(request):
    global _fetch_thread
    if _fetch_thread and _fetch_thread.is_alive():
        return _json({"ok": False, "error": "已经在拉了，等一下再点"}, 409)

    body = {}
    try:
        raw = await request.read()
        if raw:
            body = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        body = {}
    if not body.get("confirm"):
        return _json({"ok": False, "error": "需要 confirm=true 才会真的开始下载"}, 400)

    with _fetch_lock:
        _fetch_state.update({
            "stage": "checking", "message": "准备中…", "done": 0, "total": 0,
            "error": None, "startedAt": time.time(), "usedTool": "",
        })
    _fetch_thread = threading.Thread(target=_fetch_worker, name="codex-atlas-fetch", daemon=True)
    _fetch_thread.start()
    return _json({"ok": True, "started": True})


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
    server.routes.get("/codex_atlas/entry")(_handle_entry)
    server.routes.get("/codex_atlas/status")(_handle_status)
    server.routes.get("/codex_atlas/atlas/{tail:.*}")(_handle_atlas_static)
    server.routes.post("/codex_atlas/self-image")(_handle_self_image_save)
    server.routes.post("/codex_atlas/self-image/delete")(_handle_self_image_delete)
    server.routes.post("/codex_atlas/self-image/group")(_handle_self_image_group)
    server.routes.get("/codex_atlas/images/status")(_handle_images_status)
    server.routes.post("/codex_atlas/images/fetch")(_handle_images_fetch)
    server.routes.post("/codex_atlas/images/clean")(_handle_images_clean)
    return True


register_routes()
