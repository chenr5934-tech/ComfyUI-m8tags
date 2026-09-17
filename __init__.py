"""法典图鉴 · ComfyUI 节点插件

把本地离线提示词法典接进 ComfyUI：节点上带 tag 框、随机抽词、语法切换，
以及带已选栏的站内小窗。全程不联网。
"""

from .py.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .py import routes  # noqa: F401  导入即注册 aiohttp 路由

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
