"""数据层测试：核对本地离线数据可用，以及两个语法版本的配对情况。

不联网。

跑法：
    python tests/test_store.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from py import store  # noqa: E402


class TestLocalData(unittest.TestCase):
    def test_meta_list(self):
        metas = store.get_meta_list()
        self.assertIsInstance(metas, list)
        self.assertGreater(len(metas), 0, "法典索引为空")
        for m in metas:
            self.assertTrue(m.get("id"), f"法典缺 id：{m!r}")
            self.assertTrue(m.get("title"), f"法典缺 title：{m!r}")
        print(f"\n  法典 {len(metas)} 部: " + ", ".join(m["id"] for m in metas))

    def test_codex_load(self):
        data = store.get_codex("suozhang")
        entries = data.get("entries") or []
        self.assertGreater(len(entries), 0)
        sample = entries[0]
        self.assertTrue(sample.get("id"))
        self.assertTrue(str(sample.get("tags") or "").strip(), "词条没有 tags")
        print(f"\n  suozhang: {len(entries)} 条")
        print(f"  A1111 样例: {str(sample.get('tags'))[:88]}…")

    def test_raw_pairs_with_data(self):
        """原始 NAI 版本要能按 entry id 与本地 data 对上，否则「原始 NAI」模式会全空。"""
        data = store.get_codex("suozhang")
        raw = store.get_raw_tags("suozhang")
        self.assertGreater(len(raw), 0, "没读到原始 NAI 数据（检查 codexes-raw 是否存在）")

        ids = {e.get("id") for e in data.get("entries") or []}
        paired = ids & set(raw)
        self.assertGreater(len(paired), 0, "两边一条都对不上")
        ratio = len(paired) / max(1, len(ids))
        print(f"\n  配对 {len(paired)}/{len(ids)} ({ratio:.1%})")
        self.assertGreater(ratio, 0.9, f"配对率过低：{ratio:.1%}")

    def test_two_versions_really_differ(self):
        """两版内容必须真的不同 —— 否则说明只是把同一份数据读了两遍。"""
        data = store.get_codex("suozhang")
        raw = store.get_raw_tags("suozhang")
        by_id = {e["id"]: str(e.get("tags") or "") for e in data["entries"]}

        nai_like = [i for i, v in raw.items() if "::" in v["tags"] or "[" in v["tags"] or "{" in v["tags"]]
        self.assertTrue(nai_like, "raw 里找不到 NAI 权重写法，可能读错文件了")

        sample_id = nai_like[0]
        a1111 = by_id.get(sample_id, "")
        self.assertTrue(a1111, f"raw 有 {sample_id}，data 里却没有")
        self.assertNotEqual(a1111, raw[sample_id]["tags"], "两版一模一样，配对取值有问题")
        self.assertNotIn("::", a1111, "A1111 版里还残留 NAI 的 :: 权重写法")

        print(f"\n  {sample_id}")
        print(f"    NAI  : {raw[sample_id]['tags'][:92]}")
        print(f"    A1111: {a1111[:92]}")

    def test_find_entry(self):
        entry = store.find_entry("suozhang", "suozhang-0001")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["id"], "suozhang-0001")
        self.assertIsNone(store.find_entry("suozhang", "__nope__"))
        self.assertIsNone(store.find_entry("suozhang", ""))

    def test_unknown_codex_raises(self):
        with self.assertRaises(store.CodexAtlasError):
            store.get_codex("__this_codex_does_not_exist__")

    def test_path_traversal_rejected(self):
        """法典 id 会拼进文件路径，必须挡住穿越。"""
        for bad in ("../secrets", "..\\secrets", "a/b", "sub/../../x", "..", ""):
            with self.assertRaises(store.CodexAtlasError, msg=f"没挡住：{bad!r}"):
                store.get_codex(bad)

    def test_image_file_guard(self):
        self.assertIsNone(store.image_file("suozhang", "../index.js"))
        self.assertIsNone(store.image_file("suozhang", "a/b.jpg"))
        self.assertIsNone(store.image_file("suozhang", ""))

    def test_data_version(self):
        info = store.data_version()
        self.assertTrue(info["dir"])
        # 不假设目录叫什么名字，只要求它真的装着一份数据
        self.assertTrue(
            (Path(info["dir"]) / "data" / "index.js").is_file(),
            f"数据目录不对：{info['dir']}",
        )


class TestPathResolution(unittest.TestCase):
    """数据目录是可移植解析的，这几条防止以后改坏。"""

    def test_candidates_cover_common_layouts(self):
        """站点或原始数据放在插件上一级/两级是很常见的，候选里必须有。"""
        self.assertIn(store.PLUGIN_DIR / "atlas", store.ATLAS_CANDIDATES)
        for name in store.ATLAS_DIR_NAMES:
            self.assertIn(store.PLUGIN_DIR / name, store.ATLAS_CANDIDATES)
            self.assertIn(store.PLUGIN_DIR.parent / name, store.ATLAS_CANDIDATES)
        self.assertIn(store.PLUGIN_DIR.parent.parent / "codexes-raw", store._RAW_CANDIDATES)

    def test_candidates_are_deduped(self):
        self.assertEqual(len(store.ATLAS_CANDIDATES), len(set(map(str, store.ATLAS_CANDIDATES))))
        self.assertEqual(len(store._RAW_CANDIDATES), len(set(map(str, store._RAW_CANDIDATES))))

    def test_resolved_dir_actually_has_data(self):
        self.assertTrue(store.ATLAS_DIR.is_dir(), f"解析到不存在的目录：{store.ATLAS_DIR}")
        self.assertTrue((store.ATLAS_DIR / "data" / "index.js").is_file())

    def test_env_var_has_top_priority(self):
        """环境变量排在候选首位 —— 配了就优先按它找。"""
        import os

        original = os.environ.get("CODEX_ATLAS_DIR")
        try:
            os.environ["CODEX_ATLAS_DIR"] = "X:/env-first"
            self.assertEqual(store._atlas_candidates()[0], Path("X:/env-first"))
        finally:
            if original is None:
                os.environ.pop("CODEX_ATLAS_DIR", None)
            else:
                os.environ["CODEX_ATLAS_DIR"] = original

    def test_error_message_lists_candidates(self):
        """找不到数据时，报错要把找过的地方列出来，否则用户无从下手。"""
        original = store.DATA_DIR
        try:
            store.DATA_DIR = Path("D:/__definitely_not_here__/data")
            with self.assertRaises(store.CodexAtlasError) as ctx:
                store.get_meta_list(force=True)
            message = str(ctx.exception)
            self.assertIn("找过这些位置", message)
            self.assertIn("CODEX_ATLAS_DIR", message)
        finally:
            store.DATA_DIR = original


if __name__ == "__main__":
    unittest.main(verbosity=2)
