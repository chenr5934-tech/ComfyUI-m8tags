"""路由层测试：真正把 handler 跑起来，覆盖本地取数、字段映射与静态伺服。

重点盯三件事：
  1. 短字段名映射对不对（本地负向字段叫 n，不是 negative）
  2. 两个语法版本有没有一起吐给前端
  3. 静态路由的路径穿越防护

不联网。

跑法：
    python tests/test_routes.py
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import json
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import make_mocked_request, TestClient, TestServer  # noqa: E402

from py import routes as routes_mod  # noqa: E402
from py import store  # noqa: E402
from py.nodes import CODEX_ANY, SYNTAX_OPTIONS  # noqa: E402


def call(handler, path, method="GET", match_info=None):
    # aiohttp 的 make_mocked_request 拿到 match_info=None 会构造失败（它要的是映射），
    # 只有完全不传时才用内部默认值。
    kwargs = {"match_info": match_info} if match_info is not None else {}
    request = make_mocked_request(method, path, **kwargs)
    return asyncio.run(handler(request))


def call_static(tail):
    request = make_mocked_request(
        "GET", f"/codex_atlas/atlas/{tail}", match_info={"tail": tail}
    )
    return asyncio.run(routes_mod._handle_atlas_static(request))


def body_of(response):
    return json.loads(response.text)


SOURCE_URL = "https://novelai.quicktagcloud.com/data-source.json"
CDN_BASE = "https://assets.quicktagcloud.com/data"


class TestOnlineData(unittest.TestCase):
    """在线取数。一个真请求都不发 —— _http_json 整个换成假的。

    这条链是四跳的：data-source.json → current.json → codexes.json → 各法典。
    少接一跳、或者发布号换了没作废旧缓存，都会表现成「随机抽词时好时坏」，
    所以每一段都单独验。
    """

    RELEASE = "r-test123"

    def setUp(self):
        self.calls = []
        base = "{}/releases/{}".format(CDN_BASE, self.RELEASE)
        self.payloads = {
            SOURCE_URL: {"baseUrl": CDN_BASE, "pointer": "current.json"},
            CDN_BASE + "/current.json": {"release": self.RELEASE},
            base + "/codexes.json": [
                {"id": "suozhang", "title": "所长", "entryCount": 2},
                {"id": "artist_nai5_personal", "title": "画师词典", "entryCount": 1},
                {"id": "mengshen_r18", "title": "梦神R18", "entryCount": 1},
            ],
            base + "/suozhang.json": {"entries": [
                {"id": "a", "title": "甲", "tags": "1.2::cat::, dog", "negative": "lowres"},
                {"id": "b", "title": "乙", "tags": "bird", "negative": ""},
            ]},
            base + "/artist_nai5_personal.json": {"entries": [
                {"id": "p1", "title": "画师甲", "tags": "artist:someone", "negative": ""},
            ]},
            base + "/mengshen_r18.json": {"entries": [
                {"id": "r1", "title": "R18 词条", "tags": "nsfw thing", "negative": ""},
            ]},
        }
        self.orig = routes_mod._http_json
        routes_mod._http_json = self._fake
        self.reset_online()

    def tearDown(self):
        routes_mod._http_json = self.orig
        self.reset_online()

    def reset_online(self):
        with routes_mod._online_lock:
            routes_mod._online.update(
                {"at": 0.0, "release": "", "base": "", "codexes": None, "entries": {}})

    def _fake(self, url, timeout=30):
        self.calls.append(url)
        if url not in self.payloads:
            raise RuntimeError("假的取数层没有这个地址：{}".format(url))
        return self.payloads[url]

    # ------------------------------------------------------------ 取数链

    def test_codexes_lists_what_the_manifest_says(self):
        data = body_of(call(routes_mod._handle_codexes, "/codex_atlas/codexes"))
        self.assertTrue(data["ok"])
        self.assertEqual([c["id"] for c in data["codexes"]],
                         ["suozhang", "artist_nai5_personal", "mengshen_r18"])
        self.assertTrue(data["online"], "没标出这是在线数据")
        self.assertEqual(data["release"], self.RELEASE)

    def test_r18_is_recognised_by_id_suffix(self):
        """线上清单里没有 nsfw 字段，R18 靠 id 后缀认 —— 认错了就会把 R18
        混进「不含 R18」的默认池子里。"""
        data = body_of(call(routes_mod._handle_codexes, "/codex_atlas/codexes"))
        by_id = {c["id"]: c for c in data["codexes"]}
        self.assertTrue(by_id["mengshen_r18"]["nsfw"])
        self.assertFalse(by_id["suozhang"]["nsfw"])

    def test_manifest_is_cached_between_calls(self):
        call(routes_mod._handle_codexes, "/codex_atlas/codexes")
        n = len(self.calls)
        call(routes_mod._handle_codexes, "/codex_atlas/codexes")
        self.assertEqual(len(self.calls), n, "第二次还在联网，缓存没起作用")

    def test_refresh_bypasses_the_cache(self):
        call(routes_mod._handle_codexes, "/codex_atlas/codexes")
        n = len(self.calls)
        call(routes_mod._handle_codexes, "/codex_atlas/codexes?refresh=1")
        self.assertGreater(len(self.calls), n, "refresh=1 没能强制重取")

    def test_new_release_throws_away_cached_entries(self):
        """站点发新版之后旧词条必须作废 —— 不然会拿上一版的词条当最新，
        而且自己还不知道。"""
        routes_mod._online_entries("suozhang")
        self.assertTrue(routes_mod._online["entries"].get("suozhang"))

        self.payloads[CDN_BASE + "/current.json"] = {"release": "r-next"}
        with routes_mod._online_lock:
            routes_mod._online["at"] = 0.0        # 让发布指针过期，逼它重取
        self.payloads["{}/releases/r-next/codexes.json".format(CDN_BASE)] = []

        routes_mod._online_base()
        self.assertEqual(routes_mod._online["release"], "r-next")
        self.assertEqual(routes_mod._online["entries"], {}, "换版后旧词条缓存还在")

    def test_unreachable_source_reports_502(self):
        def boom(url, timeout=30):
            raise OSError("连不上")
        routes_mod._http_json = boom
        r = call(routes_mod._handle_codexes, "/codex_atlas/codexes")
        self.assertEqual(r.status, 502)
        self.assertIn("失败", body_of(r)["error"])

    # ------------------------------------------------------------ 随机抽词

    def test_random_returns_nai_and_negative(self):
        data = body_of(call(routes_mod._handle_random, "/codex_atlas/random"))
        self.assertTrue(data["ok"])
        self.assertEqual(data["codex"], "suozhang", "默认池子里只该有非 R18 的非画师法典")
        self.assertTrue(data["nai"], "没有 nai 字段")
        self.assertIn("negative", data)
        self.assertTrue(data["title"])

    def test_random_skips_artist_codices_by_default(self):
        for _ in range(30):
            data = body_of(call(routes_mod._handle_random, "/codex_atlas/random"))
            self.assertFalse(str(data["codex"]).startswith("artist_"),
                             "全集随机抽到了画师词典：{}".format(data["codex"]))

    def test_random_skips_r18_by_default(self):
        for _ in range(20):
            data = body_of(call(routes_mod._handle_random, "/codex_atlas/random"))
            self.assertNotEqual(data["codex"], "mengshen_r18", "默认把 R18 抽出来了")

    def test_random_can_be_pointed_at_an_artist_codex(self):
        data = body_of(call(routes_mod._handle_random,
                            "/codex_atlas/random?codex=artist_nai5_personal"))
        self.assertTrue(data["ok"])
        self.assertEqual(data["codex"], "artist_nai5_personal")
        self.assertEqual(data["nai"], "artist:someone")

    def test_random_rejects_unknown_codex(self):
        r = call(routes_mod._handle_random, "/codex_atlas/random?codex=not_there")
        self.assertEqual(r.status, 404)

    def test_random_survives_a_broken_source(self):
        def boom(url, timeout=30):
            raise OSError("连不上")
        routes_mod._http_json = boom
        r = call(routes_mod._handle_random, "/codex_atlas/random")
        self.assertEqual(r.status, 502)


class FakeJsonRequest:
    """只实现 handler 用到的 request.json() 与 request.headers。"""

    def __init__(self, payload, headers=None):
        self._payload = payload
        self.headers = headers or {}

    async def json(self):
        return self._payload


class SelfImageTestBase(unittest.TestCase):
    """self-image 那几个 handler 会真的写文件、删文件、写删除流水。

    所以所有相关测试类都继承这里：把 store.ATLAS_DIR 指到临时目录，
    绝不碰站点里真实的 self-image/（曾经污染过一次 —— 测试记录留在了
    真索引里，delete-log.txt 也写进了真目录）。
    """

    RAW = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24

    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="codex-atlas-test-"))
        self._old_atlas = routes_mod.store.ATLAS_DIR
        routes_mod.store.ATLAS_DIR = self._tmp

    def tearDown(self):
        routes_mod.store.ATLAS_DIR = self._old_atlas
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _save(self, payload):
        return asyncio.run(routes_mod._handle_self_image_save(FakeJsonRequest(payload)))

    def _delete(self, payload):
        return asyncio.run(routes_mod._handle_self_image_delete(FakeJsonRequest(payload)))

    def _group(self, payload):
        return asyncio.run(routes_mod._handle_self_image_group(FakeJsonRequest(payload)))

    def _body(self, resp):
        return json.loads(resp.text)

    def _b64(self, raw=None):
        return base64.b64encode(raw if raw is not None else self.RAW).decode()

    def _index(self):
        return routes_mod._read_self_index(routes_mod._self_image_dir())

    def _files(self):
        return {e["file"] for e in self._index() if isinstance(e, dict)}


class TestSelfImageEndpoints(SelfImageTestBase):
    """我的图库：网页不能凭磁盘路径写文件，所以由后端代写站点里的 self-image/。"""

    NAME = "__self_test__.png"

    def test_save_then_read_back(self):
        resp = self._save({
            "file": self.NAME,
            "data": base64.b64encode(self.RAW).decode(),
            "meta": {"source": "a1111", "loras": [{"name": "x"}]},
        })
        self.assertEqual(resp.status, 200)
        data = self._body(resp)
        self.assertTrue(data["ok"], data.get("error"))

        directory = Path(data["dir"])
        target = directory / self.NAME
        self.assertTrue(target.is_file(), "图片没落盘")
        self.assertEqual(target.read_bytes(), self.RAW, "写进去的字节和原始不一致")

        entries = [e for e in routes_mod._read_self_index(directory) if e.get("file") == self.NAME]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["meta"]["source"], "a1111")
        self.assertEqual(entries[0]["size"], len(self.RAW))

    def test_same_name_overwrites_instead_of_duplicating(self):
        payload = {"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}}
        self._save(payload)
        self._save(payload)
        entries = [e for e in routes_mod._read_self_index(routes_mod._self_image_dir())
                   if e.get("file") == self.NAME]
        self.assertEqual(len(entries), 1, "同名保存应在索引里覆盖，而不是追加")

    def test_delete_removes_both_file_and_entry(self):
        """默认就是真删（前端会先弹模态警告确认）。"""
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        data = self._body(self._delete({"file": self.NAME}))
        self.assertTrue(data["ok"], data.get("error"))
        self.assertTrue(data["removed"])
        self.assertFalse(data["keptFile"])
        self.assertFalse((routes_mod._self_image_dir() / self.NAME).exists())
        entries = [e for e in routes_mod._read_self_index(routes_mod._self_image_dir())
                   if e.get("file") == self.NAME]
        self.assertEqual(entries, [])

    def test_delete_with_keep_file_true_leaves_the_image(self):
        """keepFile=true 时只摘索引，原图原地不动。"""
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        data = self._body(self._delete({"file": self.NAME, "keepFile": True}))
        self.assertTrue(data["ok"], data.get("error"))
        self.assertFalse(data["removed"], "keepFile=true 不该删文件")
        self.assertTrue(data["keptFile"])
        self.assertTrue((routes_mod._self_image_dir() / self.NAME).is_file(), "原图应当还在")
        entries = [e for e in routes_mod._read_self_index(routes_mod._self_image_dir())
                   if e.get("file") == self.NAME]
        self.assertEqual(entries, [], "索引记录应当摘掉")

    def test_filename_is_sanitised(self):
        """只取文件名本身，别顺着 ../ 跑到上级目录去。"""
        data = self._body(self._save({
            "file": "../../evil.png",
            "data": base64.b64encode(self.RAW).decode(),
            "meta": {},
        }))
        self.assertTrue(data["ok"], data.get("error"))
        self.assertEqual(data["file"], "evil.png")
        self.assertTrue((routes_mod._self_image_dir() / "evil.png").is_file())
        self.assertFalse((routes_mod._self_image_dir().parent / "evil.png").exists())

    def test_bad_base64_returns_400(self):
        self.assertEqual(self._save({"file": self.NAME, "data": "!!!!", "meta": {}}).status, 400)

    def test_missing_data_returns_400(self):
        self.assertEqual(self._save({"file": self.NAME}).status, 400)

    # ---- 分组 ----

    def _entry(self):
        entries = [e for e in routes_mod._read_self_index(routes_mod._self_image_dir())
                   if e.get("file") == self.NAME]
        return entries[0] if entries else None

    def test_save_carries_group_into_index(self):
        self._save({
            "file": self.NAME,
            "data": base64.b64encode(self.RAW).decode(),
            "meta": {},
            "group": "萝莉",
        })
        self.assertEqual(self._entry().get("group"), "萝莉")

    def test_save_without_group_leaves_entry_clean(self):
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        self.assertNotIn("group", self._entry(), "没指定分组时不该往索引里塞空字段")

    def test_group_moves_existing_entry_without_touching_the_image(self):
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        data = self._body(self._group({"file": self.NAME, "group": "风景"}))
        self.assertTrue(data["ok"], data.get("error"))
        self.assertEqual(self._entry().get("group"), "风景")
        # 原图必须原封不动 —— 分组只是索引里的元信息
        self.assertEqual((routes_mod._self_image_dir() / self.NAME).read_bytes(), self.RAW)

    def test_group_empty_string_moves_back_to_ungrouped(self):
        self._save({
            "file": self.NAME,
            "data": base64.b64encode(self.RAW).decode(),
            "meta": {},
            "group": "临时",
        })
        self.assertEqual(self._entry().get("group"), "临时")
        self._group({"file": self.NAME, "group": ""})
        self.assertNotIn("group", self._entry())

    def test_group_unknown_file_returns_404(self):
        resp = self._group({"file": "__not_in_index__.png", "group": "x"})
        self.assertEqual(resp.status, 404)

    def test_group_returns_known_group_list(self):
        self._save({
            "file": self.NAME,
            "data": base64.b64encode(self.RAW).decode(),
            "meta": {},
            "group": "甲",
        })
        data = self._body(self._group({"file": self.NAME, "group": "乙"}))
        self.assertIn("乙", data["groups"])

    def test_group_name_is_trimmed_before_storing(self):
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        data = self._body(self._group({"file": self.NAME, "group": "  带空格  "}))
        self.assertTrue(data["ok"], data.get("error"))
        self.assertEqual(self._entry().get("group"), "带空格")

    def test_group_request_path_traversal_is_neutralised(self):
        """file 走的是和存图一样的清洗，别顺着 ../ 去改别的目录。"""
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        resp = self._group({"file": "../" + self.NAME, "group": "x"})
        self.assertEqual(resp.status, 200, "清洗后应当仍指向本目录里的那张图")
        self.assertEqual(self._entry().get("group"), "x")

    # ---- 删除流水 ----

    def test_delete_is_logged(self):
        """删图不可逆，要留流水：谁、什么时候、删了哪个。"""
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        self._delete({"file": self.NAME})
        log = routes_mod._self_image_dir() / "delete-log.txt"
        self.assertTrue(log.is_file(), "删除没留下流水")
        text = log.read_text("utf-8")
        self.assertIn(self.NAME, text)
        self.assertIn("删除", text)

    def test_keep_file_is_logged_differently(self):
        self._save({"file": self.NAME, "data": base64.b64encode(self.RAW).decode(), "meta": {}})
        self._delete({"file": self.NAME, "keepFile": True})
        text = (routes_mod._self_image_dir() / "delete-log.txt").read_text("utf-8")
        self.assertIn("摘索引", text)


class TestReservedNames(SelfImageTestBase):
    """self-image/ 里有几个名字是给系统用的，不能被图片文件撞上。"""

    def test_image_named_index_js_cannot_clobber_the_index(self):
        self._save({"file": "good.png", "data": self._b64(), "meta": {}})
        data = self._body(self._save({"file": "index.js", "data": self._b64(), "meta": {}}))
        self.assertEqual(data["file"], "image_index.js", "保留名应当被改名")

        index_file = routes_mod._self_image_dir() / "index.js"
        self.assertIn("SELF_META", index_file.read_text("utf-8"), "索引文件被图片字节覆盖了")
        self.assertIn("good.png", self._files(), "原有记录被冲掉了")

    def test_other_reserved_names_are_renamed_too(self):
        for name in ("index.js.bak", "delete-log.txt"):
            data = self._body(self._save({"file": name, "data": self._b64(), "meta": {}}))
            self.assertEqual(data["file"], "image_" + name, name + " 没被改名")


class TestBrokenIndex(SelfImageTestBase):
    """索引读不出来时必须停下，绝不能当成空索引继续写 —— 那会把记录全抹掉。"""

    def _break_index(self):
        d = routes_mod._self_image_dir()
        (d / "index.js").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe\x00 not-utf8 at all")

    def test_save_refuses_and_leaves_the_broken_file_alone(self):
        self._save({"file": "keep.png", "data": self._b64(), "meta": {}})
        self._break_index()
        resp = self._save({"file": "new.png", "data": self._b64(), "meta": {}})
        self.assertEqual(resp.status, 500, "坏索引时不该假装保存成功")
        self.assertIn(b"not-utf8", (routes_mod._self_image_dir() / "index.js").read_bytes(),
                      "坏索引被覆盖了，等于把线索也毁了")

    def test_group_refuses(self):
        self._save({"file": "keep.png", "data": self._b64(), "meta": {}})
        self._break_index()
        self.assertEqual(self._group({"file": "keep.png", "group": "x"}).status, 500)

    def test_delete_refuses_to_wipe(self):
        self._save({"file": "keep.png", "data": self._b64(), "meta": {}})
        self._break_index()
        self.assertEqual(
            self._delete({"file": "keep.png", "keepFile": True}).status, 500)


class TestTrickyIndexContent(SelfImageTestBase):
    """记录里出现 `];` 不能把索引切坏 —— 非贪婪正则会在这里断掉。"""

    def test_semicolon_bracket_in_prompt_survives(self):
        self._save({"file": "__t__.png", "data": self._b64(),
                    "meta": {"source": "a1111", "positive": "artist:x]; with semicolon"}})
        entries = self._index()
        self.assertEqual(len(entries), 1, "索引被截断了")
        self.assertEqual(entries[0]["meta"]["positive"], "artist:x]; with semicolon")

    def test_earlier_records_survive_a_tricky_later_one(self):
        self._save({"file": "keep.png", "data": self._b64(), "meta": {}})
        self._save({"file": "tricky.png", "data": self._b64(),
                    "meta": {"positive": "foo];bar"}})
        self._save({"file": "last.png", "data": self._b64(), "meta": {}})
        self.assertEqual(self._files(), {"keep.png", "tricky.png", "last.png"})


class TestConcurrentSave(SelfImageTestBase):
    """索引是「读出来 → 改 → 写回去」。aiohttp 单进程多连接，不加锁会静默丢记录。"""

    def test_parallel_saves_do_not_lose_records(self):
        n = 8
        barrier = threading.Barrier(n)

        def one(i):
            barrier.wait()          # 尽量让 8 个请求同时打进去
            return self._save({"file": f"__par_{i}__.png", "data": self._b64(), "meta": {}})

        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
            results = list(pool.map(one, range(n)))

        for i, resp in enumerate(results):
            self.assertEqual(resp.status, 200, f"第 {i} 个并发保存失败")

        files = self._files()
        for i in range(n):
            self.assertIn(f"__par_{i}__.png", files, "并发保存丢了记录")


class TestDeleteLogInjection(SelfImageTestBase):
    """请求头里的控制字符能往日志里插伪造行。"""

    def test_forged_header_cannot_add_a_log_line(self):
        self._save({"file": "__t__.png", "data": self._b64(), "meta": {}})
        asyncio.run(routes_mod._handle_self_image_delete(FakeJsonRequest(
            {"file": "__t__.png"},
            headers={"User-Agent": "Mozilla/5.0\rFORGED-UA-LINE",
                     "Referer": "http://x/\rFORGED-REF-LINE"},
        )))
        log = (routes_mod._self_image_dir() / "delete-log.txt").read_text("utf-8")
        lines = [ln for ln in log.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, "删除流水被插进了伪造行：\n" + log)
        self.assertNotIn("\r", lines[0])


class TestCleanHeader(unittest.TestCase):
    def test_strips_cr_and_lf(self):
        self.assertEqual(routes_mod._clean_header("a\r\nb"), "ab")
        self.assertEqual(routes_mod._clean_header("a\nb"), "ab")

    def test_keeps_tab_and_truncates(self):
        self.assertEqual(routes_mod._clean_header("a\tb"), "a\tb")
        self.assertEqual(len(routes_mod._clean_header("x" * 500, 70)), 70)

    def test_handles_none(self):
        self.assertEqual(routes_mod._clean_header(None), "")


class TestStatusEndpoint(unittest.TestCase):
    def test_status_says_online_and_has_self_image(self):
        data = body_of(call(routes_mod._handle_status, "/codex_atlas/status"))
        self.assertTrue(data["ok"])
        self.assertTrue(data["online"], "状态里没标出数据来自线上")
        self.assertEqual(data["mode"], "comfyui-plugin")
        self.assertIn("self-image", data["features"])
        self.assertNotIn("codexCount", data,
                         "本地法典数据已经删了，状态里不该再有这一项")


class TestAtlasStatic(unittest.TestCase):
    """静态伺服现在只伺候「我的图库」那一页 —— 法典站点本身不再伺服了。"""

    def test_gallery_page_is_served(self):
        r = call_static("gallery.html")
        self.assertEqual(r.status, 200)
        self.assertIn("我的图库", r.text)

    def test_empty_tail_falls_back_to_gallery(self):
        r = call_static("")
        self.assertEqual(r.status, 200)
        self.assertIn("我的图库", r.text)

    def test_gallery_scripts_carry_a_cache_busting_stamp(self):
        """页面里本站自己的代码要带 ?v= 版本戳。

        浏览器缓存是「文件改对了、界面还是旧的」这类怪现象的头号来源，
        表现常常是「某个脚本没跑起来」。把这条契约钉住。
        """
        r = call_static("gallery.html")
        for asset in ("app.css", "gallery.js", "gallery-meta.js"):
            self.assertIn('"{}?v='.format(asset), r.text, asset + " 没有版本戳")

    def test_data_file_is_not_stamped(self):
        """self-image/index.js 是**数据**，不能带版本戳。

        用户每存一张图它就重写一次；它一变版本戳就跟着变，
        会把所有脚本的 URL 一起换掉、逼浏览器重下几十 KB。
        """
        r = call_static("gallery.html")
        self.assertIn('"self-image/index.js"', r.text)
        self.assertNotIn('"self-image/index.js?v=', r.text)

    def test_gallery_is_not_cached(self):
        r = call_static("gallery.html")
        self.assertEqual(r.headers.get("Cache-Control"), "no-store")

    def test_missing_self_image_index_serves_empty(self):
        """图库索引是存图时才生成的，新装或清空后它并不存在 —— 但页面会去加载它。

        真回 404 的话，顶部那条自检横幅会误报「脚本没加载成功」，
        还把人往浏览器缓存上引（实际只是文件还没有）。所以这里必须回空索引。
        """
        d = Path(tempfile.mkdtemp(prefix="codex-atlas-noindex-"))
        old = store.ATLAS_DIR
        store.ATLAS_DIR = d
        try:
            self.assertFalse((d / "self-image" / "index.js").is_file())
            r = call_static("self-image/index.js")
            self.assertEqual(r.status, 200, "缺索引时不能 404")
            self.assertIn(b"window.SELF_META", r.body)
            self.assertIn(b"[]", r.body)
        finally:
            store.ATLAS_DIR = old
            shutil.rmtree(d, ignore_errors=True)

    def test_existing_self_image_index_is_served_as_is(self):
        """文件真在的时候要原样发出去，不能被那个空索引兜底顶掉。"""
        d = Path(tempfile.mkdtemp(prefix="codex-atlas-hasindex-"))
        (d / "self-image").mkdir(parents=True)
        (d / "self-image" / "index.js").write_text(
            'window.SELF_META = [{"file":"a.jpg"}];\n', "utf-8")
        old = store.ATLAS_DIR
        store.ATLAS_DIR = d
        try:
            r = call_static("self-image/index.js")
            self.assertEqual(r.status, 200)
            self.assertIsInstance(r, web.FileResponse, "真实索引被兜底空索引顶掉了")
            self.assertEqual(Path(r._path), d / "self-image" / "index.js")
        finally:
            store.ATLAS_DIR = old
            shutil.rmtree(d, ignore_errors=True)

    def test_scripts_are_no_cache_but_images_are_long_cached(self):
        self.assertEqual(call_static("gallery.js").headers.get("Cache-Control"), "no-cache")

        d = Path(tempfile.mkdtemp(prefix="codex-atlas-img-"))
        (d / "self-image").mkdir(parents=True)
        (d / "self-image" / "x.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
        old = store.ATLAS_DIR
        store.ATLAS_DIR = d
        try:
            r = call_static("self-image/x.png")
            self.assertIn("max-age=86400", r.headers.get("Cache-Control", ""))
        finally:
            store.ATLAS_DIR = old
            shutil.rmtree(d, ignore_errors=True)

    def test_traversal_blocked(self):
        for bad in ("../py/store.py", "../../other-plugin/py/nodes.py", "..%2F..%2Fmain.py"):
            with self.assertRaises(web.HTTPNotFound, msg="没挡住：{}".format(bad)):
                call_static(bad)


class TestResolveUnder(unittest.TestCase):
    """静态伺服和删图都靠 _resolve_under 挡路径穿越。

    原来的用例只拿"站点外的某个路径"，返回 404 其实是因为文件根本不存在 ——
    换任何不存在的相对路径都能过，证明不了防护有效。这里造一个**真实存在**
    的站点外文件来打，目标存在却仍然拿不到，才算数。
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="codex-resolve-"))
        (self.root / "data").mkdir()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_cannot_reach_a_real_file_outside(self):
        outside = self.root.parent / "codex-secret-probe.txt"
        outside.write_text("secret", "utf-8")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        self.assertIsNone(
            routes_mod._resolve_under(self.root, "../" + outside.name),
            "站点外真实存在的文件竟然被解析到了")
        self.assertIsNone(routes_mod._resolve_under(self.root, "..\\" + outside.name))
        self.assertIsNone(
            routes_mod._resolve_under(self.root, "data/../../" + outside.name))

    def test_inside_paths_still_resolve(self):
        target = routes_mod._resolve_under(self.root, "data/index.js")
        self.assertIsNotNone(target)
        self.assertEqual(target, (self.root / "data" / "index.js").resolve())

    def test_empty_tail_is_refused(self):
        self.assertIsNone(routes_mod._resolve_under(self.root, ""))
        self.assertIsNone(routes_mod._resolve_under(self.root, None))


class TestRealHttpLayer(unittest.TestCase):
    """真起一个 aiohttp 服务、真发 HTTP 请求。

    上面那些用例都是直接调 handler —— 逻辑是对的，但"装进路由表、经过 aiohttp
    的 JSON 序列化与静态文件层"这一层没验过。中文编码、Content-Type、
    路径穿越回 404，都是到这一步才定下来的。
    """

    def setUp(self):
        self.app = web.Application()
        self.app.router.add_get("/codex_atlas/status", routes_mod._handle_status)
        self.app.router.add_get("/codex_atlas/atlas/{tail:.*}", routes_mod._handle_atlas_static)

    def _get(self, path):
        async def run():
            server = TestServer(self.app)
            client = TestClient(server)
            await client.start_server()
            try:
                async with client.get(path) as resp:
                    body = await resp.text()
                    return resp.status, dict(resp.headers), body
            finally:
                await client.close()
        return asyncio.run(run())

    def test_status_over_real_http(self):
        status, headers, body = self._get("/codex_atlas/status")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertTrue(data["online"])

    def test_gallery_over_real_http(self):
        status, headers, body = self._get("/codex_atlas/atlas/gallery.html")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        self.assertIn("我的图库", body, "中文内容在 HTTP 这一层丢了")

    def test_unknown_tail_is_404(self):
        status, _, _ = self._get("/codex_atlas/atlas/nope/nothing.js")
        self.assertEqual(status, 404)

    def test_traversal_over_real_http(self):
        status, _, _ = self._get("/codex_atlas/atlas/..%2F..%2Fpy%2Fstore.py")
        self.assertEqual(status, 404, "真的走 HTTP 时路径穿越没挡住")


if __name__ == "__main__":
    unittest.main(verbosity=2)
