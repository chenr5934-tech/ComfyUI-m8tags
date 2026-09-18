"""按 ComfyUI 的方式真正加载一次插件包。

这是 Python 侧唯一还没被验证过的环节：ComfyUI 是用 importlib 按**目录路径**加载插件的
（目录名带连字符，不是合法标识符，所以不能直接 import），加载过程里 __init__.py 会
拉进节点映射并触发路由注册。这里把那个过程 1:1 复现一遍。

不联网、不启动 ComfyUI。

跑法：
    python tests/test_plugin_load.py
"""

from __future__ import annotations

import importlib.util
import re
import sys
import types
import unittest
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent.parent


class FakeRouteTable:
    """记录注册了什么，不真的建路由。"""

    def __init__(self):
        self.entries = []

    def _deco(self, method, path):
        def deco(fn):
            self.entries.append((method, path, fn.__name__))
            return fn
        return deco

    def get(self, path, **kw):
        return self._deco("GET", path)

    def post(self, path, **kw):
        return self._deco("POST", path)


def install_fake_server(table=None):
    """在 import 插件之前塞一个假的 server 模块进去。"""
    table = table if table is not None else FakeRouteTable()
    fake_module = types.ModuleType("server")

    class FakePromptServer:
        instance = None

    FakePromptServer.instance = types.SimpleNamespace(routes=table)
    fake_module.PromptServer = FakePromptServer
    sys.modules["server"] = fake_module
    return table


def load_plugin(table):
    # 这里不需要真正的 ComfyUI 目录：server 模块在 install_fake_server 里被替换掉了
    install_fake_server(table)

    name = "ComfyUI_CodexAtlas"
    # 连子模块一起清，否则下一个用例会拿到上一次的模块对象
    for key in list(sys.modules):
        if key == name or key.startswith(name + "."):
            sys.modules.pop(key, None)
    table.entries.clear()
    spec = importlib.util.spec_from_file_location(
        name,
        str(PKG_DIR / "__init__.py"),
        submodule_search_locations=[str(PKG_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class TestPluginLoad(unittest.TestCase):
    def setUp(self):
        self.table = install_fake_server()

    def test_loads_and_exports_contract(self):
        module = load_plugin(self.table)
        self.assertIn("CodexAtlasTag", module.NODE_CLASS_MAPPINGS)
        self.assertEqual(module.WEB_DIRECTORY, "./js")
        self.assertIn("CodexAtlasTag", module.NODE_DISPLAY_NAME_MAPPINGS)
        self.assertTrue((PKG_DIR / "js" / "codex_atlas.js").is_file(), "WEB_DIRECTORY 指向的 js 文件不存在")

    def test_routes_registered_with_expected_paths(self):
        load_plugin(self.table)
        paths = {(m, p) for m, p, _ in self.table.entries}
        self.assertIn(("GET", "/codex_atlas/codexes"), paths)
        self.assertIn(("GET", "/codex_atlas/random"), paths)
        self.assertIn(("GET", "/codex_atlas/entry"), paths, "已选栏取词条的接口没注册")
        self.assertIn(("GET", "/codex_atlas/status"), paths)
        self.assertIn(("GET", "/codex_atlas/atlas/{tail:.*}"), paths, "静态伺服路由没注册，小窗会打不开站点")
        self.assertIn(("POST", "/codex_atlas/self-image"), paths, "存图接口没注册，图库就只能靠手动选文件夹")
        self.assertIn(("POST", "/codex_atlas/self-image/delete"), paths, "删图接口没注册（它走 unlink，不可逆，更要有回归保护）")
        self.assertIn(("POST", "/codex_atlas/self-image/group"), paths, "分组接口没注册，分组只能暂存在本机")
        self.assertIn(("GET", "/codex_atlas/images/status"), paths, "例图状态接口没注册，前端不知道要不要提示「拉取例图」")
        self.assertIn(("POST", "/codex_atlas/images/fetch"), paths, "例图拉取接口没注册，一键拉取就没了")

    def test_all_registered_routes_are_covered_by_this_test(self):
        """路由数量和上面逐条断言的条数要对得上 —— 以后新增接口漏了断言，这里会红。"""
        load_plugin(self.table)
        paths = {(m, p) for m, p, _ in self.table.entries}
        self.assertEqual(len(paths), 10, f"路由数变了，请补断言：{sorted(paths)}")

    def test_node_contract_matches_frontend_constants(self):
        """节点签名是前后端的契约，改坏了前端会静默失效。"""
        module = load_plugin(self.table)
        cls = module.NODE_CLASS_MAPPINGS["CodexAtlasTag"]

        inputs = cls.INPUT_TYPES()
        self.assertEqual(list(inputs["required"])[:3], ["text", "syntax", "codex"])
        self.assertEqual(list(inputs["optional"]), ["negative"])
        self.assertEqual(cls.RETURN_TYPES, ("STRING", "STRING"))
        self.assertEqual(cls.RETURN_NAMES, ("positive", "negative"))
        self.assertEqual(cls.FUNCTION, "emit")
        self.assertEqual(cls.CATEGORY, "法典图鉴")

        # 前端靠字符串硬比对，两边必须逐字一致，差一个字符就是静默失效。
        # 用整行精确匹配，别用 assertIn —— 往 JS 里多加半行也能过的那种断言没意义。
        any_label = inputs["required"]["codex"][0][0]
        syntax_options = inputs["required"]["syntax"][0]
        text = (PKG_DIR / "js" / "codex_atlas.js").read_text("utf-8")
        self.assertRegex(text, r'(?m)^const SELF_NODE_TYPES = \["CodexAtlasTag", "CodexAtlasClipEncode"\];\s*$')
        self.assertRegex(text, rf'(?m)^const ANY_LABEL = "{re.escape(any_label)}";\s*$')
        self.assertRegex(text, rf'(?m)^const SYNTAX_A1111 = "{re.escape(syntax_options[0])}";\s*$')
        self.assertRegex(text, rf'(?m)^const SYNTAX_NAI = "{re.escape(syntax_options[1])}";\s*$')

    def test_fetch_download_dir_is_gitignored(self):
        """一键拉取把 1.3 GB 分卷下到插件目录的 bin/ 里。

        这条要是漏了，用户手一滑 git add -A，整个包就进仓库了 ——
        提交体积涨 1.3 GB，push 也基本推不上去。
        """
        lines = [ln.strip() for ln in (PKG_DIR / ".gitignore").read_text("utf-8").splitlines()]
        self.assertIn("bin/", lines, "bin/ 没被忽略：拉取下来的分卷会被提交进仓库")

    def test_clip_encode_node_is_ours_not_builtin(self):
        """本插件自己的文本编码节点：输出 CONDITIONING，等于把内置节点那份功能搬过来，
        按钮长在它自己身上 —— 不是去改 ComfyUI 的 CLIPTextEncode。"""
        module = load_plugin(self.table)
        self.assertIn("CodexAtlasClipEncode", module.NODE_CLASS_MAPPINGS)
        cls = module.NODE_CLASS_MAPPINGS["CodexAtlasClipEncode"]

        inputs = cls.INPUT_TYPES()
        self.assertEqual(list(inputs["required"])[:2], ["text", "clip"])
        self.assertIn("syntax", inputs["required"])
        self.assertIn("codex", inputs["required"])
        self.assertEqual(list(inputs["optional"]), ["negative"])
        self.assertEqual(cls.RETURN_TYPES, ("CONDITIONING", "CONDITIONING"))
        self.assertEqual(cls.RETURN_NAMES, ("positive", "negative"))
        self.assertEqual(cls.CATEGORY, "法典图鉴")
        self.assertTrue(hasattr(cls, "VALIDATE_INPUTS"))

    def test_emit_passthrough(self):
        module = load_plugin(self.table)
        cls = module.NODE_CLASS_MAPPINGS["CodexAtlasTag"]
        node = cls()
        self.assertEqual(node.emit("a, b", "A1111 语法", "全部法典（不含 R18）", "lowres"), ("a, b", "lowres"))
        self.assertEqual(node.emit("a", "A1111 语法", "全部法典（不含 R18）"), ("a", ""))

    def test_codex_validation_is_bypassed(self):
        """codex 的候选项由前端从线上实时替换，服务端必须放行任意值。

        少了 VALIDATE_INPUTS，ComfyUI 会拿 INPUT_TYPES 里的占位列表去比对，
        直接报 Value not in list —— 前端能选中，一提交就被拦。
        """
        import inspect

        module = load_plugin(self.table)
        cls = module.NODE_CLASS_MAPPINGS["CodexAtlasTag"]

        self.assertTrue(hasattr(cls, "VALIDATE_INPUTS"), "缺少 VALIDATE_INPUTS")
        spec = inspect.getfullargspec(cls.VALIDATE_INPUTS)
        self.assertIn("codex", spec.args, "VALIDATE_INPUTS 必须显式声明 codex 参数才会跳过默认校验")
        # 不写 **kwargs：这样只有 codex 被接管，text / syntax 仍走 ComfyUI 默认校验
        self.assertIsNone(spec.varkw, "不该用 **kwargs，那会把所有参数的校验一起关掉")

        self.assertIs(cls.VALIDATE_INPUTS("构图风格"), True)
        self.assertIs(cls.VALIDATE_INPUTS("随便一个站点上才有的法典名"), True)

    def test_missing_server_does_not_break_import(self):
        """没有 ComfyUI 环境时插件仍要能加载，不能因为路由注册失败就整个崩掉。"""
        sys.modules.pop("ComfyUI_CodexAtlas", None)
        sys.modules.pop("server", None)
        broken = types.ModuleType("server")
        broken.PromptServer = None
        sys.modules["server"] = broken

        spec = importlib.util.spec_from_file_location(
            "ComfyUI_CodexAtlas",
            str(PKG_DIR / "__init__.py"),
            submodule_search_locations=[str(PKG_DIR)],
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules["ComfyUI_CodexAtlas"] = module
        spec.loader.exec_module(module)  # 不该抛

        self.assertIn("CodexAtlasTag", module.NODE_CLASS_MAPPINGS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
