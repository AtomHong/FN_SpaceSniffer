#!/usr/bin/env python3
"""飞牛系统清理 - 后端服务

文件浏览器 + 目录大小查询 + 磁盘列表。
零外部依赖，仅使用 Python 标准库。
"""

import json
import logging
import os
import signal
import subprocess
import sys
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("APP_PORT", 15853))
WWW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("sys_cleaner")


def _human_size(size_bytes: int) -> str:
    """将字节数转为可读字符串。"""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(size_bytes) < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


# ──────────────────────────── 目录大小 ────────────────────────────


def _get_dir_size_du(dir_path: str) -> int:
    """用 du 命令获取目录大小。"""
    try:
        result = subprocess.run(
            ["du", "-sb", "--one-file-system", dir_path],
            capture_output=True, text=True, timeout=3,
        )
        if result.returncode == 0:
            return int(result.stdout.split()[0])
    except (subprocess.TimeoutExpired, ValueError, OSError):
        pass
    return 0


# ──────────────────────────── 文件树 ──────────────────────────────


def _get_filetree(dir_path: str, page: int = 1, page_size: int = 0) -> dict:
    """列出目录下的子文件夹和文件，支持分页。"""
    if not os.path.isdir(dir_path):
        return {"error": "Path not found or not a directory", "items": [], "total": 0, "page": page, "page_size": page_size, "has_more": False}

    items = []
    try:
        for entry in os.scandir(dir_path):
            try:
                stat = entry.stat(follow_symlinks=False)
                is_dir = entry.is_dir(follow_symlinks=False)
                items.append({
                    "name": entry.name,
                    "path": entry.path,
                    "type": "dir" if is_dir else "file",
                    "size": 0 if is_dir else stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError) as e:
        return {"error": str(e), "items": items, "total": len(items), "page": page, "page_size": page_size, "has_more": False}

    items.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))

    total = len(items)
    if page_size > 0:
        start = (page - 1) * page_size
        page_items = items[start:start + page_size]
        has_more = start + page_size < total
    else:
        page_items = items
        has_more = False

    parent = os.path.dirname(dir_path.rstrip("/")) or "/"
    log.info("[trace] filetree %s => %d items, page=%d/%d returned=%d",
             dir_path, total, page, page_size, len(page_items))
    return {
        "path": dir_path,
        "parent": parent,
        "items": page_items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
    }


# ──────────────────────────── 磁盘列表 ────────────────────────────

_SKIP_FS_TYPES = {
    "tmpfs", "devtmpfs", "sysfs", "proc", "devpts",
    "cgroup", "cgroup2", "pstore", "securityfs", "debugfs",
    "tracefs", "hugetlbfs", "mqueue", "fusectl", "configfs",
    "overlay", "nsfs", "bpf", "fuse.gvfsd-fuse", "squashfs",
    "udf", "iso9660",
}


def _get_disks() -> list[dict]:
    """读取 /proc/mounts，返回所有有效数据盘。"""
    root_dev = os.stat("/").st_dev
    disks = []
    seen_devs = set()

    try:
        with open("/proc/mounts", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                device, mountpoint, fstype = parts[0], parts[1], parts[2]

                if fstype in _SKIP_FS_TYPES:
                    continue

                try:
                    if os.stat(mountpoint).st_dev == root_dev:
                        continue
                except (OSError, PermissionError):
                    continue

                if device in seen_devs:
                    continue
                seen_devs.add(device)

                try:
                    st = os.statvfs(mountpoint)
                    total = st.f_blocks * st.f_frsize
                    free = st.f_bavail * st.f_frsize
                    used = total - free
                except (OSError, ZeroDivisionError):
                    continue

                if total <= 0:
                    continue

                disks.append({
                    "device": device,
                    "mountpoint": mountpoint,
                    "fstype": fstype,
                    "total": total,
                    "total_human": _human_size(total),
                    "used": used,
                    "used_human": _human_size(used),
                    "free": free,
                    "free_human": _human_size(free),
                    "percent": round(used / total * 100, 1),
                })
    except (OSError, PermissionError) as e:
        log.error("Failed to read /proc/mounts: %s", e)

    disks.sort(key=lambda d: d["mountpoint"])
    return disks


# ──────────────────────────── HTTP 路由 ────────────────────────────


class AppHandler(SimpleHTTPRequestHandler):
    """API + 静态文件服务。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/filetree":
            self._handle_filetree(parsed.query)
        elif path == "/api/dirsize":
            self._handle_dirsize(parsed.query)
        elif path == "/api/disk":
            self._handle_disk()
        else:
            super().do_GET()

    def _handle_filetree(self, query: str):
        params = parse_qs(query)
        target = params.get("path", [None])[0]

        if not target or not target.startswith("/"):
            self._json_response(400, {"error": "Missing or invalid 'path' parameter"})
            return

        page = int(params.get("page", [1])[0])
        page_size = int(params.get("pageSize", [0])[0])

        result = _get_filetree(target, page=page, page_size=page_size)
        self._json_response(200, result)

    def _handle_dirsize(self, query: str):
        params = parse_qs(query)
        target = params.get("path", [None])[0]

        if not target or not target.startswith("/"):
            self._json_response(400, {"error": "Missing or invalid 'path' parameter"})
            return

        size = _get_dir_size_du(target)
        self._json_response(200, {
            "path": target,
            "parent": os.path.dirname(target.rstrip("/")) or "/",
            "size": size,
            "size_human": _human_size(size),
        })

    def _handle_disk(self):
        disks = _get_disks()
        self._json_response(200, {"disks": disks, "parent": "/"})

    def _json_response(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        log.info(fmt, *args)


# ──────────────────────────── 进程管理 ────────────────────────────

def handle_signal(signum, frame):
    log.info("Received signal %s, shutting down...", signum)
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    server = HTTPServer(("0.0.0.0", PORT), AppHandler)
    log.info("sys_cleaner server started on port %d", PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log.info("Server stopped")


if __name__ == "__main__":
    main()
