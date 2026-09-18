# 法典图鉴 · ComfyUI 节点

把**本地离线**的 NovelAI 提示词法典接进 ComfyUI：随机抽词、每次运行自动换词、按语法转换、在 ComfyUI 页面内开小窗翻例图、
把挑好的词一次推进节点。词库和站点全在你自己的机器上，不联网。

仓库自带 13 部法典、39111 条词条（约 45 MB 数据），克隆下来放进 `custom_nodes/` 就能用，
**不需要另外准备站点**。例图（约 1.3 GB，7z 分卷）不在仓库里，要从 Release 单独下，
见「完整例图」一节 —— 不下也能正常用。

## 快速上手

1. **装**：把整个 `ComfyUI-CodexAtlas` 文件夹放进 `<ComfyUI>/custom_nodes/`，重启 ComfyUI。
2. **确认装上了**：刷新浏览器页面，在画布空白处双击（或右键 → `Add Node`），搜 `法典图鉴`，
   应该能看到 `法典图鉴 · 文本编码` 和 `法典图鉴 · 提示词` 两个节点。能看到就是装好了。
3. **连**：加一个 `法典图鉴 · 文本编码`，把它的 `clip` 接上 checkpoint 加载器的 CLIP，
   它的 `positive` / `negative` 两个输出分别接 KSampler 的 `positive` / `negative`。
   这个节点本身就等于一个「CLIP文本编码」，**不用再串一个**。
4. **抽词**：点节点上的 `随机提示词`，文本框里立刻填入一整条提示词。不满意就再点一次。
   嫌每次都要手点，就点旁边的 `运行自动随机：关（点击开启）` 打开开关 —— 之后每次运行工作流都自动换一条新词。
5. **翻例图找灵感**：点 `前往词典站寻找灵感` 开小窗。左边是例图瀑布流，卡片下方点 `＋ 加入已选栏`
   把看中的词攒到右边，攒够了点右下的 `推送到节点`，内容就写回刚才那个节点。

到第 4 步就能出图了，第 5 步是可选的精细化流程。

## 界面上有什么

### 三个入口

| 入口 | 在哪 | 输出 | 什么时候用它 |
| --- | --- | --- | --- |
| `法典图鉴 · 文本编码` | 右键 → `法典图鉴` | `CONDITIONING` ×2（`positive` / `negative`） | **推荐**。自带 `clip` 输入，直接接 KSampler，一步到位 |
| `法典图鉴 · 提示词` | 右键 → `法典图鉴` | `STRING` ×2（`positive` / `negative`） | 想把提示词文本转给别的节点，或者只想产出文字 |
| 内置 CLIP文本编码上的按钮 | 默认**关**，要自己去设置里打开 | 无（改造原有的 `CLIP文本编码` 节点） | 工作流里已经堆了一堆 `CLIP文本编码`，不想换节点 |

第三个是设置项：`设置` → 搜「法典图鉴」→ 打开
**「法典图鉴：在「CLIP文本编码」节点上显示按钮」**（默认关闭，改完刷新页面生效）。
打开后每个 `CLIP文本编码` 底部会多出四个控件。默认关是因为工作流一复杂，
每个文本编码节点都长四个控件很碍事。

### 节点上的控件

`法典图鉴 · 文本编码` 和 `法典图鉴 · 提示词` 都是这个形态：文本框 → 三个按钮 → 语法切换 → 法典来源。

- `前往词典站寻找灵感`：开小窗浏览站点（不跳转页面）
- `随机提示词`：从当前选中的法典里随机抽一条填进框
- `运行自动随机：关（点击开启）`：点一下打开，之后每次运行工作流都会先自动换一条新词；再点一下关掉，
  回到手动点 `随机提示词`。开关状态跟着工作流一起存，重开页面不会自己复位
- `语法：A1111（点击切换）`：点一下切到 `原始 NAI`，再点切回来
- `法典来源` 下拉：决定 `随机提示词` 从哪部法典抽。两个「法典图鉴」节点都有这一项
- `negative` 框：`法典图鉴 · 文本编码` 上它是可选输入，留空就输出一个空的负向条件

内置 `CLIP文本编码` 上挂的只有前四个控件，没有法典来源下拉 —— 它的 `随机提示词` 走默认的全法典。

### 小窗里有什么

顶栏：`◆ 法典图鉴`、`本地离线法典 · 不联网`、站内搜索框、`搜索`、`关闭`。

图库条（顶栏下面单独一条）：`◆ 我的图库` + 右侧按钮。不在图库里时按钮写 `打开图库`，
进了图库变成 `← 回到法典`。这一条是为了让你不用去 iframe 里翻站点顶栏那个小按钮。

主体分左右两块。左边是站点本体（例图瀑布流），右边是 `已选栏`：

- `已选栏` 标题右边显示当前攒了几条
- 中间是已选词条列表，每条可以单独移出
- 下面是 `POSITIVE` 和 `NEGATIVE` 两个预览框，都可以**直接手改**，框的右上角实时显示字数
- 最下面 `清空` 和 `推送到节点`

关窗有三种方式：点 `关闭`、按 `Esc`、点小窗外的灰色区域。

### 站点本体（小窗左半边）

顶栏：`＋ 我的图库`、法典下拉、搜索框、`🎲` 随机、`🌙` 日/夜切换、`仅看新增`、`NSFW` 开关。

搜索框支持多词，空格分隔；按 `/` 直接聚焦到搜索框，按 `Esc` 清除。

左栏是 `分类目录` 树，底部显示当前分组的统计。

主区是卡片瀑布流。**点卡片任意处 = 复制这张卡片的全部提示词**，卡片会闪一下作为反馈。
卡片下方有条件地出现 `＋ 加入已选栏` —— 只有在小窗里（被插件内嵌）才会出现，
单独用浏览器打开站点时没有这个按钮。

## 安装

把整个 `ComfyUI-CodexAtlas` 目录放进 ComfyUI 的 `custom_nodes/` 下：

```
<ComfyUI>/custom_nodes/ComfyUI-CodexAtlas/
```

不想拷贝的话用目录联结（Windows）：

```
mklink /J "<ComfyUI>\custom_nodes\ComfyUI-CodexAtlas" "<本仓库克隆到的位置>"
```

重启 ComfyUI。改动生效方式：Python 侧要重启；`js/` 下改完刷新浏览器即可。

**装完没出现节点怎么办**

1. 看 ComfyUI 的启动日志，搜 `CodexAtlas` 或 `法典图鉴`，导入失败会在这里报出来
2. 确认目录层级对：`custom_nodes/ComfyUI-CodexAtlas/__init__.py` 这一层，别多套一层文件夹
3. 强制刷新浏览器（`Ctrl+F5`）——前端脚本很可能被缓存了旧版本

## 完整例图

仓库里**不带例图**：超出仓库该有的体积。例图单独发布成 Release 附件，打成了 **7z 分卷**。

### 让它自己拉（推荐）

打开节点上的「前往词典站寻找灵感」小窗。**只要一张配图都没有**，小窗顶部会出现一条提示，
点「拉取例图」就行 —— 后端会：

1. 先找本机装的 7-Zip（常见安装路径 + PATH + 插件目录）
2. 找不到就下官方那个**免安装的单文件 `7zr.exe`**（约 588 KB）放进插件目录 ——
   不用装 7-Zip、不用管理员权限
3. 下齐全部 4 个卷（带断点续传），逐个核对 SHA256
4. 解压到 `atlas/images/`

下载期间其它功能照常可用。已经拉了就不重复提示；拉完了这条自动消失。

**解压不会动你已有的东西。** 用的是 `7z x -aoa`——只覆盖同名文件，7z 解压是往目标目录里
合并、不是重建，所以你 `atlas/images/` 里原有的 `README.txt`、自己放进去的图、别的法典目录
都保留。这一条专门实测过（新图进来了，原有的四样东西一样没少）。
另外解压完成后代码会**显式重写一次 `images/README.txt`**：`atlas/images/` 在解压前就存在
（仓库里带着这个说明文件），解压是往里合并，所以不能指望它随包进来。

### 拉取失败会留下什么

失败或中断时，**已经下完并且 SHA256 校验通过的分卷会特意留在**插件目录的 `bin/_fetch_tmp/` 里 ——
再点一次「拉取例图」会直接跳过它们，不必从零再下 1.3 GB；半截的 `.part` 也在那儿，下次带着
`Range` 接着往下写。图本身不受影响：没解压就不会动 `atlas/images/`。

代价是它真的占磁盘。所以小窗顶部那条提示会显示缓存占用，旁边配一个 `清理下载缓存` 按钮，
点一下就清掉。正在拉取时这个按钮不出现 —— 那时候清等于把 worker 正在写的文件抽走。
解压成功后缓存会**自动**清掉，不用管；失败后才有东西可清。

清理只删 `bin/_fetch_tmp`，**绝不碰 `atlas/images/`**（那里是你的图）。

### 手动下载

**下载页**：https://github.com/chenr5934-tech/ComfyUI-m8tags/releases/tag/images-v1

把下面**全部 4 个卷**下到同一个目录（合计约 1.3 GB）：

| 分卷 | 大小 |
| --- | --- |
| `m8tags-images.7z.001` | 420.0 MB |
| `m8tags-images.7z.002` | 420.0 MB |
| `m8tags-images.7z.003` | 420.0 MB |
| `m8tags-images.7z.004` | 119.1 MB |
| `SHA256SUMS.txt` | 1 KB |

**必须下齐才能解压。** 这是同一个包切成的分卷，不是互相独立的压缩包 —— 少任何一个卷，整包都打不开。
好处也正是这个：不会出现"只下了其中几个、图缺了一半还没察觉"。

### 怎么解压

**用 7-Zip**（或 WinRAR）。右键**第一个卷** `m8tags-images.7z.001` → `7-Zip` → `解压到…`，
目标填插件的 `atlas/` 目录。命令行等价写法：

```
7z x m8tags-images.7z.001 -o"<插件目录>\atlas"
```

> Windows 资源管理器自带的「全部解压」**不认分卷**，双击 `.001` 只会报错。
> 没装 7-Zip 就去 [7-zip.org](https://www.7-zip.org/) 下一个，几 MB 的事。

### 解压到 `atlas/`，不是 `atlas/images/`

包里的第一层**已经是 `images/`** 了，所以目标是把整个包解压到 **`atlas/`**，
让 `images/` 这一层刚好落在它下面：

```
ComfyUI-CodexAtlas/
└── atlas/
    ├── index.html
    ├── data/                  词库（本来就有）
    ├── images/                ← 解压出来的就是这个
    │   ├── suozhang_r18/
    │   ├── jiegou_yuandian/
    │   └── …（共 13 个目录）
    └── self-image/
```

**别解压到 `atlas/images/`** —— 那样会变成 `atlas/images/images/<codex>/`，站点找不到图。
包名和目录名都带 `images`，这一步最容易搞反，对着上面的树看一眼就清楚了。

### 怎么确认放对了

`atlas/images/jiegou_yuandian/` 里应该是 **265 张** `.jpg`：

```powershell
(Get-ChildItem "<插件目录>\atlas\images\jiegou_yuandian" -Filter *.jpg).Count   # 265
```

全部到位的话，`atlas/images/` 下是 13 个目录、合计 37684 个文件。

例图是静态文件，解压完**刷新一下浏览器页面**就显示，不用重启 ComfyUI。

**不装例图照样能用**：卡片位置显示占位图，检索、筛选、复制、已选栏、推送节点全部照常。
例图只是卡片上的一张预览。

> **包里只有 13 个法典目录，和站点列的 13 部是对齐的。**
> 你自己站点的 `images/` 下如果有 16 个目录（多了 `artist_nai45_strings`、`community_ai_misc`、
> `mengshen_pack`），那三个是法典合并时**被取代的旧版** —— `artist_nai45_personal` 的 `aliases`
> 里记着前者，`nai45_community_pack` 的 `aliases` 里记着后两者，词条已被新法典完整收进去。
> 站点不列它们是对的，打包时也会自动跳过（省 257 MB）；想连它们一起打，给脚本加 `--all`。

校验（可选）：

```
certutil -hashfile m8tags-images.7z.001 SHA256
```

拿输出对着 `SHA256SUMS.txt` 里同名的行比。包是 `Copy` 模式存的、没有二次压缩（JPEG 早就压过了），
所以打包和解压都快。**分卷只要有一个对不上，整包都解不开，下完先验一遍更省事。**

**自己重新打包**（图库更新之后）：

```
python tools/pack-images.py    --src "<站点目录>/images" --out "<输出目录>"
python tools/publish-images.py --dir "<输出目录>" --tag images-v1 --replace
```

第一个脚本读站点 `data/index.js`，**只打包登记在册的法典** —— 那些没登记的旧版目录（见上面那条注解）
会自动跳过，想连它们一起打就加 `--all`。然后按 `--volume`（默认 420 MB）切成 7z 分卷，
顺带写出 `MANIFEST.json` 和 `SHA256SUMS.txt`。

第二个脚本走 GitHub API 建 release 并上传，token 从 git 凭据管理器里取；`--replace` 会先删掉 Release 上
不在本次清单里的旧附件（换打包格式时用得上），已存在的附件跳过，传断了直接重跑。

## 常用操作

### 随机抽一条

点 `随机提示词`。抽哪部法典由节点上的 `法典来源` 下拉决定（内置 `CLIP文本编码` 上没有这个下拉，
它走默认的全法典；「运行自动随机」也认这个下拉）。想让它每次运行自己换词，看下一节。

抽到的词会**同时**准备 A1111 和原始 NAI 两个版本，当前语法用哪版就填哪版，切换语法是原地重渲染，
不会丢掉你手改过的内容。

### 每次运行自动换词

点 `运行自动随机：关（点击开启）` 打开开关。开着的时候，每次运行工作流都会在提交前重新抽一条 ——
`Run` 按钮、`Ctrl+Enter`、只跑选中的输出节点、队列空时的自动续跑，全都算。一次运行抽一次。

抽完立刻写进框里，提交上去的就是你看到的那一份，**不是**「界面留着旧词、后端悄悄跑新词」。

开关是**每个节点各自一份**：工作流里有几个「法典图鉴」节点，就各自独立控制几份 ——
开着的抽，关着的一动不动，你手写的内容也不会被碰到。开关状态存在节点的
`properties.codexAtlasAutoRandom` 里，跟工作流一起保存。

抽词接口报错（后端没起来、数据不在）时只弹一条提示，**不会拦住运行**：按框里现有的内容跑完，
要不要停下来查由你决定。

想回到手动，点一下开关关掉就行；`随机提示词` 按钮任何时候都能用，不受开关影响。

### 切换语法

点 `语法：A1111（点击切换）` 就地切换。两版数据都是本地现成的，切换不联网、不重新抽词。

这个状态两个「法典图鉴」节点存在自己的 `syntax` widget 里，挂到内置 `CLIP文本编码` 上时存进节点的
`properties.codexAtlasSyntax`。两种都跟着工作流一起序列化 —— 存了工作流下次打开，语法还是你选的那个。

### 翻例图找灵感，攒一批再推

1. 点 `前往词典站寻找灵感` 开小窗
2. 左边翻例图，或者用顶栏搜索框直接搜 tag
3. 看中一张，点它下方的 `＋ 加入已选栏`，词就进了右边
4. 右边的 `POSITIVE` / `NEGATIVE` 框实时显示合并后的结果，可以直接手改
5. 点 `推送到节点`

合并规则：按逗号拆开后忽略大小写去重，保留先出现的写法。**再加入新词条时会按合并结果重算预览**，
所以手改过的内容在加新词条时会被重算覆盖 —— 想让手改生效，等挑完了再改。

同一条（同一个 `codex + id`）只会进已选栏一次，重复点会提示「这条已经在已选栏里了」。

### 推送时写了哪些框

取决于目标节点有没有 `negative` widget：

- **有负向框**（`法典图鉴 · 文本编码`、`法典图鉴 · 提示词`）：正向写 `text`，负向写 `negative`，两个都直接落。
- **没有负向框**（内置 `CLIP文本编码`）：正向写进 `text`；负向**自动复制到剪贴板**并弹提示，
  你粘到负向编码器里即可。负向为空时只写正向。

推送后节点上那份「NAI 原始底稿」会作废，下次切语法不会再覆盖你刚推的内容。

## 我的图库

把小窗顶部那条 `◆ 我的图库` 点开（或站点顶栏右上角的 `＋ 我的图库`）进入。
上传自己生成的图，它会读出图里内嵌的生成参数（A1111 / ComfyUI / NovelAI 都认），
解析出底模、LoRA、提示词，并给出对应的 C 站链接 —— **只给链接，不下载**，拿去 LoRA-Manager 里自己装。

界面是三分栏：左边 `我的分组`（带 `＋ 新建分组`），中间卡片网格，右边上传框和保存位置。
网格用的是和法典一样的卡片样式，卡片下方有 `查看详情`。

**上传即审阅。** 选图或把图拖进右侧那个框之后，会立刻弹出一个审阅窗口（左边整图、右边详情：
底模、LoRA 及 C 站链接、完整提示词、采样参数、原始元数据），底部固定在问「这张要存进图库吗？」：

- `保存到图库` → 这才写进站点根目录下的 `self-image/`，网格里随即出现一张已入库卡片
- `不保存` → 什么都不写，直接跳过

这一步是**必须先决定**的：审阅模式下右上角 ✕ 隐藏，Esc、点遮罩、点弹窗空白都关不掉，
不点那两个按钮就出不去。一次选多张会排队，一张决定完自动弹下一张，条上会写还剩几张。
保存失败（比如后端没起来）窗口会留着让你重试，不会静默吞掉。

**存图不需要选文件夹。** 小窗和独立服务都有后端，后端跑在本机、本来就知道站点目录在哪，
直接往 `self-image/` 写。只有双击 `index.html`（`file://`）时才没有后端可调，那种打开方式才需要手动选一次目录
—— 想要省事就用站点目录里的 `启动法典.bat` 启动独立服务。

**图库里的图也能推进节点。** 卡片下方有 `＋ 加入已选栏`（和法典卡片一样，只在小窗里出现），
推过去的条目自带正负提示词，宿主直接拿来用、不再去查法典。

其它两点：

- 卡片下方那一行里（`查看详情` 旁边）有 `从图库删除`，它会**连原图一起删**（`unlink`，不进回收站），
  所以点它会先弹一个模态确认框，逐条写清会删掉什么、不会动什么；传 `keepFile: true` 则只摘索引、保留原图。
- 每次删除都会往 `self-image/delete-log.txt` 追加一行流水（时间 + 来源页面 + UA）。
  删图不可逆，出问题时靠它对齐是谁、什么时候点的。

## 我的收藏

看中的词条，点卡片**右上角的 ☆** 就钉住，下次直接从收藏里拿，不用再从头翻一遍。

顶栏 `★ 我的收藏` 进去。左栏是收藏分类，中间是卡片；卡片下方有个下拉，把它归进哪个分类。
分类自己建（`＋ 新建分类`），删分类时里面的词条会**退回未分类**而不是跟着一起没。

和「我的图库」并列的两个全屏视图，互相切换是干净的，不会叠在一起。

**只记「是哪一条」，不存内容快照。** 存的是 `{法典, 词条id, 标题, 分类}`，打开时按法典现查数据 ——
所以法典更新后，收藏里看到的也是最新的 tags，不会拿一份过期的旧串去生成图。
代价是某条词条在法典里被删掉后收藏里会找不到，那种情况会在状态行里明说有几条失效，不静默吞掉。

存在浏览器 `localStorage['qtc-favs']`，和浏览位置一样是本机这份浏览器的，换浏览器不会跟着走。

## 法典数据与目录配置

本仓库**内置了一份法典站点**，就在插件目录的 `atlas/` 下，开箱可用：

```
atlas/
├── index.html  app.js  app.css  gallery.js  gallery-meta.js  converter.html
├── 启动法典.bat  serve.py     独立起一个本地服务（可选，跟插件无关也能用）
├── data/
│   ├── index.js          → window.QTC_META = [...]      （13 部法典的目录）
│   └── <id>.js           → window.QTC_DATA["<id>"] = { meta, entries: [...] }
├── images/               例图（仓库里没有，见「完整例图」）
└── self-image/           我的图库（仓库里没有，首次保存图片时自动生成）
```

`启动法典.bat` 和 `serve.py` 是给「不走 ComfyUI、单独打开站点」准备的，双击就能起一个本地服务，
不依赖插件。整份 `atlas/` 也可以直接拷出去当独立站点用。

**换成你自己的站点**，按下面这个结构准备一份，然后用环境变量或 `config.json` 指过去：

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

### 插件怎么找站点

按下面的顺序，**第一个真的存在（含 `data/index.js`）的目录胜出**：

1. 环境变量 `CODEX_ATLAS_DIR`
2. 插件目录下的 `config.json` 里的 `atlasDir`
3. 插件目录内的 `atlas/`（内置那份）
4. 与插件同级的 `本地离线提示词法典/`、`tag-atlas/`、`codex-atlas/`、`atlas/`
5. 插件目录本身（把站点内容直接摊在插件里）

原始 NAI 数据同理，顺序是：环境变量 `CODEX_ATLAS_RAW_DIR` → `config.json` 的 `rawDir` →
`<站点目录>/raw/` → 与插件同级的 `raw/`、`codexes-raw/`。

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

## 站点对接契约

这一节是给**改站点、或拿自己的站点来对接**的人看的。只想用插件的话可以跳过。

```
站点卡片「＋ 加入已选栏」
  → postMessage 到宿主
      · 法典词条：只传 codex + entry id
      · 我的图库条目：额外传 kind:"self" + 自带的 tags / negative
  → 法典词条由宿主调 /codex_atlas/entry 补齐两个语法版本
      （kind:"self" 跳过这一步 —— 它不在法典里，后端查不到）
  → 已选栏合并出正向 / 负向预览
  → 「推送到节点」写进节点的 text / negative
```

站点侧需要一小段配合代码，否则已选栏收不到词条（小窗浏览不受影响）：

```js
function hostedInPlugin() {
  try { return window.parent !== window; } catch (e) { return false; }
}

function postPick(entry, extra) {
  try {
    window.parent.postMessage({
      source: 'codex-atlas', type: 'pick',
      codex: state.codexId || '', id: entry.id || '',
      title: entry.title || '', tags: entry.tags || '', negative: entry.n || '',
      ...extra,                       // 「我的图库」用它带 kind / tags / negative 进来
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

**契约细节**（主机侧 `addPick` 的实际行为，改站点时别踩）：

- `kind` 为 `"self"` 表示**内容自带**，宿主不再请求后端：`tags` 直接当正向、`negative` 当负向，
  两个语法版本用的是同一份文本。用来推「我的图库」这种不在法典里的条目。
- `kind` 缺省或其它值是**法典词条**：宿主忽略 `tags` / `negative`，改为按 `codex` + `id`
  调 `/codex_atlas/entry` 取权威内容（同时拿到 A1111 与 NAI 两版）。
- 去重键是 `codex + id`，同一对只会进已选栏一次。
- `codex` 和 `id` **都必须非空**，否则整条消息被丢弃（`kind:"self"` 也一样）。

## HTTP 接口

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

## 仓库结构

```
ComfyUI-CodexAtlas/
├── __init__.py         NODE_CLASS_MAPPINGS + WEB_DIRECTORY
├── py/
│   ├── nodes.py        两个节点定义 + VALIDATE_INPUTS
│   ├── routes.py       aiohttp 路由与静态伺服
│   └── store.py        本地数据读取（data/*.js 解析、raw 配对、路径解析）
├── js/
│   └── codex_atlas.js  节点 UI、内置节点挂载、小窗与已选栏、语法切换
├── atlas/              内置法典站点（可整体替换，见「法典数据与目录配置」）
│   ├── index.html  app.js  app.css  converter.html
│   ├── gallery.js      我的图库 UI
│   ├── gallery-meta.js 图内生成参数解析（A1111 / ComfyUI / NovelAI）
│   ├── serve.py        独立启动用的零依赖后端（可选）
│   ├── 启动法典.bat     双击起独立服务（可选，不依赖 ComfyUI）
│   ├── data/           13 部法典（约 45 MB，本仓库携带）
│   ├── images/         例图目录（仓库不带，只有 README.txt）
│   └── self-image/     我的图库（仓库不带，首次保存时生成）
├── tools/
│   ├── pack-images.py     例图装箱（分发用）
│   └── publish-images.py  发到 GitHub Release
├── tests/
│   ├── test_convert.mjs      语法转换回归 28 例
│   ├── test_auto_random.mjs  运行前自动随机（假 app 跑真实调用序列）
│   ├── test_plugin_load.py   按 ComfyUI 方式加载包 + 前后端契约一致性
│   ├── test_store.py         数据可用性与两版配对
│   └── test_routes.py        路由层（字段映射、静态路由、穿越防护）
└── config.json         可选，本机数据目录配置（已 gitignore）
```

## 测试

```
node   tests/test_convert.mjs     # 语法转换，不联网
node   tests/test_auto_random.mjs # 运行前自动随机：开关、只抽开着的那几个、失败不拦运行
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

`test_auto_random.mjs` 不比对文本，它真跑逻辑：把 `codex_atlas.js` 里那行裸模块 import 换成注入的假 `app`，
照 ComfyUI 的顺序走一遍（`setup()` → `nodeCreated()` → 点开关 → `queuePrompt()`），断言的是行为 ——
开着开关的节点提交前被重新抽词、关着的一动不动、抽词接口报错时照样提交。
纯文本断言（"文件里有 `installAutoRandomHook` 字样"）测不出少写一次 `await`、过滤条件写反这类问题。

`tests/site/` 是**站点侧**测试的备份副本（测 `atlas/` 那套站点本体，不是插件的 Python 侧），
说明见 [tests/site/README.md](tests/site/README.md)。它们不能在本目录下直接跑——
脚本按相对路径定位站点根，挪过来就对不上了；要跑请去站点目录，或显式把 URL 当参数传进去。

## 说明

- 语法转换规则见 `js/codex_atlas.js` 顶部注释。本地两版数据都是现成的，转换器平时用不到，
  仅作为工具挂在 `window.__codexAtlas.convertTagsString` 供控制台调试。
- 小窗和站点**同源**（都走 ComfyUI 的 `127.0.0.1:<端口>`），所以站内导航、搜索都正常，也不存在跨域限制。
- 「我的图库」是唯一会联网的功能（查 civitai.com 拿模型页面链接）；网络不通就降级成「C 站没搜到」，
  不影响其余任何功能。
- 本仓库只做检索与索引：**携带词条文本数据，不携带任何例图**（`atlas/images/` 里只有一个说明文件）。
  数据来源、作者与版权见下面的「致谢」。
- 内置的 `atlas/` 是给「拷进 `custom_nodes` 就能用」准备的；你自己的站点如果配置了
  `atlasDir` / `CODEX_ATLAS_DIR`，优先级更高，不会跟内置那份打架。

## 致谢

词库数据来自 **NovelAI 标签云法典**：

**https://novelai.quicktagcloud.com/?c=artist_nai5_personal**

那是把社区整理的 NovelAI 提示词「法典」做成以图为主的可视化图鉴的地方 —— 照着例图选词、一点即复制。
本插件的「前往词典站寻找灵感」小窗浏览的就是这份图鉴的本地离线版，`atlas/data/` 下的词条、
分类树和版本信息全部来自那里。**如果你用得顺手，请先去给原站点和下面这些作者一点热度。**

感谢站点与各位法典作者的无私分享：

| 法典 | 作者 |
| --- | --- |
| NovelAI v5画师词典 | 花枝鱼 / 九七 / 无冕 / 成川姬 / W.O.F / 梦神 / wwuumm |
| NovelAI v4.5画师词典 | 千早爱音 / 兔 / 未署名 / PieDriver / 梦神 |
| NovelAI v4.5社区精选图包 | 梦神整理 / 社区贡献者 |
| NovelAI v5社区精选图包 | 梦神 / 所长 / 社区贡献者 |
| 所长常规NovelAI个人法典 | 戒红所 |
| 所长色色NovalAI个人法典（合并版） | 一般所长 |
| 涩涩法典(梦神版) | 梦神 |
| 渡鸦的构图鉴 | 渡鸦 |
| 更衣人偶 | Sol |
| 叫我千藤就好了の衣柜 | 叫我千藤就好了 |
| 构图风格 | 凉夏之夜 |
| 解构原典 | 解构原典编撰组 |
| 站长的小仓库 | Enter |

词条内容与例图版权归各自作者所有，本仓库只做可视化整理与索引。

站点 about 里列出的相关去处：

- [NovelAI 官网](https://novelai.net) —— 官方生成站
- [所长法典教程（NGA 原帖）](https://ngabbs.com/read.php?tid=46533889&rand=707)
- [魔法工坊](https://stinggrey.github.io/MagicWorkshop/) —— NAI 元数据修改 / 法术解析 / 曲线像素混淆

## 许可

MIT，见 [LICENSE](LICENSE)。
