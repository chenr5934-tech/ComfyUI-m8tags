"""插件用到的路径解析。

改造之后插件自己只剩一个目录要管：`atlas/` —— 里面是「我的图库」那一页
（gallery.html + app.css + gallery*.js + self-image/）。
法典词条和配图都改成从线上取了，不再落盘，所以这里也没有「读本地数据」那回事。

ATLAS_DIR 按这个顺序挑，第一个真的存在（含 gallery.html）的胜出：
  1. 环境变量 CODEX_ATLAS_DIR
  2. 插件目录下 config.json 的 atlasDir 字段
  3. 插件自带的 atlas/
  4. 逐级往上找同级的常见命名（兼容把站点放在插件旁边的老装法）
"""

from __future__ import annotations

import json
import os
from pathlib import Path

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
    """这是不是插件要用的那个 atlas 目录。

    以前看 data/index.js（本地法典数据），那份数据已经删了 ——
    现在看图库页：gallery.html 在，才说明这个目录是插件自己的。
    """
    try:
        return (path / "gallery.html").is_file()
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

# 注意：要拿「图库目录」时请现算 `store.ATLAS_DIR / "self-image"`，
# 别在模块级缓存成常量 —— 测试会把 ATLAS_DIR 指到临时目录，
# 缓存下来的那份还指着真实目录，会把测试数据写进真图库里。
