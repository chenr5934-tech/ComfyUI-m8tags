词库配图目录（不随仓库分发）
============================

法典的每张卡片都带一张配图。整套配图有 1.6 GB / 44984 个文件，
塞进 git 仓库不合适，所以这里默认是空的。

配图在 Release 里，打成了 7z 分卷（4 个卷，约 1.3 GB）：

    https://github.com/chenr5934-tech/ComfyUI-m8tags/releases/tag/images-v1

把 4 个卷全下到同一个目录，用 7-Zip 右键第一个卷（.7z.001）解压到 atlas/ 下即可。
必须下齐才能解压；Windows 资源管理器自带的解压不认分卷。
分卷里只含站点登记在册的法典，共 13 个目录 —— 详细步骤见仓库 README 的「完整例图」。

没有配图也能正常用：检索、搜索、复制 tag、加入已选栏、推送到节点
全都不依赖图片，卡片上显示占位块而已。

想手动补图的话，目录结构是：

    atlas/images/<法典id>/<图片文件名>

法典 id 就是 data/index.js 里每部法典的 id（例如 artist_nai5_personal、
suozhang、composition_style…），文件名要和 data/<id>.js 里词条的 img 字段一致。

另一种做法：不用内置站点，改配 config.json 指向你本地那份完整站点
（带 images/ 的那种），插件会优先用你配的那个：

    { "atlasDir": "D:/你的路径/离线法典站点" }
