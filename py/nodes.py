"""节点定义。

设计取舍：文本与语法转换全部在前端完成（所见即所得），Python 侧只做透传。
这样节点输出的内容永远等于你在框里看到的内容，不会出现"框里一套、输出另一套"。
"""

from __future__ import annotations

SYNTAX_A1111 = "A1111 语法"
SYNTAX_NAI = "原始 NAI 语法"
SYNTAX_OPTIONS = [SYNTAX_A1111, SYNTAX_NAI]

# 前端拿到线上法典列表后会重写这个 combo 的选项，这里只是占位
CODEX_ANY = "全部法典（不含 R18）"


class CodexAtlasTag:
    """法典图鉴 · 提示词

    点「随机提示词」从线上法典抽一条填进框里；
    点「运行自动随机」打开开关后，每次运行工作流都会自动换一批新词；
    点「前往词典站寻找灵感」在 ComfyUI 页面内开小窗浏览站点。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "提示词。点「随机提示词」自动填入，也可以直接手改；开着「运行自动随机」时每次运行都会重新抽一条覆盖这里。",
                }),
                "syntax": (list(SYNTAX_OPTIONS), {
                    "default": SYNTAX_A1111,
                    "tooltip": "语法风格：抽到的词按 A1111 权重语法转换，或保留原始 NAI 语法写法。",
                }),
                "codex": ([CODEX_ANY], {
                    "default": CODEX_ANY,
                    "tooltip": "随机抽词的来源法典，列表实时来自线上站点。选「全部法典」时不会抽画师词典里的词条；想抽就明确选中那一部。",
                }),
            },
            "optional": {
                "negative": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "负向提示词。抽词时若词条自带负向标签，也会并进这里。",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "emit"
    CATEGORY = "法典图鉴"
    DESCRIPTION = "把 NovelAI 提示词法典接进 ComfyUI：窗口直连线上站点，可把词条推送到节点，带运行前自动随机抽词与 NAI↔A1111 语法转换。"
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, codex):
        """接管 codex 的校验，放行任意值。

        codex 的候选项是前端从线上实时拉取后写进 widget 的，而服务端 INPUT_TYPES
        只能给一份占位列表。ComfyUI 的默认校验会拿那份占位列表去比对，于是必然报
        「Value not in list: codex: '构图风格' not in ['全部法典（不含 R18）']」。

        在 ComfyUI 里（execution.py 的 validate_inputs），只要参数名出现在本方法的
        签名里，该参数的默认校验整块跳过。这里只接管 codex 一项，text / syntax
        照常走默认校验 —— 不写 **kwargs 就是这个用意。
        """
        return True

    def emit(self, text, syntax, codex, negative=""):
        return (text, negative)


class CodexAtlasClipEncode:
    """法典图鉴 · 文本编码

    和 ComfyUI 自带的「CLIP文本编码」在功能上是等价的（CLIP + 文本 -> CONDITIONING），
    区别是那几个按钮长在它自己身上。输出正负两路，可以直接接 KSampler。

    这是本插件自己的节点，ComfyUI 内置的 CLIPTextEncode 一个字都没改。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "正向提示词。点「随机提示词」自动填入，也可以直接手改。",
                }),
                "clip": ("CLIP", {
                    "tooltip": "用来编码文本的 CLIP 模型。",
                }),
                "syntax": (list(SYNTAX_OPTIONS), {
                    "default": SYNTAX_A1111,
                    "tooltip": "语法风格：抽到的词按 A1111 权重语法转换，或保留原始 NAI 写法。",
                }),
                "codex": ([CODEX_ANY], {
                    "default": CODEX_ANY,
                    "tooltip": "随机抽词的来源法典，列表实时来自线上站点。选「全部法典」时不会抽画师词典里的词条；想抽就明确选中那一部。",
                }),
            },
            "optional": {
                "negative": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "负向提示词。留空就输出一个空的负向条件。",
                }),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "encode"
    CATEGORY = "法典图鉴"
    DESCRIPTION = "带法典图鉴按钮的文本编码节点：开着「运行自动随机」每次运行自动换词、NAI↔A1111 语法切换、站内找灵感，输出正负两路 CONDITIONING。"
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, codex):
        """同 CodexAtlasTag：codex 的候选项由前端实时写入，服务端放行任意值。"""
        return True

    def encode(self, clip, text, syntax, codex, negative=""):
        if clip is None:
            raise RuntimeError(
                "CLIP 输入为空。若用的是 checkpoint 加载器，说明这个模型里没有可用的文本编码器。"
            )
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(text or ""))
        neg = clip.encode_from_tokens_scheduled(clip.tokenize(negative or ""))
        return (positive, neg)


class CodexAtlasPositive:
    """法典图鉴 · 只抽正向

    和「法典图鉴 · 提示词」是同一套按钮，区别只在于它只往正向框里写东西。
    有人要正负各一个节点分开摆（比如正向节点接主提示词、负向节点接另一路），
    所以拆出来，而不是在一个节点上塞两个模式开关。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "正向提示词。点「随机提示词」只往这里填；开着「运行自动随机」时每次运行都会重新抽。",
                }),
                "syntax": (list(SYNTAX_OPTIONS), {
                    "default": SYNTAX_A1111,
                    "tooltip": "语法风格：抽到的词按 A1111 权重语法转换，或保留原始 NAI 语法写法。",
                }),
                "codex": ([CODEX_ANY], {
                    "default": CODEX_ANY,
                    "tooltip": "随机抽词的来源法典，列表实时来自线上站点。选「全部法典」时不会抽画师词典里的词条；想抽就明确选中那一部。",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("positive",)
    FUNCTION = "emit"
    CATEGORY = "法典图鉴"
    DESCRIPTION = "法典图鉴的「只抽正向」版：随机抽词只写正向框，输出一路 STRING。"
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, codex):
        """同 CodexAtlasTag：codex 的候选项由前端实时写入，服务端放行任意值。"""
        return True

    def emit(self, text, syntax, codex):
        return (text,)


class CodexAtlasNegative:
    """法典图鉴 · 只抽负向

    只往负向框里写。线上词条自带负向的比例不高（实测约 3.9%，且集中在
    enter_codex 那部），所以后端在只抽负向时会从「带负向的词条」里挑，
    挑不到就没得抽 —— 这一点在前端会明说，不会悄悄塞一条空串。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "negative": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "负向提示词。点「随机提示词」只往这里填；开着「运行自动随机」时每次运行都会重新抽。",
                }),
                "syntax": (list(SYNTAX_OPTIONS), {
                    "default": SYNTAX_A1111,
                    "tooltip": "语法风格：抽到的词按 A1111 权重语法转换，或保留原始 NAI 语法写法。",
                }),
                "codex": ([CODEX_ANY], {
                    "default": CODEX_ANY,
                    "tooltip": "只抽负向时的来源法典。不是每部法典都带负向，抽不到会明确提示。",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("negative",)
    FUNCTION = "emit"
    CATEGORY = "法典图鉴"
    DESCRIPTION = "法典图鉴的「只抽负向」版：随机抽词只写负向框，输出一路 STRING。"
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, codex):
        """同 CodexAtlasTag：codex 的候选项由前端实时写入，服务端放行任意值。"""
        return True

    def emit(self, negative, syntax, codex):
        return (negative,)


NODE_CLASS_MAPPINGS = {
    "CodexAtlasTag": CodexAtlasTag,
    "CodexAtlasClipEncode": CodexAtlasClipEncode,
    "CodexAtlasPositive": CodexAtlasPositive,
    "CodexAtlasNegative": CodexAtlasNegative,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CodexAtlasTag": "法典图鉴 · 提示词",
    "CodexAtlasClipEncode": "法典图鉴 · 文本编码",
    "CodexAtlasPositive": "法典图鉴 · 只抽正向",
    "CodexAtlasNegative": "法典图鉴 · 只抽负向",
}
