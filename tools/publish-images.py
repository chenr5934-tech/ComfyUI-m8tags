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
    """返回 {附件名: 字节数}。"""
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
            out[a["name"]] = a["size"]
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
            timeout=(30, 3600),
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
        "完整例图（{} 个文件，{}）。解压到插件目录的 `atlas/` 下即可。\n\n"
        "包内路径固定为 `images/<codex>/<file>`；每个包都可独立解压，互不依赖。\n"
        "校验用 `SHA256SUMS.txt`，明细见 `MANIFEST.json`。\n".format(
            manifest["totalFiles"], human(manifest["totalBytes"])),
    )
    release_id = release["id"]
    have = existing_assets(session, args.repo, release_id)
    if have:
        print("已有附件：{}".format(", ".join(sorted(have))))

    files = [out / p["name"] for p in parts] + [out / "SHA256SUMS.txt", manifest_path]
    uploaded = 0
    for path in files:
        if not path.is_file():
            raise SystemExit("缺文件：{}".format(path))
        size = path.stat().st_size
        if have.get(path.name) == size:
            print("   - {} 已存在且大小一致，跳过".format(path.name))
            continue
        if have.get(path.name) is not None:
            print("   ! {} 已存在但大小不同（{} vs {}），需要先在网页删掉再重跑".format(
                path.name, human(have[path.name]), human(size)))
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
