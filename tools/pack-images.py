"""把法典例图打包成可分发的大包。

例图没法进 git：1636 MB / 44984 个文件，远超 GitHub 仓库的合理体积。
所以走 Release 附件分发 —— 这个脚本把 images/<codex>/ 按体积累计装箱，
每包不超过 --max-mb，包内路径固定为 images/<codex>/<file>，
别人解压到插件的 atlas/ 目录就直接到位。

用法：
    python tools/pack-images.py --src "D:/.../本地离线提示词法典/images" --out "D:/dist"

同一个法典不会被打散到两个包里 —— 每个目录整体入箱，箱子装不下就开新箱。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return "{:.1f} {}".format(n, unit) if unit != "B" else "{} B".format(int(n))
        n /= 1024
    return "{} B".format(int(n))


def sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def collect(src: Path):
    """列出 images/ 下的每个法典目录及其体积。"""
    groups = []
    for d in sorted(src.iterdir()):
        if not d.is_dir():
            continue
        files = [f for f in sorted(d.iterdir()) if f.is_file()]
        if not files:
            continue
        size = sum(f.stat().st_size for f in files)
        groups.append({"name": d.name, "dir": d, "files": files, "size": size})
    return groups


def bin_pack(groups, max_bytes: int):
    """贪心装箱：大的先放，装不下就开新箱。同一个法典不拆散。"""
    bins = []
    for g in sorted(groups, key=lambda x: -x["size"]):
        if g["size"] > max_bytes:
            bins.append({"items": [g], "size": g["size"], "oversize": True})
            continue
        for b in bins:
            if b.get("oversize"):
                continue
            if b["size"] + g["size"] <= max_bytes:
                b["items"].append(g)
                b["size"] += g["size"]
                break
        else:
            bins.append({"items": [g], "size": g["size"], "oversize": False})
    return bins


def write_part(dst: Path, group_items, quiet: bool = False):
    """ZIP_STORED：JPEG 已经压过，再 deflate 只浪费时间换 1% 体积。"""
    written = 0
    total = sum(len(g["files"]) for g in group_items)
    t0 = time.time()
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for g in group_items:
            for f in g["files"]:
                zf.write(f, arcname="images/{}/{}".format(g["name"], f.name))
                written += 1
                if not quiet and written % 5000 == 0:
                    print("      {}/{} files  ({:.0f}s)".format(
                        written, total, time.time() - t0), flush=True)
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description="把法典例图打包成分发用的大包")
    ap.add_argument("--src", required=True, help="例图目录（含 <codex>/ 子目录）")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--max-mb", type=int, default=400, help="单个包上限（默认 400 MB）")
    ap.add_argument("--prefix", default="m8tags-images", help="包名前缀")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    if not src.is_dir():
        print("找不到例图目录:", src)
        return 1
    out.mkdir(parents=True, exist_ok=True)

    groups = collect(src)
    total_files = sum(len(g["files"]) for g in groups)
    total_size = sum(g["size"] for g in groups)
    print("源目录 :", src)
    print("法典数 :{}，文件 {}，合计 {}".format(len(groups), total_files, human(total_size)))

    bins = bin_pack(groups, args.max_mb * 1024 * 1024)
    print("装箱   : {} 个包（上限 {} MB）".format(len(bins), args.max_mb))
    for i, b in enumerate(bins, 1):
        names = ", ".join(g["name"] for g in b["items"])
        flag = "  [超限，单独成包]" if b.get("oversize") else ""
        print("   part{:<2} {:>9}  {} 个文件  {}{}".format(
            i, human(b["size"]), sum(len(g["files"]) for g in b["items"]), names, flag))

    parts = []
    for i, b in enumerate(bins, 1):
        name = "{}-part{}.zip".format(args.prefix, i)
        dst = out / name
        print("\n[{}] 写入 {}".format(i, name), flush=True)
        n = write_part(dst, b["items"])
        size = dst.stat().st_size
        print("      完成 {} / {} 个文件，校验中…".format(human(size), n), flush=True)
        parts.append({
            "name": name,
            "bytes": size,
            "sha256": sha256_of(dst),
            "files": n,
            "codices": [g["name"] for g in b["items"]],
        })
        print("      sha256 {}".format(parts[-1]["sha256"][:16] + "…"))

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": src.name,
        "extractTo": "atlas/",
        "layout": "images/<codex>/<file>",
        "totalFiles": total_files,
        "totalBytes": total_size,
        "maxBytesPerPart": args.max_mb * 1024 * 1024,
        "codices": sorted(g["name"] for g in groups),
        "parts": parts,
    }
    (out / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    sums = out / "SHA256SUMS.txt"
    sums.write_text(
        "".join("{}  {}\n".format(p["sha256"], p["name"]) for p in parts), encoding="utf-8")

    print("\n总共 {} 个包，{} 个文件，{}".format(len(parts), total_files, human(total_size)))
    print("解压目标：<插件目录>/{}".format(manifest["extractTo"]))
    print("清单    ：{}".format(out / "MANIFEST.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
