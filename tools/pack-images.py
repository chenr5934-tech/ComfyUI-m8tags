"""把法典例图打成分卷压缩包（7z 分卷），用于分发。

例图没法进 git（站点源目录里是 16 个目录 / 1636 MB / 44984 个文件），走 GitHub Release
附件分发。默认只打站点登记在册的法典 —— 当前 13 部 / 37684 个文件 / 约 1.3 GB。
这里打成 **7z 分卷**：`m8tags-images.7z.001`、`.002`…，**必须下齐所有卷才能解压**。
好处是不会出现"只下了其中几个、图缺了一半还没察觉"的情况，卷号也一眼能看出顺序。

为什么是 7z 分卷而不是 zip 分卷：
  - ZIP 的分卷（`.z01`/`.z02` + `.zip`）Python 的 zipfile 既不支持创建也不支持读取，
    要引第三方库；7z 命令行现成，命名也对得上用户手上的 7-Zip。
  - 早先那版是「多个互相独立的 zip」，用户少下一个包只会静默缺图，看不出问题。

代价（这个要跟下载的人讲清楚）：
  - 分卷只有 7-Zip / WinRAR 能解，Windows 资源管理器自带的「全部解压」不认分卷；
  - 任意一个卷缺失或损坏，整包都打不开 —— 下完先对 SHA256 再解压。

用法：
    python tools/pack-images.py --src "<站点>/images" --out "D:/dist"
    python tools/pack-images.py --src "<站点>/images" --out "D:/dist" --volume 420
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 常见安装位置，找不到再用 PATH
SEVEN_ZIP_CANDIDATES = (
    r"D:\7z\7-Zip\7z.exe",
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
)


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return "{:.1f} {}".format(n, unit) if unit != "B" else "{} B".format(int(n))
        n /= 1024
    return "{} B".format(int(n))


def find_7z(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return p
        raise SystemExit("--7z 指的路径不是文件：{}".format(p))
    for cand in SEVEN_ZIP_CANDIDATES:
        if Path(cand).is_file():
            return Path(cand)
    found = shutil.which("7z") or shutil.which("7za")
    if found:
        return Path(found)
    raise SystemExit(
        "找不到 7z.exe。用 --7z 指定，例如：\n"
        "  --7z \"D:/7z/7-Zip/7z.exe\""
    )


def sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def registered_codex_ids(site_root: Path):
    """读站点 data/index.js 的 QTC_META，返回真正登记在册的法典 id。

    例图目录里常留着一些「已被合并取代的旧版」的图 —— 比如 mengshen_pack 和
    community_ai_misc 早就并进了 nai45_community_pack，artist_nai45_strings 并进了
    artist_nai45_personal，但它们自己的 images/ 目录还在（实测这部分有 257 MB）。
    站点根本不会列出这些法典，打进去只是让下载的人白下几百兆、下完还看不到。
    """
    index = site_root / "data" / "index.js"
    if not index.is_file():
        return None
    try:
        text = index.read_text("utf-8")
        start = text.find("[")
        if start < 0:
            return None
        data, _ = json.JSONDecoder().raw_decode(text, start)
    except (OSError, UnicodeError, ValueError):
        return None
    if not isinstance(data, list):
        return None
    ids = [m.get("id") for m in data if isinstance(m, dict) and m.get("id")]
    return ids or None


def scan_source(src: Path, only=None):
    """统计内容。only 给定时，只收其中的法典目录，其余记进 skipped。"""
    total = 0
    size = 0
    keep = []
    skipped = []
    for d in sorted(src.iterdir()):
        if not d.is_dir():
            continue
        files = [f for f in d.rglob("*") if f.is_file()]
        if not files:
            continue
        bytes_here = sum(f.stat().st_size for f in files)
        if only is not None and d.name not in only:
            skipped.append((d.name, len(files), bytes_here))
            continue
        keep.append(d.name)
        total += len(files)
        size += bytes_here
    return total, size, keep, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description="把法典例图打成 7z 分卷")
    ap.add_argument("--src", required=True, help="例图目录（含 <codex>/ 子目录）")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--7z", dest="seven_zip", default=None, help="7z.exe 路径")
    ap.add_argument("--volume", type=int, default=420, help="每卷大小 MB（默认 420）")
    ap.add_argument("--name", default="m8tags-images", help="包名")
    ap.add_argument("--all", action="store_true",
                    help="连没登记进站点索引的旧版目录一起打（默认只打登记在册的）")
    args = ap.parse_args()

    seven = find_7z(args.seven_zip)
    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    if not src.is_dir():
        raise SystemExit("找不到例图目录：{}".format(src))
    out.mkdir(parents=True, exist_ok=True)

    registered = None if args.all else registered_codex_ids(src.parent)
    total_files, total_size, codex_ids, skipped = scan_source(src, registered)
    if not total_files:
        raise SystemExit("例图目录是空的：{}".format(src))

    print("源目录 : {}".format(src))
    if registered:
        print("在册   : data/index.js 登记了 {} 部法典，按它筛".format(len(registered)))
    print("内容   : {} 个法典目录，{} 个文件，{}".format(
        len(codex_ids), total_files, human(total_size)))
    if skipped:
        print("跳过   : {} 个未登记的旧版目录，省下 {}".format(
            len(skipped), human(sum(s[2] for s in skipped))))
        for name, n, b in skipped:
            print("         {:<24} {} 个文件  {}".format(name, n, human(b)))
    print("打包器 : {}".format(seven))
    print("分卷   : 每卷 {} MB".format(args.volume))

    archive = out / "{}.7z".format(args.name)
    # 清掉上次留下的卷，否则 7z 会停下来问要不要覆盖
    stale = sorted(out.glob("{}.7z.*".format(args.name)))
    for old in stale:
        old.unlink()
    if archive.is_file():
        archive.unlink()
    if stale:
        print("已清掉 {} 个旧卷".format(len(stale)))

    # cwd 设在源目录的父级、源用相对名，这样包内路径就是 images/<codex>/<file>，
    # 解压到插件的 atlas/ 下即可就位。
    # -m0=Copy：JPEG 早就压过了，再跑一遍 LZMA 只是白等，体积几乎不变。
    cmd = [
        str(seven), "a",
        "-v{}m".format(args.volume),
        "-m0=Copy",
        "-bso0", "-bsp0",          # 进度条会刷屏，关掉
        str(archive),
    ] + ["{}/{}".format(src.name, cid) for cid in codex_ids]
    print("\n正在打包（Copy 模式，不做二次压缩）…", flush=True)
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=str(src.parent))
    if proc.returncode != 0:
        raise SystemExit("7z 打包失败，退出码 {}".format(proc.returncode))
    print("打包完成，用时 {:.0f}s".format(time.time() - t0))

    volumes = sorted(out.glob("{}.7z.*".format(args.name)))
    if not volumes:
        raise SystemExit("没有生成分卷 —— --volume 是不是比内容还大？")

    print("\n分卷（{} 个）:".format(len(volumes)))
    parts = []
    for v in volumes:
        size = v.stat().st_size
        digest = sha256_of(v)
        parts.append({"name": v.name, "bytes": size, "sha256": digest})
        print("  {:<32} {:>9}  {}".format(v.name, human(size), digest[:16] + "…"))

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": src.name,
        "format": "7z-split",
        "layout": "{}/<codex>/<file>".format(src.name),
        "extractTo": "atlas/",
        "firstVolume": volumes[0].name,
        "howToExtract": (
            "把所有分卷下到同一个目录，用 7-Zip 右键第一个卷 "
            "→ 解压到插件的 atlas/ 下。Windows 自带的解压不支持分卷。"
        ),
        "volumeBytes": args.volume * 1024 * 1024,
        "totalFiles": total_files,
        "totalBytes": total_size,
        "codices": codex_ids,
        "skipped": [{"id": n, "files": f, "bytes": b} for n, f, b in skipped],
        "parts": parts,
    }
    (out / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "SHA256SUMS.txt").write_text(
        "".join("{}  {}\n".format(p["sha256"], p["name"]) for p in parts), encoding="utf-8")

    print("\n合计 {} 个卷，{} 个文件，{}".format(len(parts), total_files, human(total_size)))
    print("解压目标：<插件目录>/{}".format(manifest["extractTo"]))
    print("包里路径：{}/<codex>/<file>".format(src.name))
    print("清单    ：{}".format(out / "MANIFEST.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
