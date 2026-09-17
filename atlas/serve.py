#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""法典图鉴 · 本地服务（双击「启动法典.bat」跑的就是这个）

为什么需要它
------------
双击 index.html 打开走的是 file:// 协议。那个协议下网页既没有后端可调，
也不能凭一个磁盘路径写文件（浏览器的安全模型），所以「我的图库」想存图
就只能让你手动选一次文件夹、给一次授权。

这个脚本起一个只监听 127.0.0.1 的小服务：伺服站点文件，并提供三个落盘接口。
页面在 http:// 下会自动优先走它们 —— 图片直接写进同目录的 self-image/，
不用选文件夹、不用授权，也不会随浏览器缓存一起丢。

接口契约和 ComfyUI 插件（py/routes.py）完全一致，所以同一份前端在
「插件小窗」和「bat 启动」两种情形下行为一模一样，不需要分支。

零第三方依赖，只用 Python 标准库。
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SELF_DIR_NAME = "self-image"
DEFAULT_PORT = 8788
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
MAX_BODY = 200 * 1024 * 1024          # 200MB，够放一张超大的 PNG

# 索引的改动都是「读出来 → 改 → 写回去」。服务器是真并发（ThreadingHTTPServer），
# 两个请求同时进来时后写的会把先写的整个覆盖掉 —— 连存两张图只留一张。
# 这段临界区必须是同步的（不能有 await），否则会卡住事件循环。
_INDEX_LOCK = threading.Lock()


def _site_root() -> Path:
    """站点根目录。测试可以拿 CODEX_SITE_ROOT 指到临时目录去。"""
    override = os.environ.get("CODEX_SITE_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parent


ROOT = _site_root()


# ---------------------------------------------------------------------------
# 图库索引读写
# ---------------------------------------------------------------------------

# 这几个名字在 self-image/ 里有特殊用途，绝不能被当成图片文件名写进去 ——
# 一张叫 index.js 的"图"会把索引本身覆盖成 PNG 字节，整个图库当场报废，
# 而且后面每次读写索引都会炸。撞上了就改名，不拒绝。
RESERVED_NAMES = {"index.js", "index.js.bak", "delete-log.txt", "index.js.tmp"}


def safe_filename(name) -> str:
    """只取文件名本身，挡掉路径分隔符、Windows 非法字符和保留名。

    和插件 py/routes.py 里的规则保持一致 —— 两边写出来的文件名要能互相认。
    """
    base = os.path.basename(str(name or "").replace("\\", "/")).strip()
    base = "".join(ch for ch in base if ch not in '<>:"/\\|?*' and ord(ch) >= 32)
    if not base:
        return "untitled.png"
    if base.lower() in RESERVED_NAMES:
        return "image_" + base
    return base


def clean_header(value, limit: int = 200) -> str:
    """请求头里塞进换行就能往日志里插伪造行，先把控制字符掐掉。"""
    return "".join(ch for ch in str(value or "") if ch >= " " or ch == "\t")[:limit]


# 站点里会被浏览器缓存、又经常改动的资源。伺服首页时给它们打上版本戳。
SITE_ASSETS = (
    "app.js", "app.css", "gallery.js", "gallery-meta.js",
    "data/index.js",
)


def asset_stamp(root: Path) -> str:
    """拿这些文件里最新的那个修改时间当版本号。改任何一个，URL 就变。"""
    stamps = []
    for rel in SITE_ASSETS:
        path = root / rel
        try:
            if path.is_file():
                stamps.append(int(path.stat().st_mtime))
        except OSError:
            pass
    return str(max(stamps) if stamps else 0)


def render_site_index(root: Path, target: Path) -> str:
    html = target.read_text("utf-8")
    stamp = asset_stamp(root)
    for rel in SITE_ASSETS:
        html = html.replace(f'"{rel}"', f'"{rel}?v={stamp}"')
    return html


def self_dir() -> Path:
    directory = ROOT / SELF_DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def parse_index_text(text: str):
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


def index_state(directory: Path):
    """读索引，返回 (entries, ok)。

    ok=False 表示"文件在那里，但读不出来"（编码坏了 / 格式坏了）。
    这种情况**绝不能当成空索引继续往下写** —— 下一步就是把已有记录全抹掉、
    再用新内容覆盖索引文件，等于永久损坏。宁可这次请求直接失败。
    """
    path = directory / "index.js"
    if not path.is_file():
        return [], True                       # 还没建索引，是正常状态
    try:
        text = path.read_text("utf-8")
    except (OSError, UnicodeError):
        # UnicodeDecodeError 不是 OSError 的子类，漏了它整个接口会 500
        return [], False
    data, ok = parse_index_text(text)
    if not ok or not isinstance(data, list):
        return [], False
    return data, True


def read_self_index(directory: Path) -> list:
    return index_state(directory)[0]


def write_self_index(directory: Path, entries: list) -> None:
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


def append_delete_log(directory: Path, entry: str) -> None:
    """把每次删除记一行流水。

    删图不可逆，出现过「图没了但不知道谁删的」的情况。留个流水，
    下次看时间 + 来源就能对上是谁点的。
    """
    try:
        with (directory / "delete-log.txt").open("a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  " + entry + "\n")
    except OSError:
        pass


def sniff_image_head(head: bytes):
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


def sniff_image_mime(path: Path):
    """读文件头判断图片类型。

    词库里有一批源图是 JPEG、文件名却是 .png。只按扩展名给 Content-Type
    会让浏览器拿到对不上的类型，虽然多半能容错，但没必要赌。
    """
    try:
        with path.open("rb") as fh:
            return sniff_image_head(fh.read(12))
    except OSError:
        return None


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    server_version = "CodexAtlasLocal/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---- 基础工具 ----

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def guess_type(self, path):
        if Path(path).suffix.lower() in IMAGE_SUFFIXES:
            mime = sniff_image_mime(Path(path))
            if mime:
                return mime
        return super().guess_type(path)

    def list_directory(self, path):
        # 站点里有四万多张图，别让人一访问 /images/ 就刷出一整页目录树
        self.send_error(404, "No directory listing")
        return None

    def end_headers(self):
        """给静态资源定性缓存策略。

        页面和脚本一律 no-cache（每次带 Last-Modified 验一次，没变就 304）——
        JS 改得勤，浏览器要是拿旧版跑新版页面，表现就是"按钮点了没反应"、
        "脚本没跑起来"，而磁盘上的文件明明是对的，能绕死人。
        配图下载完就不动了，长缓存。
        """
        if not getattr(self, "_cache_header_sent", False):
            path = self.path.split("?")[0].lower()
            if self.command == "GET" and not path.startswith("/codex_atlas"):
                if any(path.endswith(ext) for ext in IMAGE_SUFFIXES):
                    self.send_header("Cache-Control", "public, max-age=86400")
                elif path.endswith((".js", ".css", ".html", ".json")) or path.endswith("/"):
                    self.send_header("Cache-Control", "no-cache")
            self._cache_header_sent = True
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 太吵，只留启动那几行

    # ---- GET ----

    def do_GET(self):
        # 每个请求都重置一次：HTTP/1.1 keep-alive 会复用同一个 handler 实例
        # 连着处理多个请求，标志留在上一轮的 True 上，第二个请求就会漏掉
        # Cache-Control —— 而缓存头漏一次，就足够让浏览器把旧 JS 钉住。
        self._cache_header_sent = False
        route = self.path.split("?")[0].rstrip("/")
        if route == "/codex_atlas/status":
            self._json({
                "ok": True,
                "dir": str(ROOT),
                "mode": "local-server",
                # 前端认这两个 feature 才知道"能走后端存图"，别只看到 /status 有响应就以为能存
                "features": ["self-image", "self-image-group"],
            })
            return
        if route in ("", "/index.html"):
            self._serve_index()
            return
        super().do_GET()

    def _serve_index(self):
        """首页单独发：给脚本引用打上版本戳。

        浏览器缓存是"代码明明改对了、界面还是旧的"这类怪现象的头号来源 ——
        站点里的 JS 改得勤，只要它拿旧版跑，表现就可能是"脚本没跑起来"或
        "按钮点了没反应"。打上版本戳之后，文件一改 URL 就变，必然重新拉。
        """
        target = ROOT / "index.html"
        if not target.is_file():
            self.send_error(404, "index.html not found")
            return
        try:
            body = render_site_index(ROOT, target).encode("utf-8")
        except (OSError, UnicodeError) as exc:
            # UnicodeDecodeError 不是 OSError 的子类 —— 用记事本把 index.html
            # 另存成 ANSI 之后就会走这里，漏了它线程直接崩、浏览器白屏，
            # 而正确表现应该是"给出这条明确错误"。
            self.send_error(500, f"index.html 读不出来（编码可能不对）：{exc}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cache_header_sent = True   # 自己已经定了，别让 end_headers 再补一条
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- POST ----

    def do_POST(self):
        route = self.path.split("?")[0].rstrip("/")
        handlers = {
            "/codex_atlas/self-image": self._save_image,
            "/codex_atlas/self-image/delete": self._delete_image,
            "/codex_atlas/self-image/group": self._group_image,
        }
        fn = handlers.get(route)
        if fn is None:
            self.send_error(404, "Unknown endpoint")
            return

        payload = self._read_json()
        if payload is None:
            self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)
            return
        fn(payload)

    # ---- 三个接口 ----

    def _save_image(self, payload):
        """存一张图：原图 + 索引。"""
        name = safe_filename(payload.get("file"))
        b64 = payload.get("data") or ""
        meta = payload.get("meta") or {}
        group = str(payload.get("group") or "").strip()

        if not b64:
            self._json({"ok": False, "error": "没带图片数据"}, 400)
            return
        try:
            # validate=True：默认模式下非法字符会被悄悄忽略，解出空字节也不报错
            raw = base64.b64decode(b64, validate=True)
        except Exception as exc:
            self._json({"ok": False, "error": f"base64 解不开：{exc}"}, 400)
            return
        if not raw:
            self._json({"ok": False, "error": "图片数据是空的"}, 400)
            return

        # 光"非空"不够：一个 1 字节的文件也能过。按文件头确认真是图片，
        # 免得图库里混进打不开的垃圾条目（点开详情一片空白，还占着索引）。
        if sniff_image_head(raw[:12]) is None:
            self._json({
                "ok": False,
                "error": "这不是 PNG / JPEG / WebP / GIF —— 文件头对不上，没有保存",
            }, 400)
            return

        directory = self_dir()
        try:
            (directory / name).write_bytes(raw)
        except OSError as exc:
            self._json({"ok": False, "error": f"写图片失败：{exc}"}, 500)
            return

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
            entries, ok = index_state(directory)
            if not ok:
                self._json({
                    "ok": False,
                    "error": "图库索引读不出来（文件可能坏了）—— 这次保存先停下，"
                             "免得把已有记录一起冲掉。可以拿 index.js.bak 对照修复。",
                }, 500)
                return
            idx = next((i for i, e in enumerate(entries)
                        if isinstance(e, dict) and e.get("file") == name), -1)
            if idx >= 0:
                entries[idx] = entry
            else:
                entries.append(entry)

            try:
                write_self_index(directory, entries)
            except OSError as exc:
                self._json({"ok": False, "error": f"写索引失败：{exc}"}, 500)
                return

        self._json({"ok": True, "file": name, "total": len(entries), "dir": str(directory)})

    def _delete_image(self, payload):
        """把一张图从图库删掉。

        默认 keepFile=False：原图一起删。前端在调这个接口之前会弹模态警告确认 ——
        unlink 不进回收站，删错了找不回来，所以那一步确认必须在。
        """
        name = safe_filename(payload.get("file"))
        keep_file = payload.get("keepFile")
        keep_file = False if keep_file is None else bool(keep_file)

        directory = self_dir()
        target = (directory / name).resolve()
        # 用 is_relative_to 而不是字符串 startswith：后者会把
        # `self-image-extra/x` 误判成 `self-image` 底下的文件。
        try:
            inside = target.is_relative_to(directory.resolve())
        except OSError:
            inside = False
        if not inside:
            self._json({"ok": False, "error": "文件名不合法"}, 400)
            return

        removed = False
        if not keep_file and target.is_file():
            try:
                target.unlink()
                removed = True
            except OSError as exc:
                self._json({"ok": False, "error": f"删文件失败：{exc}"}, 500)
                return

        if removed:
            append_delete_log(
                directory,
                "删除 " + name
                + "  | 来源 " + (clean_header(self.headers.get("Referer")) or "（无）")
                + "  | UA " + (clean_header(self.headers.get("User-Agent"), 70) or "（无）"),
            )
        else:
            append_delete_log(directory, "摘索引 " + name + "（文件保留或本来就不在）")

        with _INDEX_LOCK:
            entries, ok = index_state(directory)
            if not ok:
                self._json({
                    "ok": False,
                    "error": "图库索引读不出来（文件可能坏了）—— 原图已按你的选择处理，"
                             "但记录没能更新。可以拿 index.js.bak 对照修复。",
                }, 500)
                return
            entries = [e for e in entries
                       if not (isinstance(e, dict) and e.get("file") == name)]
            try:
                write_self_index(directory, entries)
            except OSError as exc:
                self._json({"ok": False, "error": f"写索引失败：{exc}"}, 500)
                return

        self._json({
            "ok": True,
            "removed": removed,
            "keptFile": bool(keep_file) and target.is_file(),
            "total": len(entries),
        })

    def _group_image(self, payload):
        """把某张图挪进某个分组（只改索引里的字段，不动图片文件）。"""
        name = safe_filename(payload.get("file"))
        group = str(payload.get("group") or "").strip()

        directory = self_dir()
        with _INDEX_LOCK:
            entries, ok = index_state(directory)
            if not ok:
                self._json({
                    "ok": False,
                    "error": "图库索引读不出来（文件可能坏了）—— 这次分组先停下，"
                             "免得把已有记录一起冲掉。",
                }, 500)
                return
            target = next((e for e in entries
                           if isinstance(e, dict) and e.get("file") == name), None)
            if target is None:
                self._json({"ok": False, "error": f"索引里没有这张图：{name}"}, 404)
                return

            if group:
                target["group"] = group
            else:
                target.pop("group", None)

            try:
                write_self_index(directory, entries)
            except OSError as exc:
                self._json({"ok": False, "error": f"写索引失败：{exc}"}, 500)
                return

        groups = sorted({e.get("group") for e in entries
                         if isinstance(e, dict) and e.get("group")})
        self._json({"ok": True, "file": name, "group": group, "groups": groups})


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

def pick_port(preferred: int = DEFAULT_PORT) -> int:
    """从 preferred 往后找一个没被占的端口；都占了就让系统随便给。"""
    for candidate in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    return 0


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    open_browser = "--no-browser" not in args
    args = [a for a in args if a != "--no-browser"]
    port = int(args[0]) if args and args[0].isdigit() else pick_port()

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    real_port = httpd.server_address[1]
    url = f"http://127.0.0.1:{real_port}/index.html"

    print()
    print("  法典图鉴 · 本地服务已启动")
    print("  " + "-" * 52)
    print(f"  地址：{url}")
    print(f"  站点：{ROOT}")
    print(f"  图库：{self_dir()}  （在这里，不用再选文件夹了）")
    print()
    print("  关掉这个窗口（或按 Ctrl+C）就停止服务。")
    print("  以后想再打开图库，双击「启动法典.bat」就行。")
    print()

    if open_browser:
        # 留半秒让 serve_forever 先转起来，免得浏览器抢在前面拿到连接拒绝
        threading.Timer(0.5, webbrowser.open, [url]).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        # 行缓冲：双击 bat 时那几行启动信息要立刻出现，别卡在缓冲区里
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.exit(main())
