"""法典数据层：全部从本地离线项目读取，不联网。

数据源：
  <ATLAS_DIR>/data/index.js       -> window.QTC_META = [ {id,title,nsfw,entryCount,...}, ... ]
  <ATLAS_DIR>/data/<id>.js        -> window.QTC_DATA["<id>"] = { meta, entries: [...] }
  <ATLAS_DIR>/images/<id>/*.jpg   -> 例图
  <RAW_DIR>/<id>.json             -> 原始 NAI 语法版本（可选，供"原始 NAI"模式用）

两个要点：
  1. data/*.js 里的 tags 已经是转换过的 A1111 语法，负向字段被压成短名 n；
     原始 NAI 写法在 raw 里，按 entry id 与 data 一一配对。
  2. 站点目录没有写死路径，按下面的顺序自动找，也可以显式指定。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

def _windows_junction_target(path: Path) -> Path | None:
    """读 Windows 目录联接（junction）的目标；不是联接、或读不到，返回 None。

    为什么需要这个：Python 标准库不认 junction —— Path.resolve()、os.path.realpath()、
    os.readlink() 三者都把它当普通目录（实机验证过）。而 ComfyUI 插件十有八九是用
    junction 挂进 custom_nodes 的，于是「从插件目录往上找站点」会困在 custom_nodes
    那棵树里，永远走不到站点真正所在的目录树。这里直接向 Windows 要重解析点。
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return None

    GENERIC_READ = 0x80000000
    FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    OPEN_EXISTING = 3
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    FSCTL_GET_REPARSE_POINT = 0x000900A8
    IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
    BUF_SIZE = 16 * 1024

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        kernel32.DeviceIoControl.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
            ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
            ctypes.c_void_p,
        ]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

        handle = kernel32.CreateFileW(
            str(path), GENERIC_READ, FILE_SHARE_ALL, None, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, None,
        )
        if not handle or handle == ctypes.c_void_p(-1).value:
            return None
    except (OSError, AttributeError):
        return None

    try:
        buf = ctypes.create_string_buffer(BUF_SIZE)
        returned = wintypes.DWORD(0)
        ok = kernel32.DeviceIoControl(
            handle, FSCTL_GET_REPARSE_POINT, None, 0,
            buf, BUF_SIZE, ctypes.byref(returned), None,
        )
        if not ok:
            return None  # 不是重解析点，普通目录

        raw = buf.raw
        if int.from_bytes(raw[0:4], "little") != IO_REPARSE_TAG_MOUNT_POINT:
            return None  # 是别的重解析类型（比如符号链接），不在这里处理

        # REPARSE_DATA_BUFFER：8 字节头 + MountPointReparseBuffer 的 8 字节字段 + PathBuffer
        path_base = 16
        sub_off = int.from_bytes(raw[8:10], "little")
        sub_len = int.from_bytes(raw[10:12], "little")
        text = raw[path_base + sub_off: path_base + sub_off + sub_len].decode("utf-16-le", "ignore")
        text = text.replace("\\??\\", "").replace("\\\\?\\", "").rstrip("\x00").strip()
        return Path(text) if text else None
    except (OSError, ValueError, IndexError):
        return None
    finally:
        try:
            kernel32.CloseHandle(handle)
        except OSError:
            pass


def _resolve_links(path: Path) -> Path:
    """把路径里每一层的目录联接逐个解开。"""
    parts = Path(path).parts
    if not parts:
        return Path(path)
    current = Path(parts[0])
    for part in parts[1:]:
        current = current / part
        target = _windows_junction_target(current)
        if target is not None:
            current = target
    return current


# 插件真实所在目录。用 junction 挂进 custom_nodes 时，这一步会把它还原到源目录，
# 后面的「向上找站点」才有意义。
PLUGIN_DIR = _resolve_links(Path(__file__).resolve().parent.parent)

# 站点目录叫什么名字都可能，这些都试一遍
ATLAS_DIR_NAMES = ("本地离线提示词法典", "tag-atlas", "codex-atlas", "atlas")
RAW_DIR_NAMES = ("raw", "codexes-raw")


def _read_config() -> dict:
    """插件目录下的 config.json（可选，不提交到仓库）。"""
    path = PLUGIN_DIR / "config.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


_CONFIG = _read_config()


def _looks_like_atlas(path: Path) -> bool:
    try:
        return (path / "data" / "index.js").is_file()
    except OSError:
        return False


def _walk_up_dirs(depth: int = 3) -> list[Path]:
    """插件目录，以及往上几层。站点和原始数据通常就放在旁边某一层。"""
    out: list[Path] = []
    path = PLUGIN_DIR
    for _ in range(depth):
        out.append(path)
        if path.parent == path:
            break
        path = path.parent
    return out


def _dedup(paths) -> list[Path]:
    """保序去重 —— 同一个目录常被多条规则同时命中。"""
    seen = set()
    out: list[Path] = []
    for p in paths:
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _atlas_candidates() -> list[Path]:
    """站点目录候选，按优先级排列。"""
    out: list[Path] = []

    env = (os.environ.get("CODEX_ATLAS_DIR") or "").strip()
    if env:
        out.append(Path(env))

    cfg = str(_CONFIG.get("atlasDir") or "").strip()
    if cfg:
        out.append(Path(cfg))

    # 插件自带的站点（随仓库一起分发）。放在 config 之后：谁显式配了
    # atlasDir 就听谁的（往往是为了指向带 images/ 的完整目录），
    # 没配的人拿到的就是这份内置的，开箱即用。
    out.append(PLUGIN_DIR / "atlas")

    for base in _walk_up_dirs():
        out.append(base / "atlas")            # 放进 atlas/ 子目录
        for name in ATLAS_DIR_NAMES:          # 同级的常见命名
            out.append(base / name)
        out.append(base)                      # 站点内容直接摊在这一层

    return _dedup(out)


def _resolve_atlas_dir() -> tuple[Path, list[Path]]:
    """挑出真正存在的那个；一个都不存在时返回第一个候选，好让报错指向用户指定的位置。"""
    tried = _atlas_candidates()
    for path in tried:
        if _looks_like_atlas(path):
            return path, tried
    return tried[0], tried


ATLAS_DIR, ATLAS_CANDIDATES = _resolve_atlas_dir()
DATA_DIR = ATLAS_DIR / "data"
IMAGES_DIR = ATLAS_DIR / "images"


def _raw_candidates() -> list[Path]:
    """原始 NAI 数据候选：优先站点自带的 raw/，其次插件各级旁边的 raw/、codexes-raw/。"""
    out: list[Path] = []

    env = (os.environ.get("CODEX_ATLAS_RAW_DIR") or "").strip()
    if env:
        out.append(Path(env))

    cfg = str(_CONFIG.get("rawDir") or "").strip()
    if cfg:
        out.append(Path(cfg))

    out.append(ATLAS_DIR / "raw")
    for base in _walk_up_dirs():
        for name in RAW_DIR_NAMES:
            out.append(base / name)

    return _dedup(out)


_RAW_CANDIDATES = _raw_candidates()


class CodexAtlasError(RuntimeError):
    """数据层对外抛出的统一异常，路由层转成 4xx/5xx。"""


_lock = threading.RLock()
_meta_cache: dict = {"key": None, "data": None}
_codex_cache: dict = {}   # "<id>" -> {"key":..., "data":...}
_raw_cache: dict = {}     # "<id>" -> {"key":..., "data": {entry_id: nai_tags}}


def raw_dir() -> Path | None:
    """原始 NAI 数据目录。找不到就返回 None，「原始 NAI」模式会退化成 A1111。"""
    for candidate in _RAW_CANDIDATES:
        try:
            if candidate.is_dir():
                return candidate
        except OSError:
            continue
    return None


def _file_key(path: Path) -> str:
    st = path.stat()
    return f"{path.name}:{st.st_mtime_ns}:{st.st_size}"


def _read_text(path: Path) -> str:
    try:
        return path.read_text("utf-8")
    except FileNotFoundError as exc:
        raise CodexAtlasError(f"找不到文件：{path}") from exc
    except OSError as exc:
        raise CodexAtlasError(f"读不了 {path}：{exc}") from exc


def _payload_after(src: str, marker: str) -> Any:
    """抠出 `marker = <json>;` 里的那段 JSON。"""
    idx = src.find(marker)
    if idx < 0:
        raise CodexAtlasError(f"数据文件里找不到标记：{marker}")
    tail = src[idx + len(marker):].strip()
    if tail.endswith(";"):
        tail = tail[:-1].strip()
    try:
        return json.loads(tail)
    except json.JSONDecodeError as exc:
        raise CodexAtlasError(f"{marker} 后面的内容不是合法 JSON") from exc


def get_meta_list(force: bool = False) -> list:
    """法典索引（index.js）。节点上的法典下拉就靠它。"""
    path = DATA_DIR / "index.js"
    if not path.is_file():
        tried = "、".join(str(p) for p in ATLAS_CANDIDATES)
        raise CodexAtlasError(
            f"找不到法典索引 index.js。找过这些位置：{tried}。"
            "把离线站点目录放进插件内（atlas/）或与插件同级，"
            "也可用环境变量 CODEX_ATLAS_DIR 或插件目录下的 config.json（atlasDir 字段）指定。"
        )

    key = _file_key(path)
    with _lock:
        if not force and _meta_cache["key"] == key and _meta_cache["data"] is not None:
            return _meta_cache["data"]

    metas = _payload_after(_read_text(path), "window.QTC_META =")
    if not isinstance(metas, list):
        raise CodexAtlasError("index.js 结构不符合预期")

    with _lock:
        _meta_cache.update(key=key, data=metas)
    return metas


def get_codex(codex_id: str) -> dict:
    """某部法典的完整词条（data/<id>.js）。"""
    if not codex_id or "/" in codex_id or "\\" in codex_id or ".." in codex_id:
        raise CodexAtlasError(f"非法法典 id：{codex_id!r}")

    path = DATA_DIR / f"{codex_id}.js"
    if not path.is_file():
        raise CodexAtlasError(f"找不到法典数据：{path.name}")

    key = _file_key(path)
    with _lock:
        hit = _codex_cache.get(codex_id)
        if hit and hit["key"] == key:
            return hit["data"]

    data = _payload_after(_read_text(path), f'window.QTC_DATA["{codex_id}"] =')
    if not isinstance(data, dict):
        raise CodexAtlasError(f"{codex_id}.js 结构不符合预期")

    with _lock:
        _codex_cache[codex_id] = {"key": key, "data": data}
    return data


def find_entry(codex_id: str, entry_id: str) -> dict | None:
    """按 entry id 精确找一条词条。找不到返回 None。"""
    if not entry_id:
        return None
    data = get_codex(codex_id)
    for entry in data.get("entries") or []:
        if isinstance(entry, dict) and entry.get("id") == entry_id:
            return entry
    return None


def get_raw_tags(codex_id: str) -> dict:
    """entry_id -> 原始 NAI tags。缺文件就返回空字典，调用方自行退化。"""
    directory = raw_dir()
    if directory is None:
        return {}
    path = directory / f"{codex_id}.json"
    if not path.is_file():
        return {}

    key = _file_key(path)
    with _lock:
        hit = _raw_cache.get(codex_id)
        if hit and hit["key"] == key:
            return hit["data"]

    try:
        obj = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    table = {}
    if isinstance(obj, dict):
        for entry in obj.get("entries") or []:
            if isinstance(entry, dict) and entry.get("id"):
                table[entry["id"]] = {
                    "tags": entry.get("tags") or "",
                    "negative": entry.get("negative") or "",
                }

    with _lock:
        _raw_cache[codex_id] = {"key": key, "data": table}
    return table


def data_version() -> dict:
    """这份本地快照的版本信息，给前端显示用。"""
    info = {
        "dir": str(ATLAS_DIR),
        "rawDir": str(raw_dir() or ""),
        "release": "local",
        "publishedAt": None,
        "mtimeText": "",
    }
    index = DATA_DIR / "index.js"
    try:
        st = index.stat()
        info["mtime"] = int(st.st_mtime)
        info["mtimeText"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))
    except OSError:
        info["mtime"] = 0
    return info


def image_file(codex_id: str, name: str) -> Path | None:
    """例图路径。

    codex_id 和 name 都必须是单段名字 —— 只挡 name 的话，codex_id 里带
    `../` 就能拼出站点外的路径。当前没有调用方传用户可控的 codex_id，
    但把口子先堵上，别留给以后接线的人。
    """
    for part in (codex_id, name):
        if not part or "/" in part or "\\" in part or part in (".", ".."):
            return None
    path = IMAGES_DIR / codex_id / name
    return path if path.is_file() else None
