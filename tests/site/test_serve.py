# -*- coding: utf-8 -*-
"""serve.py 的接口测试。

关键点：这些接口会**真的**往 self-image/ 写文件、删文件。
所以每个测试都在临时目录里起一个独立服务（CODEX_SITE_ROOT 指过去），
绝不碰站点里真实的图库。
"""

import base64
import concurrent.futures
import http.client
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

# 站点源码已经并进插件的 atlas/（独立站点目录不再单独存在），所以这里指向内置那份。
# 这份脚本的测试对象就是 atlas/serve.py —— 每个用例都会把 serve.ROOT 指到临时目录，
# 不会碰到真实站点文件。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "atlas"))
import serve  # noqa: E402


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24


class ServeTestBase(unittest.TestCase):
    """在临时目录里起一份 serve.py 的服务。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="codex-serve-"))
        # 首页要带真实的脚本引用，否则版本戳注入那套逻辑等于没被测到
        (self.tmp / "index.html").write_text(
            '<!DOCTYPE html><html><head>\n'
            '<link rel="stylesheet" href="app.css">\n'
            '</head><body><h1>法典</h1>\n'
            '<script src="data/index.js"></script>\n'
            '<script src="self-image/index.js"></script>\n'
            '<script src="gallery-meta.js"></script>\n'
            '<script src="app.js"></script>\n'
            '<script src="gallery.js"></script>\n'
            '</body></html>\n', "utf-8")
        # 这些脚本文件只是为了让首页的版本戳注入有东西可替换；内容无所谓。
        # self-image/ 只建目录、不放 index.js —— 那是图库索引，各用例自己造。
        for name in ("app.js", "app.css", "gallery.js", "gallery-meta.js"):
            (self.tmp / name).write_text("/* " + name + " */", "utf-8")
        (self.tmp / "data").mkdir(exist_ok=True)
        (self.tmp / "data" / "index.js").write_text("window.QTC_META = [];", "utf-8")
        (self.tmp / "self-image").mkdir(exist_ok=True)

        self._old_root = serve.ROOT
        serve.ROOT = self.tmp

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        serve.ROOT = self._old_root
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 请求助手 ----

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def get(self, path):
        try:
            with urllib.request.urlopen(self.url(path), timeout=5) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def post(self, path, payload):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.url(path), data=data,
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read()
            try:
                return exc.code, json.loads(body.decode("utf-8"))
            except json.JSONDecodeError:
                return exc.code, {}

    def save(self, name, raw=PNG, meta=None, group=None):
        payload = {"file": name, "data": base64.b64encode(raw).decode(), "meta": meta or {}}
        if group:
            payload["group"] = group
        return self.post("/codex_atlas/self-image", payload)

    def index(self):
        return serve.read_self_index(self.tmp / "self-image")


class TestStatus(ServeTestBase):
    def test_status_declares_the_features_the_frontend_needs(self):
        status, body = self.get("/codex_atlas/status")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data["ok"])
        # 前端只看这两个：能存图、能改分组。少了它就会退回"让你选文件夹"
        self.assertIn("self-image", data["features"])
        self.assertIn("self-image-group", data["features"])
        self.assertEqual(data["mode"], "local-server")

    def test_index_is_served_at_root(self):
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("法典", body.decode("utf-8"))


class TestStaticServing(ServeTestBase):
    def test_data_file_is_served(self):
        status, body = self.get("/data/index.js")
        self.assertEqual(status, 200)
        self.assertIn(b"QTC_META", body)

    def test_directory_listing_is_refused(self):
        status, _ = self.get("/data/")
        self.assertEqual(status, 404, "不该把目录树列给访问者")

    def test_path_traversal_is_blocked(self):
        status, body = self.get("/../../../../Windows/win.ini")
        self.assertNotIn(b"[fonts]", body, "顺着 ../ 跑出去读到系统文件了")
        # 标准库会把越界路径收敛回站点根，返回 404/403/200(根内文件) 都算挡住了越界读取
        self.assertNotEqual(status, 500)

    def test_image_mime_follows_content_not_extension(self):
        """词库里有一批 JPEG 顶着 .png 的名字，Content-Type 要按真实内容给。"""
        images = self.tmp / "images"
        images.mkdir()
        (images / "actually-jpeg.png").write_bytes(JPEG)
        with urllib.request.urlopen(self.url("/images/actually-jpeg.png"), timeout=5) as res:
            self.assertEqual(res.headers.get("Content-Type"), "image/jpeg")


class TestSaveImage(ServeTestBase):
    def test_save_writes_file_and_index(self):
        status, data = self.save("__t__.png", meta={"source": "a1111"})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"], data.get("error"))

        target = self.tmp / "self-image" / "__t__.png"
        self.assertTrue(target.is_file(), "图片没落盘")
        self.assertEqual(target.read_bytes(), PNG, "写进去的字节和原始不一致")

        entries = [e for e in self.index() if e.get("file") == "__t__.png"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["meta"]["source"], "a1111")
        self.assertEqual(entries[0]["size"], len(PNG))

    def test_same_name_overwrites_instead_of_duplicating(self):
        self.save("__t__.png")
        self.save("__t__.png")
        entries = [e for e in self.index() if e.get("file") == "__t__.png"]
        self.assertEqual(len(entries), 1, "同名保存应覆盖而不是追加")

    def test_save_carries_group(self):
        self.save("__t__.png", group="萝莉")
        self.assertEqual(self.index()[0].get("group"), "萝莉")

    def test_filename_is_sanitised(self):
        status, data = self.save("../../evil.png")
        self.assertEqual(status, 200)
        self.assertEqual(data["file"], "evil.png")
        self.assertTrue((self.tmp / "self-image" / "evil.png").is_file())
        self.assertFalse((self.tmp / "evil.png").exists(), "跑到上级目录去了")

    def test_bad_base64_is_rejected(self):
        status, data = self.post("/codex_atlas/self-image", {"file": "__t__.png", "data": "!!!!"})
        self.assertEqual(status, 400)
        self.assertFalse(data["ok"])

    def test_missing_data_is_rejected(self):
        status, _ = self.post("/codex_atlas/self-image", {"file": "__t__.png"})
        self.assertEqual(status, 400)


class TestDeleteImage(ServeTestBase):
    def test_delete_removes_file_and_entry(self):
        self.save("__t__.png")
        status, data = self.post("/codex_atlas/self-image/delete", {"file": "__t__.png"})
        self.assertEqual(status, 200)
        self.assertTrue(data["removed"])
        self.assertFalse((self.tmp / "self-image" / "__t__.png").exists())
        self.assertEqual([e for e in self.index() if e.get("file") == "__t__.png"], [])

    def test_keep_file_true_leaves_the_image(self):
        self.save("__t__.png")
        _, data = self.post("/codex_atlas/self-image/delete",
                            {"file": "__t__.png", "keepFile": True})
        self.assertFalse(data["removed"])
        self.assertTrue(data["keptFile"])
        self.assertTrue((self.tmp / "self-image" / "__t__.png").is_file())
        self.assertEqual([e for e in self.index() if e.get("file") == "__t__.png"], [])

    def test_unknown_file_is_harmless(self):
        status, data = self.post("/codex_atlas/self-image/delete", {"file": "__nope__.png"})
        self.assertEqual(status, 200)
        self.assertFalse(data["removed"])


class TestGroupImage(ServeTestBase):
    def test_group_moves_entry_without_touching_the_image(self):
        self.save("__t__.png")
        status, data = self.post("/codex_atlas/self-image/group",
                                 {"file": "__t__.png", "group": "风景"})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"], data.get("error"))
        self.assertEqual(self.index()[0].get("group"), "风景")
        self.assertEqual((self.tmp / "self-image" / "__t__.png").read_bytes(), PNG)

    def test_empty_group_moves_back_to_ungrouped(self):
        self.save("__t__.png", group="临时")
        self.post("/codex_atlas/self-image/group", {"file": "__t__.png", "group": ""})
        self.assertNotIn("group", self.index()[0])

    def test_unknown_file_is_404(self):
        status, _ = self.post("/codex_atlas/self-image/group",
                              {"file": "__nope__.png", "group": "x"})
        self.assertEqual(status, 404)

    def test_group_list_is_returned(self):
        self.save("__t__.png", group="甲")
        _, data = self.post("/codex_atlas/self-image/group",
                            {"file": "__t__.png", "group": "乙"})
        self.assertIn("乙", data["groups"])


class TestBatchUpload(ServeTestBase):
    """连存多张，索引不能互相踩。"""

    def test_many_saves_all_land_in_index(self):
        for i in range(6):
            status, data = self.save(f"__batch_{i}__.png")
            self.assertTrue(data["ok"], data.get("error"))
        files = {e["file"] for e in self.index()}
        for i in range(6):
            self.assertIn(f"__batch_{i}__.png", files)
        self.assertEqual(len(files), 6)

    def test_large_body_survives(self):
        big = b"\x89PNG\r\n\x1a\n" + os.urandom(3 * 1024 * 1024)
        status, data = self.save("__big__.png", raw=big)
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"], data.get("error"))
        self.assertEqual((self.tmp / "self-image" / "__big__.png").stat().st_size, len(big))


class TestIndexBackup(ServeTestBase):
    """索引每次落笔前留一份 .bak —— 它是图库里唯一记着模型信息的地方。"""

    def test_backup_is_written_before_overwriting(self):
        self.save("__first__.png", meta={"source": "a1111"})
        self.assertFalse((self.tmp / "self-image" / "index.js.bak").exists(),
                         "第一次写时还没有旧的可以备份")

        self.save("__second__.png")
        bak = self.tmp / "self-image" / "index.js.bak"
        self.assertTrue(bak.is_file(), "第二次写之前应该留下旧索引的备份")
        self.assertIn("__first__.png", bak.read_text("utf-8"))
        self.assertNotIn("__second__.png", bak.read_text("utf-8"))

    def test_backup_survives_a_delete(self):
        self.save("__first__.png")
        self.save("__second__.png")
        self.post("/codex_atlas/self-image/delete", {"file": "__second__.png"})
        bak = self.tmp / "self-image" / "index.js.bak"
        self.assertIn("__second__.png", bak.read_text("utf-8"),
                      "备份里应当还留着被删掉那条，能照着恢复")

    def test_backup_is_not_loaded_as_the_index(self):
        self.save("__first__.png")
        self.save("__second__.png")
        files = {e["file"] for e in self.index()}
        self.assertNotIn("index.js.bak", files)
        self.assertEqual(files, {"__first__.png", "__second__.png"})


class TestDeleteLog(ServeTestBase):
    """删图不可逆，要留流水：谁、什么时候、删了哪个。"""

    def test_delete_is_logged(self):
        self.save("__t__.png")
        self.post("/codex_atlas/self-image/delete", {"file": "__t__.png"})
        log = self.tmp / "self-image" / "delete-log.txt"
        self.assertTrue(log.is_file(), "删除没留下流水")
        text = log.read_text("utf-8")
        self.assertIn("__t__.png", text)
        self.assertIn("删除", text)

    def test_keep_file_is_logged_differently(self):
        self.save("__t__.png")
        self.post("/codex_atlas/self-image/delete", {"file": "__t__.png", "keepFile": True})
        text = (self.tmp / "self-image" / "delete-log.txt").read_text("utf-8")
        self.assertIn("摘索引", text)
        self.assertNotIn("删除 __t__.png", text)


class TestUnknownEndpoint(ServeTestBase):
    def test_unknown_post_is_404(self):
        status, _ = self.post("/codex_atlas/nope", {})
        self.assertEqual(status, 404)


class TestPickPort(unittest.TestCase):
    def test_prefers_the_default_when_free(self):
        port = serve.pick_port(39000)
        self.assertGreaterEqual(port, 39000)

    def test_moves_on_when_taken(self):
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as taken:
            taken.bind(("127.0.0.1", 39111))
            taken.listen(1)
            port = serve.pick_port(39111)
            self.assertNotEqual(port, 39111, "占用中的端口不该被选中")


class TestReservedNames(ServeTestBase):
    """self-image/ 里有几个名字是给系统用的，不能被图片文件撞上。"""

    def test_image_named_index_js_cannot_clobber_the_index(self):
        self.save("good.png")
        status, data = self.save("index.js")
        self.assertEqual(status, 200)
        self.assertEqual(data["file"], "image_index.js", "保留名应当被改名")

        index_file = self.tmp / "self-image" / "index.js"
        self.assertIn("SELF_META", index_file.read_text("utf-8"),
                      "索引文件被 PNG 字节覆盖了")
        files = {e["file"] for e in self.index()}
        self.assertIn("good.png", files, "原有记录被冲掉了")
        self.assertIn("image_index.js", files)

    def test_other_reserved_names_are_renamed_too(self):
        for name in ("index.js.bak", "delete-log.txt"):
            _, data = self.save(name)
            self.assertEqual(data["file"], "image_" + name, name + " 没被改名")


class TestBrokenIndex(ServeTestBase):
    """索引读不出来时必须停下，绝不能当成空索引继续写 —— 那会把记录全抹掉。"""

    def _break_index(self):
        d = self.tmp / "self-image"
        d.mkdir(exist_ok=True)
        (d / "index.js").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe\x00 not-utf8 at all")

    def test_save_refuses_and_leaves_the_broken_file_alone(self):
        self.save("keep.png")
        self._break_index()
        status, data = self.save("new.png")
        self.assertEqual(status, 500)
        self.assertFalse(data["ok"])
        self.assertIn("索引读不出来", data["error"])
        self.assertIn(b"not-utf8", (self.tmp / "self-image" / "index.js").read_bytes(),
                      "坏索引被覆盖了，等于把线索也毁了")

    def test_group_refuses(self):
        self.save("keep.png")
        self._break_index()
        status, data = self.post("/codex_atlas/self-image/group",
                                 {"file": "keep.png", "group": "x"})
        self.assertEqual(status, 500)
        self.assertFalse(data["ok"])

    def test_delete_refuses_to_wipe(self):
        self.save("keep.png")
        self._break_index()
        status, data = self.post("/codex_atlas/self-image/delete",
                                 {"file": "keep.png", "keepFile": True})
        self.assertEqual(status, 500)
        self.assertFalse(data["ok"])


class TestConcurrentSave(ServeTestBase):
    """索引是「读出来 → 改 → 写回去」。服务器是真并发，不加锁会静默丢记录。"""

    def test_parallel_saves_do_not_lose_records(self):
        n = 8
        barrier = threading.Barrier(n)

        def one(i):
            barrier.wait()          # 尽量让 8 个请求同时打进去
            return self.save(f"__par_{i}__.png")

        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
            results = list(pool.map(one, range(n)))

        for status, data in results:
            self.assertEqual(status, 200)
            self.assertTrue(data["ok"], data.get("error"))

        files = {e["file"] for e in self.index()}
        for i in range(n):
            self.assertIn(f"__par_{i}__.png", files, "并发保存丢了记录")


class TestCleanHeader(unittest.TestCase):
    """请求头里的控制字符能往日志里插伪造行。"""

    def test_strips_cr_and_lf(self):
        self.assertEqual(serve.clean_header("a\r\nb"), "ab")
        self.assertEqual(serve.clean_header("a\rb"), "ab")
        self.assertEqual(serve.clean_header("a\nb"), "ab")

    def test_keeps_tab_and_truncates(self):
        self.assertEqual(serve.clean_header("a\tb"), "a\tb")
        self.assertEqual(len(serve.clean_header("x" * 500, 70)), 70)

    def test_handles_none(self):
        self.assertEqual(serve.clean_header(None), "")


class TestDeleteLogInjection(ServeTestBase):
    """真的从 socket 发一个带头部注入的请求，确认流水还是只有一行。"""

    def test_forged_header_cannot_add_a_log_line(self):
        self.save("__t__.png")
        body = json.dumps({"file": "__t__.png"}).encode("utf-8")

        raw = (
            "POST /codex_atlas/self-image/delete HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            "User-Agent: Mozilla/5.0\rFORGED-UA-LINE\r\n"
            "Referer: http://x/\rFORGED-REF-LINE\r\n"
            "Connection: close\r\n\r\n"
        ).encode("utf-8")

        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            s.sendall(raw + body)
            s.settimeout(5)
            chunks = []
            while True:
                try:
                    b = s.recv(4096)
                except socket.timeout:
                    break
                if not b:
                    break
                chunks.append(b)

        log = (self.tmp / "self-image" / "delete-log.txt").read_text("utf-8")
        lines = [ln for ln in log.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, "删除流水被插进了伪造行：\n" + log)
        self.assertNotIn("\r", lines[0])


class TestTrickyIndexContent(ServeTestBase):
    """记录里出现 `];` 不能把索引切坏。

    早先用的是非贪婪正则 /\\[[\\s\\S]*?\\]\\s*;/，只要提示词或文件名里出现
    `];`，捕获就在那里断掉，JSON 解析失败，整份索引会被当成空的 ——
    下一次保存就把所有记录冲掉了。
    """

    def test_semicolon_bracket_in_prompt_survives(self):
        self.save("__t__.png", meta={"source": "a1111", "positive": "artist:x]; with semicolon"})
        entries = self.index()
        self.assertEqual(len(entries), 1, "索引被截断了")
        self.assertEqual(entries[0]["meta"]["positive"], "artist:x]; with semicolon")

    def test_filename_with_bracket_semicolon_survives(self):
        self.save("a];b.png")
        self.assertIn("a];b.png", {e["file"] for e in self.index()})

    def test_earlier_records_are_not_lost_when_a_later_one_is_tricky(self):
        self.save("keep.png")
        self.save("tricky.png", meta={"positive": "foo];bar"})
        self.save("last.png")
        files = {e["file"] for e in self.index()}
        self.assertEqual(files, {"keep.png", "tricky.png", "last.png"},
                         "带 `];` 的记录把别的记录弄丢了")

    def test_broken_json_is_reported_not_treated_as_empty(self):
        """文件在、但内容对不上时，index_state 必须说 ok=False。"""
        d = self.tmp / "self-image"
        d.mkdir(exist_ok=True)
        (d / "index.js").write_text("window.SELF_META = [ { ] ;", "utf-8")
        entries, ok = serve.index_state(d)
        self.assertFalse(ok, "坏索引被当成了空索引")


class TestCacheHeaders(ServeTestBase):
    """缓存头必须每个响应都有。

    HTTP/1.1 keep-alive 会复用同一个 handler 实例连着处理多个请求 ——
    如果那个"已经发过 Cache-Control 了"的标志没按请求重置，第二个请求就会
    漏掉它。漏一次就足够让浏览器把旧版 JS 钉住，表现成"某个脚本没跑起来"。
    这个坑真踩过。
    """

    def test_every_response_on_a_keepalive_connection_carries_cache_control(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            for path in ("/app.js", "/gallery.js", "/app.css", "/index.html"):
                conn.request("GET", path)
                resp = conn.getresponse()
                resp.read()
                self.assertIsNotNone(
                    resp.getheader("Cache-Control"),
                    f"{path} 这一轮漏了 Cache-Control（keep-alive 复用实例的老问题）")
        finally:
            conn.close()

    def test_index_is_never_stored(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", "/index.html")
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.getheader("Cache-Control"), "no-store")
        finally:
            conn.close()


class TestIndexCacheBusting(ServeTestBase):
    """首页要自己发，并且给脚本引用打版本戳。

    浏览器缓存是"代码明明改对了、界面还是旧的"这类怪现象的头号来源 ——
    之前真被它坑过（`self-image.js` 的旧副本被钉在 URL 上，表现成"脚本没跑起来"）。
    这套机制改动频率高，必须有人拦着。
    """

    def test_scripts_carry_a_version_stamp(self):
        status, body = self.get("/index.html")
        self.assertEqual(status, 200)
        html = body.decode("utf-8")
        for asset in ("app.js", "app.css", "gallery.js", "gallery-meta.js", "data/index.js"):
            self.assertIn(f'"{asset}?v=', html, asset + " 没有版本戳")

    def test_data_index_is_not_stamped(self):
        """self-image/index.js 是数据，不能带版本戳。

        用户每存一张图它就重写一次；它一变版本戳就变，会把所有脚本的 URL
        一起换掉、逼浏览器重新下载几十 KB。它本来就该每次重读。
        """
        _, body = self.get("/index.html")
        html = body.decode("utf-8")
        self.assertIn('"self-image/index.js"', html)
        self.assertNotIn('"self-image/index.js?v=', html)

    def test_index_is_served_no_store(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", "/index.html")
            resp = conn.getresponse()
            body = resp.read()
            self.assertEqual(resp.getheader("Cache-Control"), "no-store")
            self.assertEqual(resp.getheader("Content-Length"), str(len(body)))
        finally:
            conn.close()

    def test_stamp_changes_when_a_script_changes(self):
        """戳取的是这些文件里最新的 mtime —— 改一个，URL 就该变。"""
        _, body1 = self.get("/index.html")
        stamp1 = re.search(r'gallery\.js\?v=(\d+)', body1.decode("utf-8")).group(1)
        os.utime(self.tmp / "gallery.js", (time.time() + 10, time.time() + 10))
        _, body2 = self.get("/index.html")
        stamp2 = re.search(r'gallery\.js\?v=(\d+)', body2.decode("utf-8")).group(1)
        self.assertNotEqual(stamp1, stamp2, "改了脚本文件，版本戳却没变")


class TestSelfImageIndexFallback(ServeTestBase):
    """self-image/index.js 不存在时要回空索引，而不是 404。

    它是图库索引，存过图之后才生成；新装或清空后它不在，而 index.html 里有一条
    <script src="self-image/index.js"> 会去加载它。真回 404 的话，页面顶部那条自检
    横幅会误报「脚本没加载成功」，还把人往浏览器缓存上引 —— 实际只是文件还没有。
    """

    def test_missing_index_returns_empty_meta(self):
        self.assertFalse((self.tmp / "self-image" / "index.js").is_file(),
                         "这个用例的前提是索引不存在")
        status, body = self.get("/self-image/index.js")
        self.assertEqual(status, 200, "缺索引时不能 404")
        text = body.decode("utf-8")
        self.assertIn("window.SELF_META", text)
        self.assertIn("[]", text)

    def test_existing_index_is_served_verbatim(self):
        """文件真在的时候要原样发出去，不能被兜底顶掉。"""
        (self.tmp / "self-image" / "index.js").write_text(
            'window.SELF_META = [{"file":"a.jpg"}];\n', "utf-8")
        status, body = self.get("/self-image/index.js")
        self.assertEqual(status, 200)
        self.assertIn(b"a.jpg", body, "真实索引被兜底空索引顶掉了")

    def test_other_missing_files_still_404(self):
        """兜底只针对那一个文件 —— 别的路径该 404 还是 404，别把 404 全吃掉。"""
        status, _ = self.get("/self-image/nope.js")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
