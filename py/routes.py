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


async def _handle_random(request):
    wanted = (request.query.get("codex") or CODEX_ANY).strip()
    include_nsfw = (request.query.get("nsfw") or "").lower() in ("1", "true", "yes")

    try:
        metas = store.get_meta_list()
    except store.CodexAtlasError as exc:
        return _json({"ok": False, "error": str(exc)}, 500)

    if not wanted or wanted == CODEX_ANY:
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
    if target is None or not target.is_file():
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
    return True


register_routes()
