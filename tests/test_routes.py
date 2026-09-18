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
from aiohttp.test_utils import make_mocked_request  # noqa: E402

from py import routes as routes_mod  # noqa: E402
from py import store  # noqa: E402
from py.nodes import CODEX_ANY, SYNTAX_OPTIONS  # noqa: E402


def _codex_ids() -> set:
    """当前数据里有哪几部法典。

    站点数据是可替换的，用到特定法典的用例在缺数据时跳过而不是失败
    —— 别人的数据集里未必有 suozhang。
    """
    try:
        return {m.get("id") for m in store.get_meta_list()}
    except Exception:
        return set()


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


class TestCodexesEndpoint(unittest.TestCase):
    def test_ok_shape(self):
        response = call(routes_mod._handle_codexes, "/codex_atlas/codexes")
        self.assertEqual(response.status, 200)
        data = body_of(response)
        self.assertTrue(data["ok"])
        self.assertGreater(len(data["codexes"]), 0)
        self.assertEqual(data["anyLabel"], CODEX_ANY)
        self.assertEqual(data["syntaxOptions"], SYNTAX_OPTIONS)
        self.assertTrue(data["dataMtime"], "没有返回本地数据时间")

    def test_chinese_is_not_escaped(self):
        response = call(routes_mod._handle_codexes, "/codex_atlas/codexes")
        self.assertIn("法典", response.text)
        self.assertNotIn("\\u6cd5", response.text)

    def test_codex_entries_have_required_fields(self):
        data = body_of(call(routes_mod._handle_codexes, "/codex_atlas/codexes"))
        for codex in data["codexes"]:
            self.assertTrue(codex["id"])
            self.assertTrue(codex["title"])
            self.assertIsInstance(codex["nsfw"], bool)
            self.assertIsInstance(codex["entryCount"], int)


class TestRandomEndpoint(unittest.TestCase):
    def test_random_any(self):
        response = call(routes_mod._handle_random, "/codex_atlas/random")
        self.assertEqual(response.status, 200)
        data = body_of(response)
        self.assertTrue(data["ok"])
        self.assertTrue(data["tags"].strip())
        self.assertFalse(data["nsfw"], "默认池里混进了 R18 法典")

    def test_negative_short_field_is_mapped(self):
        """本地负向字段叫 n，映射漏了就会一直返回空串。

        特意用 community_ai_misc（5156 条里 5147 条带负向）来测。
        换 suozhang_r18 只有 402/11597 带负向，抽样撞运气的写法会变成偶发失败。
        """
        if "community_ai_misc" not in _codex_ids():
            self.skipTest("测试数据里没有 community_ai_misc")
        for _ in range(3):
            data = body_of(call(routes_mod._handle_random, "/codex_atlas/random?codex=community_ai_misc"))
            if str(data.get("negative") or "").strip():
                return
        self.fail("连抽 3 次都没拿到负向标签，n 字段很可能没映射")

    def test_both_syntax_versions_returned(self):
        """两个语法版本都得给前端，缺了「原始 NAI」模式就没内容。"""
        if "suozhang" not in _codex_ids():
            self.skipTest("测试数据里没有 suozhang")
        if store.raw_dir() is None:
            self.skipTest("没有原始 NAI 数据源，跳过配对校验")
        data = body_of(call(routes_mod._handle_random, "/codex_atlas/random?codex=suozhang"))
        self.assertTrue(data["tags"].strip())
        self.assertIn("tagsNai", data)
        self.assertIn("negative", data)
        self.assertIn("negativeNai", data)

        # suozhang 的 raw 与 data 配对率在 90% 以上，抽几次必然命中；连抽 8 次空才是真有问题
        for _ in range(8):
            d = body_of(call(routes_mod._handle_random, "/codex_atlas/random?codex=suozhang"))
            if d.get("tagsNai"):
                self.assertNotEqual(d["tags"], d["tagsNai"], "两版内容相同，配对取错了")
                return
        self.fail("连抽 8 次都拿不到原始 NAI 版本")

    def test_image_url(self):
        # composition_style 的 64 条全都带图，可以稳定断言
        if "composition_style" not in _codex_ids():
            self.skipTest("测试数据里没有 composition_style")
        data = body_of(call(routes_mod._handle_random, "/codex_atlas/random?codex=composition_style"))
        self.assertTrue(data["image"], "composition_style 应该每条都带图")
        self.assertTrue(data["imageUrl"].startswith("/codex_atlas/atlas/images/"))

    def test_unknown_codex_returns_404_json(self):
        response = call(routes_mod._handle_random, "/codex_atlas/random?codex=__nope__")
        self.assertEqual(response.status, 404)
        data = body_of(response)
        self.assertFalse(data["ok"])
        self.assertIn("__nope__", data["error"])

    def test_explicit_nsfw_codex_allowed(self):
        if "mengshen_r18" not in _codex_ids():
            self.skipTest("测试数据里没有 mengshen_r18")
        response = call(routes_mod._handle_random, "/codex_atlas/random?codex=mengshen_r18")
        self.assertEqual(response.status, 200)
        data = body_of(response)
        self.assertTrue(data["ok"])
        self.assertEqual(data["codex"], "mengshen_r18")
        self.assertTrue(data["nsfw"])


    def test_any_pool_skips_artist_codices(self):
        """「全部法典」模式下不抽画师词典。

        画师词典通篇是画师 tag，一条就能把整张图的画风带偏，混进随机结果里
        跟抽到普通词条完全不是一回事。连抽 40 次（若没排除，按 11 部里漏 2 部算
        期望会撞上约 6 次），一次都不该落到 artist_* 上。
        """
        artists = {i for i in _codex_ids() if str(i).startswith(routes_mod.ARTIST_CODEX_PREFIX)}
        if not artists:
            self.skipTest("测试数据里没有画师词典")
        seen = set()
        for _ in range(40):
            data = body_of(call(routes_mod._handle_random, "/codex_atlas/random"))
            self.assertTrue(data["ok"])
            seen.add(data["codex"])
            self.assertFalse(
                str(data["codex"]).startswith(routes_mod.ARTIST_CODEX_PREFIX),
                "全集随机抽到了画师词典：{}".format(data["codex"]),
            )
        self.assertTrue(seen, "一次都没抽到内容")

    def test_artist_codex_still_drawable_when_explicit(self):
        """明确选中画师词典时要照抽 —— 这条规则不能把人堵死。"""
        artists = sorted(i for i in _codex_ids() if str(i).startswith(routes_mod.ARTIST_CODEX_PREFIX))
        if not artists:
            self.skipTest("测试数据里没有画师词典")
        cid = artists[0]
        data = body_of(call(routes_mod._handle_random, "/codex_atlas/random?codex=" + cid))
        self.assertTrue(data["ok"])
        self.assertEqual(data["codex"], cid)
        self.assertTrue(str(data["tags"]).strip())


class TestEntryEndpoint(unittest.TestCase):
    """小窗里点「加入已选栏」靠这个接口补齐两个语法版本。"""

    def test_entry_by_id(self):
        if "suozhang" not in _codex_ids():
            self.skipTest("测试数据里没有 suozhang")
        data = body_of(call(
            routes_mod._handle_entry,
            "/codex_atlas/entry?codex=suozhang&id=suozhang-0001",
        ))
        self.assertTrue(data["ok"])
        self.assertEqual(data["id"], "suozhang-0001")
        self.assertEqual(data["codex"], "suozhang")
        self.assertTrue(data["tags"].strip(), "没有 A1111 版本")
        self.assertTrue(data["tagsNai"].strip(), "这条应该有原始 NAI 版本")
        self.assertNotEqual(data["tags"], data["tagsNai"], "两个版本不该相同")

    def test_missing_params_400(self):
        for path in ("/codex_atlas/entry", "/codex_atlas/entry?codex=suozhang", "/codex_atlas/entry?id=x"):
            response = call(routes_mod._handle_entry, path)
            self.assertEqual(response.status, 400, path)

    def test_unknown_entry_404(self):
        response = call(routes_mod._handle_entry, "/codex_atlas/entry?codex=suozhang&id=__nope__")
        self.assertEqual(response.status, 404)
        self.assertFalse(body_of(response)["ok"])

    def test_unknown_codex_404(self):
        response = call(routes_mod._handle_entry, "/codex_atlas/entry?codex=__nope__&id=x")
        self.assertEqual(response.status, 404)


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
    def test_status(self):
        data = body_of(call(routes_mod._handle_status, "/codex_atlas/status"))
        self.assertTrue(data["ok"], f"状态异常：{data.get('error')}")
        self.assertGreater(data["codexCount"], 0)


def _first_image_tail():
    """从站点 images/ 里挑一张真实存在的图，用来验证图片的长缓存头。"""
    images = store.IMAGES_DIR
    if images.is_dir():
        for codex in sorted(images.iterdir()):
            if not codex.is_dir():
                continue
            for f in sorted(codex.iterdir()):
                if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                    return f"images/{codex.name}/{f.name}"
    raise unittest.SkipTest("站点 images/ 里没有图")


class TestAtlasStatic(unittest.TestCase):
    def test_index_served(self):
        response = call_static("index.html")
        self.assertEqual(response.status, 200)
        self.assertIn("法典图鉴", response.text)

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
            # 文件在时走的是正常的 FileResponse（流式发文件），不是那个空索引兜底。
            self.assertIsInstance(r, web.FileResponse, "真实索引被兜底空索引顶掉了")
            self.assertEqual(Path(r._path), d / "self-image" / "index.js")
        finally:
            store.ATLAS_DIR = old
            shutil.rmtree(d, ignore_errors=True)

    def test_index_scripts_carry_a_cache_busting_stamp(self):
        """首页里本站**代码**要带 ?v= 版本戳。

        浏览器缓存是"代码改对了、界面还是旧的"这类怪现象的头号来源，
        表现常常是"某个脚本没跑起来"。这里把这条契约钉住。
        """
        response = call_static("index.html")
        for asset in ("app.js", "gallery.js", "gallery-meta.js", "data/index.js"):
            self.assertIn(f'"{asset}?v=', response.text, asset + " 没有版本戳")

    def test_index_data_file_is_not_stamped(self):
        """self-image/index.js 是**数据**，不能带版本戳。

        用户每存一张图它就重写一次；它一变，版本戳就跟着变，
        会把所有脚本的 URL 一起换掉、逼浏览器重新下载几十 KB。
        它本来就该每次重读（响应头是 no-cache）。
        """
        response = call_static("index.html")
        self.assertIn('"self-image/index.js"', response.text)
        self.assertNotIn('"self-image/index.js?v=', response.text)

    def test_index_is_not_cached(self):
        response = call_static("index.html")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")

    def test_empty_tail_falls_back_to_index(self):
        response = call_static("")
        self.assertEqual(response.status, 200)

    def test_data_file_served(self):
        response = call_static("data/index.js")
        self.assertEqual(response.status, 200)
        self.assertIn("QTC_META", Path(response._path).read_text("utf-8"))

    def test_scripts_are_no_cache_but_images_are_long_cached(self):
        self.assertEqual(call_static("app.js").headers.get("Cache-Control"), "no-cache")
        image = call_static(_first_image_tail())
        self.assertIn("max-age=86400", image.headers.get("Cache-Control", ""))

    def test_traversal_blocked(self):
        for bad in ("../py/store.py", "../../ComfyUI-CodexAtlas/py/nodes.py", "..%2F..%2Fmain.py"):
            with self.assertRaises(web.HTTPNotFound, msg=f"没挡住：{bad}"):
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


class TestShortFieldMapping(SelfImageTestBase):
    """本地数据里负向提示词被压成短字段 `n`，取词条时要映射回 negative。

    原来这条靠真实数据集里的某本特定法典，那本不存在就整条 skipTest ——
    最容易因数据格式变化而静默失效的映射反而没人守。这里用自造的 entry 直接测。
    """

    def test_short_negative_field_maps_to_negative(self):
        payload = routes_mod._entry_payload(
            "no_such_codex",
            {"id": "t1", "title": "标题", "tags": "a, b", "n": "低质量, 崩坏"},
            {"title": "假法典"},
        )
        self.assertEqual(payload["negative"], "低质量, 崩坏")
        self.assertEqual(payload["tags"], "a, b")

    def test_long_negative_field_name_is_not_part_of_the_contract(self):
        """data/*.js 里负向压成短名 `n`，这是本地数据的格式契约。

        完整的 `negative` 字段名**不**被读取 —— 把它钉在这里，将来谁想改
        解析行为（不管是有意还是顺手）都会立刻撞上这条测试。
        """
        payload = routes_mod._entry_payload(
            "no_such_codex",
            {"id": "t2", "title": "x", "tags": "a", "negative": "完整字段名"},
            None,
        )
        self.assertEqual(payload["negative"], "")

    def test_missing_negative_is_empty_string(self):
        payload = routes_mod._entry_payload(
            "no_such_codex", {"id": "t3", "title": "x", "tags": "a"}, None)
        self.assertEqual(payload["negative"], "")

    def test_sniff_mime_uses_content_not_extension(self):
        """图片类型按内容判，不按扩展名。

        下载脚本把 PNG 源图统一转成了 JPEG 以压体积，但文件名仍留着 .png；
        只按扩展名给 Content-Type 就会发出 image/png 配 JPEG 数据。
        """
        from py.routes import _sniff_image_mime

        cases = {
            "名为 .png 实为 JPEG": (b"\xff\xd8\xff\xe0" + b"\x00" * 8, "image/jpeg"),
            "名为 .jpg 实为 PNG": (b"\x89PNG\r\n\x1a\n" + b"\x00" * 4, "image/png"),
            "WebP": (b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 4, "image/webp"),
            "GIF": (b"GIF89a" + b"\x00" * 6, "image/gif"),
            "不是图片": (b"definitely not an image", None),
            "太短": (b"\xff\xd8", None),
            "空": (b"", None),
        }
        for label, (head, expect) in cases.items():
            self.assertEqual(_sniff_image_mime(head), expect, label)

    def test_missing_file_404(self):
        with self.assertRaises(web.HTTPNotFound):
            call_static("nope/does-not-exist.jpg")


class TestImagesFetch(unittest.TestCase):
    """例图拉取：状态接口、confirm 门槛，以及几条容易踩的实现细节。

    不联网、不真下载 —— 真的去拉 1.3 GB 不该进单元测试。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="codex-atlas-fetch-"))
        self._atlas = store.ATLAS_DIR
        store.ATLAS_DIR = self.tmp
        with routes_mod._fetch_lock:
            routes_mod._fetch_state.update({
                "stage": "idle", "message": "", "done": 0, "total": 0,
                "error": None, "startedAt": 0.0, "usedTool": "",
            })

    def tearDown(self):
        store.ATLAS_DIR = self._atlas
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_status_reports_count_and_shape(self):
        d = self.tmp / "images" / "composition_style"
        d.mkdir(parents=True)
        (d / "a.jpg").write_bytes(b"x")
        (d / "b.jpg").write_bytes(b"x")
        (self.tmp / "images" / "README.txt").write_text("说明", "utf-8")

        r = call(routes_mod._handle_images_status, "/codex_atlas/images/status")
        self.assertEqual(r.status, 200)
        data = body_of(r)
        self.assertTrue(data["ok"])
        self.assertEqual(data["count"], 2, "README.txt 不该被算成配图")
        self.assertIn("fetch", data)
        self.assertFalse(data["running"])

    def test_count_is_zero_when_dir_missing(self):
        """atlas/images/ 还不存在时不能炸 —— 首次运行就是这个状态。"""
        self.assertEqual(routes_mod._images_count(), 0)

    def test_fetch_requires_confirm(self):
        """没有 confirm 就 400。1.3 GB 的下载不该被一次手滑的请求触发。"""
        r = call(routes_mod._handle_images_fetch, "/codex_atlas/images/fetch", method="POST")
        self.assertEqual(r.status, 400)
        self.assertIn("confirm", body_of(r)["error"])

    def test_find_7z_returns_something_runnable_or_none(self):
        """探测 7z：本机装了就用本机的，插件目录里有 7zr.exe 就用它。

        两个都没有时返回 (None, "")，让调用方去下载 —— 不能抛异常。
        """
        tool, how = routes_mod._find_7z()
        if tool is None:
            self.assertEqual(how, "")
        else:
            self.assertTrue(Path(tool).is_file(), "返回的工具路径必须真实存在：{}".format(tool))
            self.assertTrue(how)

    def test_release_parts_parses_checksum_file(self):
        """SHA256SUMS.txt 是两列（hash + 文件名），中间可能有空行。"""
        text = "aaa   m8tags-images.7z.001\n\nbbb  m8tags-images.7z.002\n"

        class _Resp:
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def read(self):
                return text.encode("utf-8")

        orig = routes_mod._http_get
        routes_mod._http_get = lambda *a, **k: _Resp()
        try:
            parts = routes_mod._release_parts()
        finally:
            routes_mod._http_get = orig
        self.assertEqual(
            parts,
            [("aaa", "m8tags-images.7z.001"), ("bbb", "m8tags-images.7z.002")],
        )

    def test_release_parts_falls_back_when_offline(self):
        """取不到清单要退回按约定拼名字，而不是让整件事直接失败。"""
        def boom(*a, **k):
            raise OSError("no network")

        orig = routes_mod._http_get
        routes_mod._http_get = boom
        try:
            parts = routes_mod._release_parts()
        finally:
            routes_mod._http_get = orig
        self.assertTrue(parts, "兜底清单不该是空的")
        self.assertEqual(parts[0][1], "m8tags-images.7z.001")

    def test_set_stage_can_update_progress_only(self):
        """只推进进度、不动阶段 —— 每下完一个分卷都会这么调一次。

        早先 stage 是必填位置参数，`_set_stage(done=idx)` 直接 TypeError，
        表现成「第一个卷下完就报拉取失败」。单看下卷、校验、解压每一步都是好的，
        所以这条得单独盯住。
        """
        routes_mod._set_stage("downloading", "下载中", done=0, total=4)
        routes_mod._set_stage(done=1)
        self.assertEqual(routes_mod._fetch_state["stage"], "downloading", "阶段不该被进度更新抹掉")
        self.assertEqual(routes_mod._fetch_state["done"], 1)
        self.assertEqual(routes_mod._fetch_state["message"], "下载中", "提示文字不该被进度更新抹掉")

    def test_fetch_worker_completes_end_to_end(self):
        """整条拉取流程走一遍真代码：找 7z → 取清单 → 逐个下载 → 校验 → 解压。

        只有下载和解压换成替身（不联网、不真解压），流程本身不替身 ——
        跨函数的那种错（比如「只更新进度」的调用签名不对）只有整条跑起来才暴露。
        """
        parts = [("", "m8tags-images.7z.001"), ("", "m8tags-images.7z.002")]
        seen_done = []
        downloads = []

        def fake_download(url, dest):
            seen_done.append(routes_mod._fetch_state["done"])
            downloads.append(url)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"fake")
            return dest

        class _Proc:
            returncode = 0

        tool = self.tmp / "7z.exe"
        tool.write_bytes(b"fake")

        orig = (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
                routes_mod.subprocess.run, store.PLUGIN_DIR)
        routes_mod._find_7z = lambda: (tool, "替身")
        routes_mod._release_parts = lambda: parts
        routes_mod._download = fake_download
        routes_mod.subprocess.run = lambda *a, **k: _Proc()
        store.PLUGIN_DIR = self.tmp
        try:
            routes_mod._fetch_worker()
        finally:
            (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
             routes_mod.subprocess.run, store.PLUGIN_DIR) = orig

        state = dict(routes_mod._fetch_state)
        self.assertEqual(state["stage"], "done", "流程没跑完：{}".format(state))
        self.assertIsNone(state["error"], "流程报错了：{}".format(state))
        self.assertEqual(state["done"], 2)
        self.assertEqual(state["total"], 2)
        self.assertEqual(len(downloads), 2, "两个卷都要下")
        self.assertEqual(seen_done, [0, 1], "下第二个卷之前，进度应该已经推进到 1")
        self.assertTrue((self.tmp / "images" / "README.txt").is_file(),
                        "解压后要补回 images/README.txt")

    def test_fetch_worker_skips_already_verified_parts(self):
        """上一轮下完并校验过的分卷要跳过重下。

        1.3 GB 的东西，因为后面某一步失败就整套重来，代价太大。
        """
        name = "m8tags-images.7z.001"
        tmp = self.tmp / "bin" / "_fetch_tmp"
        tmp.mkdir(parents=True)
        (tmp / name).write_bytes(b"downloaded by a previous attempt")
        sha = routes_mod._sha256_of(tmp / name)

        downloads = []

        def fake_download(url, dest):
            downloads.append(url)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"fake")
            return dest

        class _Proc:
            returncode = 0

        tool = self.tmp / "7z.exe"
        tool.write_bytes(b"fake")

        orig = (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
                routes_mod.subprocess.run, store.PLUGIN_DIR)
        routes_mod._find_7z = lambda: (tool, "替身")
        routes_mod._release_parts = lambda: [(sha, name)]
        routes_mod._download = fake_download
        routes_mod.subprocess.run = lambda *a, **k: _Proc()
        store.PLUGIN_DIR = self.tmp
        try:
            routes_mod._fetch_worker()
        finally:
            (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
             routes_mod.subprocess.run, store.PLUGIN_DIR) = orig

        self.assertEqual(downloads, [], "已经校验过的卷不该再下一次")
        self.assertEqual(routes_mod._fetch_state["stage"], "done")

    def test_fetch_worker_keeps_parts_when_it_fails(self):
        """失败时不许把已下好的分卷清掉 —— 清了，重试就等于从零再来。"""
        name = "m8tags-images.7z.001"

        def fake_download(url, dest):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"downloaded fine")
            return dest

        class _BadProc:
            returncode = 1        # 解压这一步失败，下载本身是好的

        tool = self.tmp / "7z.exe"
        tool.write_bytes(b"fake")

        orig = (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
                routes_mod.subprocess.run, store.PLUGIN_DIR)
        routes_mod._find_7z = lambda: (tool, "替身")
        routes_mod._release_parts = lambda: [("", name)]
        routes_mod._download = fake_download
        routes_mod.subprocess.run = lambda *a, **k: _BadProc()
        store.PLUGIN_DIR = self.tmp
        try:
            routes_mod._fetch_worker()
        finally:
            (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
             routes_mod.subprocess.run, store.PLUGIN_DIR) = orig

        self.assertEqual(routes_mod._fetch_state["stage"], "error")
        self.assertIn("7z 解压失败", routes_mod._fetch_state["error"])
        self.assertTrue((self.tmp / "bin" / "_fetch_tmp" / name).is_file(),
                        "已下好的分卷被清掉了，重试要从零再下 1.3 GB")
        self.assertIn("_fetch_tmp", routes_mod._fetch_state["message"],
                      "得告诉用户东西留在哪、重试会跳过")

    def test_fetch_worker_reports_checksum_mismatch(self):
        """校验不符要停下并给出可读原因，不能默默解压一个坏包。"""
        parts = [("deadbeef", "m8tags-images.7z.001")]

        def fake_download(url, dest):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"not the real thing")
            return dest

        class _Proc:
            returncode = 0

        tool = self.tmp / "7z.exe"
        tool.write_bytes(b"fake")

        orig = (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
                routes_mod.subprocess.run, store.PLUGIN_DIR)
        routes_mod._find_7z = lambda: (tool, "替身")
        routes_mod._release_parts = lambda: parts
        routes_mod._download = fake_download
        routes_mod.subprocess.run = lambda *a, **k: _Proc()
        store.PLUGIN_DIR = self.tmp
        try:
            routes_mod._fetch_worker()
        finally:
            (routes_mod._find_7z, routes_mod._release_parts, routes_mod._download,
             routes_mod.subprocess.run, store.PLUGIN_DIR) = orig

        self.assertEqual(routes_mod._fetch_state["stage"], "error")
        self.assertIn("校验不符", routes_mod._fetch_state["error"])

    def test_download_treats_416_as_already_complete(self):
        """`.part` 已经装满整个文件时服务器回 416。

        成因是「下完了、但还没走到改名就被中断」——关掉 ComfyUI、断电都算。
        不能把它当失败：当失败就会永远卡在 416，重试多少次都一样。
        这里断言它按「下完了」处理，把 .part 改名成正式文件。
        """
        dest = self.tmp / "m8tags-images.7z.001"
        part = dest.with_suffix(dest.suffix + ".part")
        part.write_bytes(b"whole file already on disk")

        def fake_urlopen(req, timeout=None):
            raise routes_mod.urllib.error.HTTPError(
                req.full_url, 416, "Requested Range Not Satisfiable", {}, None)

        orig = routes_mod.urllib.request.urlopen
        routes_mod.urllib.request.urlopen = fake_urlopen
        try:
            got = routes_mod._download("https://example.invalid/x", dest)
        finally:
            routes_mod.urllib.request.urlopen = orig

        self.assertEqual(got, dest)
        self.assertTrue(dest.is_file(), "应该把 .part 改名成正式文件")
        self.assertEqual(dest.read_bytes(), b"whole file already on disk")
        self.assertFalse(part.exists(), ".part 应该已经改名走了")
        self.assertEqual(routes_mod._sha256_of(dest),
                         routes_mod._sha256_of(dest), "内容交给上层 SHA256 去判")

    def test_download_reports_other_http_errors(self):
        """416 之外的 HTTP 错误照旧抛出去 —— 别把真失败也吞成「下完了」。"""
        dest = self.tmp / "m8tags-images.7z.001"
        part = dest.with_suffix(dest.suffix + ".part")
        part.write_bytes(b"half a file")

        def fake_urlopen(req, timeout=None):
            raise routes_mod.urllib.error.HTTPError(
                req.full_url, 404, "Not Found", {}, None)

        orig = routes_mod.urllib.request.urlopen
        routes_mod.urllib.request.urlopen = fake_urlopen
        try:
            with self.assertRaises(routes_mod.urllib.error.HTTPError):
                routes_mod._download("https://example.invalid/x", dest)
        finally:
            routes_mod.urllib.request.urlopen = orig
        self.assertFalse(dest.exists(), "失败时不该生成正式文件")

    def test_images_count_is_cached_until_forced(self):
        """status 每 2 秒被问一次，而数一遍 4.5 万个文件实测要 0.45 秒 —— 必须缓存。

        拉取收尾时用 force 拿到真实数字，轮询期间不许反复翻目录。
        """
        d = self.tmp / "images"
        d.mkdir(parents=True)
        (d / "a.jpg").write_bytes(b"x")
        self.assertEqual(routes_mod._images_count(force=True), 1)

        (d / "b.jpg").write_bytes(b"x")
        self.assertEqual(routes_mod._images_count(), 1, "5 秒内该走缓存，不重新遍历")
        self.assertEqual(routes_mod._images_count(force=True), 2, "force 要能立刻看到新文件")

    def test_count_cache_does_not_leak_across_dirs(self):
        """缓存必须认目录：换了目录（换 config、或者测试用临时目录）就当没缓存。"""
        a = self.tmp / "a" / "images"
        a.mkdir(parents=True)
        (a / "1.jpg").write_bytes(b"x")
        b = self.tmp / "b" / "images"
        b.mkdir(parents=True)

        orig = store.ATLAS_DIR
        try:
            store.ATLAS_DIR = self.tmp / "a"
            self.assertEqual(routes_mod._images_count(), 1)
            store.ATLAS_DIR = self.tmp / "b"
            self.assertEqual(routes_mod._images_count(), 0, "换了目录还吃旧缓存")
        finally:
            store.ATLAS_DIR = orig

    def test_readme_text_exists_for_post_extract_write(self):
        """解压后要写进 images/README.txt 的那段内容必须非空。

        atlas/images/ 解压前就存在（仓库里带着这个文件），解压是往里合并而不是重建，
        所以这个说明文件得由代码显式补 —— 内容为空就等于没补。
        """
        self.assertIn("images/", routes_mod._IMAGES_README)
        self.assertGreater(len(routes_mod._IMAGES_README.strip()), 50)


if __name__ == "__main__":
    unittest.main(verbosity=2)
