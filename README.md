# 法典图鉴 · ComfyUI 节点

把**本地离线**提示词法典接进 ComfyUI。全程不联网——数据和站点都在你自己机器上。

## 功能

- **随机提示词**：从本地法典随机抽一条填进文本框。
- **语法切换**：`A1111 语法`（默认）／`原始 NAI 语法`。两版数据都是本地现成的，切换是原地重渲染，不丢失手改内容。
- **站内小窗**：点「前往词典站寻找灵感」在 ComfyUI 页面内开浮层浏览离线站点（例图 + 检索 UI），不跳转新页面。
- **已选栏 + 推送**：小窗右侧是已选栏。在站点里点卡片上的「＋ 加入已选栏」攒词条，右侧实时显示合并后的正向/负向预览（可直接手改），核对无误点「推送到节点」写进当前节点的正负框。
- **完全离线**：法典检索与「已选栏」全在本地，不依赖任何外部站点。
  （唯一例外：「我的图库」反查模型链接时会请求 civitai.com；网络不通就降级成
  「C 站没搜到」，不影响其余功能。）

## 前置：离线站点数据

本插件不含词库数据，需要你自备一份**离线法典站点**（形如）：

```
<站点目录>/
├── index.html
├── app.js  app.css  converter.html
├── data/
│   ├── index.js          → window.QTC_META = [...]
│   └── <id>.js           → window.QTC_DATA["<id>"] = { meta, entries: [...] }
└── images/<id>/*.jpg     例图（可选，没有就显示占位）
```

可选再放一份**原始 NAI 语法**的数据用于「原始 NAI」模式：

```
<raw 目录>/<id>.json      → { entries: [ { id, tags, ... } ] }
```

按 entry id 与站点的 `data/<id>.js` 配对。没有它时，「原始 NAI」模式会退回显示 A1111。

## 安装

把整个 `ComfyUI-CodexAtlas` 放进 ComfyUI 的 `custom_nodes/` 下：

```
<ComfyUI>/custom_nodes/ComfyUI-CodexAtlas/
```

不想拷贝的话用目录联结（Windows）：

```
mklink /J "<ComfyUI>\custom_nodes\ComfyUI-CodexAtlas" "<本仓库克隆到的位置>"
```

重启 ComfyUI。改动生效方式：Python 侧要重启；`js/` 下改完刷新浏览器即可。

## 配置数据目录

插件按下面的顺序自动找站点，**第一个真的存在（含 `data/index.js`）的目录胜出**：

1. 环境变量 `CODEX_ATLAS_DIR`
2. 插件目录下的 `config.json` 里的 `atlasDir`
3. 插件目录内的 `atlas/`
4. 与插件同级的 `本地离线提示词法典/`、`tag-atlas/`、`codex-atlas/`、`atlas/`
5. 插件目录本身（把站点内容直接摊在插件里）

原始 NAI 数据同理，顺序是：环境变量 `CODEX_ATLAS_RAW_DIR` → `config.json` 的 `rawDir` → `<站点目录>/raw/` → 与插件同级的 `raw/`、`codexes-raw/`。

`config.json` 可选，放在插件目录下，形如：

```json
{
  "atlasDir": "D:/somewhere/my-codex-site",
  "rawDir": "D:/somewhere/my-codex-raw"
}
```

都找不到时，接口会返回一份"找过哪些位置"的清单，照着放或者配一个即可。

> **用拷贝方式安装时，请直接用 `config.json` 或环境变量。**
> 上面第 3、4 条的"向上找"是从插件所在目录往上走。如果插件是**拷贝**进 `custom_nodes` 的，
> 那就走在 ComfyUI 自己的目录树里（`ComfyUI/custom_nodes/ComfyUI-CodexAtlas`），
> 几乎不可能碰到你放站点的地方。只有用 junction / 符号链接挂载时，插件才会被还原到
> 源码所在位置，"向上找"才有意义。
> 另外注意：Windows 上 `Path.resolve()` 和 `os.path.realpath()` **都不解析 junction**，
> 插件内部是用 Win32 的 `FSCTL_GET_REPARSE_POINT` 自己解的。

## 两种用法

**一、挂在内置文本节点上**（`CLIPTextEncode`，「CLIP文本编码」）

文本框下面会自动长出三个控件：`前往词典站寻找灵感` / `随机提示词` / `语法：A1111（点击切换）`。

想覆盖更多节点，把类型名加进 `js/codex_atlas.js` 的 `INLINE_TARGETS`（例如 `CLIPTextEncodeSDXL`）。

**二、独立节点「法典图鉴 · 提示词」**（分类 `法典图鉴`）

比内置节点多了「法典来源下拉」和独立的负向输出（`positive` / `negative` 两个 STRING）。

推送到内置文本节点时它只有一个框：正向写进去，负向内容自动复制到剪贴板，粘到负向编码器即可。独立节点两个都直接写。

## 已选栏怎么工作

```
站点卡片「＋ 加入已选栏」
  → postMessage 到宿主（只传 codex + entry id）
  → 宿主调 /codex_atlas/entry 补齐两个语法版本
  → 已选栏合并出正向 / 负向预览
  → 「推送到节点」写进节点的 text / negative
```

合并规则是按逗号拆开后忽略大小写去重，保留先出现的写法。预览框可以直接手改，但**再加入新词条时会按合并结果重算**。

**站点侧需要一小段配合代码**，否则已选栏收不到词条（小窗浏览不受影响）：

```js
function hostedInPlugin() {
  try { return window.parent !== window; } catch (e) { return false; }
}

function postPick(entry) {
  try {
    window.parent.postMessage({
      source: 'codex-atlas', type: 'pick',
      codex: state.codexId || '', id: entry.id || '',
      title: entry.title || '', tags: entry.tags || '', negative: entry.n || '',
    }, window.location.origin);
  } catch (e) {}
}
```

然后在卡片操作条里加一个按钮（只在被内嵌时出现，独立打开站点不受影响）：

```js
if (hostedInPlugin()) {
  const pick = document.createElement('button');
  pick.textContent = '＋ 加入已选栏';
  pick.className = 'primary';
  pick.onclick = ev => { ev.stopPropagation(); postPick(e); };
  actions.appendChild(pick);
}
```

字段名（`state.codexId` / `entry.n` / `actions`）按你的站点实现调整。

## 我的图库

站点右上角「＋ 我的图库」进入。上传自己生成的图，它会读出图里内嵌的生成参数
（A1111 / ComfyUI / NovelAI 都认），解析出底模、LoRA、提示词，并给出对应的 C 站链接
—— **只给链接，不下载**，拿去 LoRA-Manager 里自己装。

**上传即审阅。** 选图或把图拖进来之后，会立刻弹出一个审阅窗口（左边整图、右边详情：
底模、LoRA 及 C 站链接、完整提示词、采样参数、原始元数据），底部固定在问
「这张要存进图库吗？」：

- **保存到图库** → 这才写进站点根目录下的 `self-image/`，网格里随即出现一张已入库卡片
- **不保存** → 什么都不写，直接跳过

这一步是**必须先决定**的：审阅模式下右上角 ✕ 隐藏，Esc、点遮罩、点弹窗空白都关不掉，
不点那两个按钮就出不去。一次选多张会排队，一张决定完自动弹下一张，条上会写还剩几张。
保存失败（比如后端没起来）窗口会留着让你重试，不会静默吞掉。

**存图不需要选文件夹。** 小窗和独立服务都有后端，后端跑在本机、本来就知道站点目录在哪，
直接往 `self-image/` 写。只有双击 `index.html`（`file://`）时才没有后端可调，
那种打开方式才需要手动选一次目录 —— 想要省事就用「启动法典.bat」启动独立服务。

其它两点：

- 卡片下方「从图库删除」会**连原图一起删**（`unlink`，不进回收站），所以点它会先弹一个模态确认框说清后果；传 `keepFile: true` 则只摘索引、保留原图。
- 每次删除都会往 `self-image/delete-log.txt` 追加一行流水（时间 + 来源页面 + UA）。删图不可逆，出问题时靠它对齐是谁、什么时候点的。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/codex_atlas/codexes` | 法典目录（含本地数据时间、`hasRaw` 标记） |
| GET | `/codex_atlas/random?codex=<id>` | 随机抽一条，同时返回 A1111 与 NAI 两个版本 |
| GET | `/codex_atlas/entry?codex=<id>&id=<entry>` | 按 id 取一条（已选栏用），同样返回两个版本 |
| GET | `/codex_atlas/status` | 本地数据目录与法典数量自检 |
| GET | `/codex_atlas/atlas/<path>` | 伺服离线站点整目录（小窗用），带路径穿越防护 |
| POST | `/codex_atlas/self-image` | 我的图库：存一张图 + 写 `self-image/index.js`（浏览器不能凭磁盘路径写文件，所以由后端代写）；可带 `group` |
| POST | `/codex_atlas/self-image/delete` | 我的图库：删掉一张（原图 + 索引记录）。传 `keepFile: true` 则只摘索引、保留原图 |
| POST | `/codex_atlas/self-image/group` | 我的图库：把一张图挪进/移出分组（只改索引里的 `group` 字段，不动图片） |

## 目录

```
ComfyUI-CodexAtlas/
├── __init__.py         NODE_CLASS_MAPPINGS + WEB_DIRECTORY
├── py/
│   ├── nodes.py        节点定义 + VALIDATE_INPUTS
│   ├── routes.py       aiohttp 路由与静态伺服
│   └── store.py        本地数据读取（data/*.js 解析、raw 配对、路径解析）
├── js/
│   └── codex_atlas.js  节点 UI、内置节点挂载、小窗与已选栏、语法切换
├── tests/
│   ├── test_convert.mjs      语法转换回归 28 例
│   ├── test_plugin_load.py   按 ComfyUI 方式加载包 + 前后端契约一致性
│   ├── test_store.py         数据可用性与两版配对
│   └── test_routes.py        路由层（字段映射、静态路由、穿越防护）
└── config.json         可选，本机数据目录配置（已 gitignore）
```

## 测试

```
node   tests/test_convert.mjs     # 语法转换，不联网
python tests/test_plugin_load.py  # 加载包 + 前后端契约 + 路由注册
python tests/test_store.py        # 数据可用性与两版配对
python tests/test_routes.py       # 路由层（字段映射、静态路由、穿越防护、self-image 接口）
```

全部跑一遍：

```
python -m unittest discover -s tests -t .
```

用例数量以输出为准，不在这里写死 —— 手写的数字一定会过期。

`test_routes.py` 里所有碰 `self-image/` 的用例都会把 `store.ATLAS_DIR` 指到临时目录，
不会动站点里真实的图库（这条曾经踩过坑：测试记录留在真索引里、delete-log 也写进了真目录）。

全部不联网。用到特定法典（`suozhang` 等）的用例在数据集里没有那部法典时会自动跳过，不会误报失败。

`test_plugin_load.py` 会逐字比对 Python 节点契约与前端 JS 常量——两边差一个字符就是静默失效。

## 说明

- 语法转换规则见 `js/codex_atlas.js` 顶部注释。本地两版数据都是现成的，转换器平时用不到，仅作为工具挂在 `window.__codexAtlas.convertTagsString` 供控制台调试。
- 小窗和站点**同源**（都走 ComfyUI 的 `127.0.0.1:<端口>`），所以站内导航、搜索都正常，也不存在跨域限制。
- 词条与例图版权归各自作者所有，本插件只做检索与索引，不附带任何数据。

## 许可

MIT，见 [LICENSE](LICENSE)。
