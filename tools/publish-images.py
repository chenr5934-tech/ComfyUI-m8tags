"""把打包好的例图包发布成 GitHub Release 附件。

用 Windows 凭据管理器里已存的 git 凭据（GCM）拿 token，不落盘、不打印。
先建 release，再逐个上传附件；已存在的同名附件会跳过，方便断点续传式重跑。

用法：
    python tools/publish-images.py --dir "D:/dist" --tag images-v1

需要 token 有 repo scope。缺失时会明确报出来，不会静默失败。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

API = "https://api.github.com"
UPLOAD = "https://uploads.github.com"


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return "{:.1f} {}".format(n, unit) if unit != "B" else "{} B".format(int(n))
        n /= 1024
    return "{} B".format(int(n))


def git_token(host: str = "github.com") -> str:
    """从 GCM 取已有凭据。只读，不写配置文件。"""
    proc = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost={}\n\n".format(host),
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise SystemExit("git credential fill 失败：{}".format(proc.stderr.strip()))
    for line in proc.stdout.splitlines():
        if line.startswith("password="):
            return line[len("password="):].strip()
    raise SystemExit("凭据里没有 password 字段 —— 先在命令行 git push 一次让它记住")


def api_headers(token: str) -> dict:
    return {
        "Authorization": "Bearer {}".format(token),
        "Accept": "application/vnd.github+json",
        "User-Agent": "m8tags-publish",
    }


def sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def ensure_release(session, repo: str, tag: str, name: str, body: str) -> dict:
    r = session.get("{}/repos/{}/releases/tags/{}".format(API, repo, tag), timeout=30)
    if r.status_code == 200:
        print("Release 已存在：{}".format(r.json()["html_url"]))
        return r.json()
    if r.status_code != 404:
        raise SystemExit("查询 release 失败 HTTP {}: {}".format(r.status_code, r.text[:300]))

    payload = {"tag_name": tag, "name": name, "body": body, "draft": False, "prerelease": False}
    r = session.post("{}/repos/{}/releases".format(API, repo), json=payload, timeout=60)
    if r.status_code not in (200, 201):
        raise SystemExit("创建 release 失败 HTTP {}: {}".format(r.status_code, r.text[:400]))
    print("已创建 Release：{}".format(r.json()["html_url"]))
    return r.json()


def existing_assets(session, repo: str, release_id: int) -> dict:
    """返回 {附件名: {"id": 附件 id, "size": 字节数}}。id 留着删旧附件用。"""
    out = {}
    page = 1
    while True:
        r = session.get(
            "{}/repos/{}/releases/{}/assets?per_page=100&page={}".format(API, repo, release_id, page),
            timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        for a in batch:
            out[a["name"]] = {"id": a["id"], "size": a["size"]}
        page += 1
    return out


def upload_asset(session, repo: str, release_id: int, path: Path) -> None:
    """流式上传，避免把整个包读进内存。"""
    url = "{}/repos/{}/releases/{}/assets?name={}".format(UPLOAD, repo, release_id, path.name)
    size = path.stat().st_size
    t0 = time.time()
    with path.open("rb") as fh:
        r = session.post(
            url,
            data=fh,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(size),
            },
            # 读超时别设太长：连接僵死时要能自己断掉重来，而不是挂一小时。
            timeout=(30, 900),
        )
    if r.status_code not in (200, 201):
        raise SystemExit("上传 {} 失败 HTTP {}: {}".format(path.name, r.status_code, r.text[:400]))
    dt = time.time() - t0
    speed = size / dt if dt > 0 else 0
    print("   ✓ {}  {}  {:.1f}s  ({}/s)".format(path.name, human(size), dt, human(speed)))


def main() -> int:
    ap = argparse.ArgumentParser(description="发布例图包到 GitHub Release")
    ap.add_argument("--dir", required=True, help="打包输出目录（含 MANIFEST.json）")
    ap.add_argument("--repo", default="chenr5934-tech/ComfyUI-m8tags")
    ap.add_argument("--tag", default="images-v1")
    ap.add_argument("--title", default=None)
    ap.add_argument("--skip-sha", action="store_true", help="跳过上传前的 sha256 复核")
    ap.add_argument("--replace", action="store_true",
                    help="上传前删掉 Release 上不在本次清单里的旧附件（换打包格式时用）")
    args = ap.parse_args()

    out = Path(args.dir).resolve()
    manifest_path = out / "MANIFEST.json"
    if not manifest_path.is_file():
        raise SystemExit("找不到 {}，先跑 tools/pack-images.py".format(manifest_path))

    manifest = json.loads(manifest_path.read_text("utf-8"))
    parts = manifest["parts"]
    print("清单：{} 个包，{} 个文件，{}".format(
        len(parts), manifest["totalFiles"], human(manifest["totalBytes"])))

    token = git_token()
    print("token：{}...（来自 git 凭据管理器）".format(token[:4]))
    session = requests.Session()
    session.headers.update(api_headers(token))

    me = session.get("{}/user".format(API), timeout=30)
    if me.status_code != 200:
        raise SystemExit("token 无效 HTTP {}: {}".format(me.status_code, me.text[:200]))
    scopes = me.headers.get("X-OAuth-Scopes", "")
    print("身份：{}  scopes: {}".format(me.json()["login"], scopes or "(none)"))
    if "repo" not in scopes:
        raise SystemExit("token 缺 repo scope，建 release 会被拒")

    release = ensure_release(
        session, args.repo, args.tag,
        args.title or "法典例图包 {}".format(args.tag),
        "完整例图，{} 个文件 / {}，打成了 **7z 分卷**。\n\n"
        "**必须把 {} 个卷全部下到同一个目录再解压** —— 缺任何一个卷都打不开。\n\n"
        "1. 下齐 `{}` … `{}`，连同 `SHA256SUMS.txt`\n"
        "2. 用 7-Zip 右键**第一个卷**（`{}`）→ 解压到插件的 `atlas/` 目录下\n"
        "3. 包内路径是 `images/<codex>/<file>`，解压完自然就是 `atlas/images/...`，不用再挪\n\n"
        "Windows 资源管理器自带的「全部解压」**不认分卷**，得用 7-Zip 或 WinRAR。\n"
        "校验用 `SHA256SUMS.txt`，明细见 `MANIFEST.json`。\n".format(
            manifest["totalFiles"], human(manifest["totalBytes"]),
            len(parts), parts[0]["name"], parts[-1]["name"], parts[0]["name"]),
    )
    release_id = release["id"]
    have = existing_assets(session, args.repo, release_id)
    if have:
        print("已有附件：{}".format(", ".join(sorted(have))))

    files = [out / p["name"] for p in parts] + [out / "SHA256SUMS.txt", manifest_path]
    for f in files:
        if not f.is_file():
            raise SystemExit("缺文件：{}".format(f))
    want = {f.name: f.stat().st_size for f in files}

    # --replace：把 Release 上对不上的旧附件清掉。两种情况都要管：
    #   1) 名字不在本次清单里的 —— 比如换了打包格式，旧的独立 zip 还挂着；
    #   2) 同名但内容变了的 —— MANIFEST.json / SHA256SUMS.txt 每次打包都会变。
    # 只按名字判断会漏掉第 2 种，结果清单永远停在上一版。
    if args.replace:
        for name in sorted(have):
            if want.get(name) == have[name]["size"]:
                continue
            # 删除附件的端点不带 release id —— 带 release_id 的那种只用于「列出附件」，
            # 拿来删会一直 404。（这个坑先前让 --replace 静默失灵了两轮。）
            r = session.delete("{}/repos/{}/releases/assets/{}".format(
                API, args.repo, have[name]["id"]), timeout=60)
            if r.status_code == 204:
                print("   x 已删除旧附件 {}".format(name))
                have.pop(name, None)
            else:
                print("   ! 删除 {} 失败 HTTP {}".format(name, r.status_code))

    uploaded = 0
    for path in files:
        if not path.is_file():
            raise SystemExit("缺文件：{}".format(path))
        size = path.stat().st_size
        if (have.get(path.name) or {}).get("size") == size:
            print("   - {} 已存在且大小一致，跳过".format(path.name))
            continue
        if path.name in have:
            print("   ! {} 已存在但大小不同（{} vs {}），跳过；加 --replace 可自动替换".format(
                path.name, human(have[path.name]["size"]), human(size)))
            continue
        if not args.skip_sha:
            want = next((p["sha256"] for p in parts if p["name"] == path.name), None)
            if want:
                got = sha256_of(path)
                if got != want:
                    raise SystemExit("{} 校验不符，重新打包".format(path.name))
        upload_asset(session, args.repo, release_id, path)
        uploaded += 1

    print("\n完成：新上传 {} 个，跳过 {} 个".format(uploaded, len(files) - uploaded))
    print("下载页：{}".format(release["html_url"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
