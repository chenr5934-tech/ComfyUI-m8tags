# 站点侧测试

这四个脚本测的是**内置站点**（`atlas/` 那一套），不是插件的 Python 侧。

站点源码已经并进插件的 `atlas/`（独立的站点目录不再单独存在），所以这里就是它们的**唯一版本**，
路径也都指向 `../../atlas`。直接跑即可。

| 脚本 | 测什么 | 跑法 | 最近实测 |
| --- | --- | --- | --- |
| `test_serve.py` | `serve.py`：缓存头、索引读写、并发保存、保留名、路径穿越、缺索引兜底 | `python test_serve.py` | 52 passed |
| `e2e-self-gallery.mjs` | 图库端到端：三栏布局、卡片同构、审阅必须先决定、分组、上传链路 | `node e2e-self-gallery.mjs` | 50/50 |
| `verify-embedded.mjs` | 模拟插件小窗（iframe + 右侧 334px 已选栏）里的图库行为 | `node verify-embedded.mjs <URL>` | 18/18 |
| `verify-serve-write.mjs` | 本地服务下真的写进 `self-image/`，自带还原与清理 | `node verify-serve-write.mjs <URL>` | 13/13 |

## 跑 `.mjs` 的前置

需要一个 Chromium。脚本默认从 ms-playwright 缓存里找，也可以用 `CHROME` 环境变量指定：

```
set CHROME=C:\Users\<你>\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe
```

后两个需要站点已经在某个端口上跑着 —— 用内置站点起就行：

```
cd ..\..\atlas
python serve.py --no-browser 8891

cd ..\tests\site
node verify-embedded.mjs http://127.0.0.1:8891/index.html
```

它们要么完全不写盘，要么只写自己新建的那张并在收尾删掉 —— 不会动图库里已有的东西。

`e2e-self-gallery.mjs` 不带参数时走 `file://`（不需要起服务），会在本站目录下生成几张
`_shot*.png` 截图（已在 `.gitignore` 里排除）。

`test_serve.py` 会自己起服务并把 `serve.ROOT` 指到临时目录，单跑它不需要准备任何东西。
