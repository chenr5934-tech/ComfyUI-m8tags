# 站点侧测试（备份副本）

这四个脚本测的是**离线站点本体**（`atlas/` 那一套），不是插件的 Python 侧。
它们的源在站点目录里：

```
<站点目录>/tools/e2e-self-gallery.mjs
<站点目录>/tools/verify-embedded.mjs
<站点目录>/tools/verify-serve-write.mjs
<站点目录>/tests/test_serve.py
```

站点目录本身不在版本控制里，所以这里存一份副本，免得哪天误删就找不回来了。

> **副本不要直接跑。** 脚本用 `import.meta.dirname` 加 `..` 定位站点根，
> 挪到 `tests/site/` 之后相对路径就对不上了。要跑就去站点目录跑，
> 或者显式把 URL 当参数传进去。

## 各测什么

| 脚本 | 测什么 | 跑法 | 最近实测 |
| --- | --- | --- | --- |
| `test_serve.py` | `serve.py` 的接口：缓存头、索引读写、并发保存、保留名、路径穿越 | `python tests/test_serve.py` | 49 passed |
| `e2e-self-gallery.mjs` | 图库端到端：三栏布局、卡片同构、审阅必须先决定、分组、上传链路 | `node tools/e2e-self-gallery.mjs` | 50/50 |
| `verify-embedded.mjs` | 模拟插件小窗（iframe + 右侧 334px 已选栏）里的图库行为 | `node tools/verify-embedded.mjs <URL>` | 18/18 |
| `verify-serve-write.mjs` | 本地服务下真的写进 `self-image/`，自带还原与清理 | `node tools/verify-serve-write.mjs <URL>` | 13/13 |

## 跑 `.mjs` 的前置

需要一个 Chromium。脚本默认从 ms-playwright 缓存里找，也可以用 `CHROME` 环境变量指定：

```
set CHROME=C:\Users\<你>\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe
```

后两个需要站点已经在某个端口上跑着：

```
python serve.py --no-browser 8891
node tools/verify-embedded.mjs http://127.0.0.1:8891/index.html
```

它们要么完全不写盘，要么只写自己新建的那张并在收尾删掉 —— 不会动你图库里已有的东西。

`e2e-self-gallery.mjs` 不带参数时走 `file://`，会在 `tools/` 下生成几张 `_shot*.png`
截图（已在 `.gitignore` 里排除掉）。
