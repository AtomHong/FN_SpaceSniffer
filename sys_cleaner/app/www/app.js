// ─── 状态 ───────────────────────────────────────────────

let currentPath = "/";
let pathStack = [];
let currentItems = [];
let _loadEpoch = 0; // 每次 loadDir 递增，异步回调检查是否过期

// ─── 颜色映射 (SpaceSniffer 风格) ──────────────────────────

// SpaceSniffer: 几乎所有文件都是蓝色系，只有压缩包/资源文件用橙色
const TYPE_COLORS = {
  dir:           "#6B9FD4",
  executable:    "#6B9FD4",
  document:      "#6B9FD4",
  media:         "#6B9FD4",
  archive:       "#D4875B",
  image:         "#6B9FD4",
  web:           "#6B9FD4",
  config:        "#6B9FD4",
  log:           "#6B9FD4",
  database:      "#6B9FD4",
  temp:          "#D4875B",
  default:       "#6B9FD4",
};

function getFileType(name, isDir) {
  if (isDir) return "dir";
  const lower = name.toLowerCase();
  // 可执行文件
  if (/\.(exe|dll|so|bin|msi|app|deb|rpm|apk|dmg)$/.test(lower)) return "executable";
  // 文档
  if (/\.(txt|doc|docx|pdf|xls|xlsx|ppt|pptx|csv|rtf|odt|ods|md|epub|mobi)$/.test(lower)) return "document";
  // 图片
  if (/\.(jpg|jpeg|png|gif|bmp|ico|svg|webp|tiff|tif|psd|raw|cr2|nef)$/.test(lower)) return "image";
  // 音视频
  if (/\.(mp3|wav|flac|aac|ogg|wma|m4a|mp4|avi|mkv|mov|wmv|flv|webm|m4v|ts|rmvb|3gp)$/.test(lower)) return "media";
  // 压缩包
  if (/\.(zip|rar|7z|tar|gz|bz2|xz|zst|lz4|cab|iso|img)$/.test(lower)) return "archive";
  // 网页
  if (/\.(html|htm|css|js|ts|jsx|tsx|vue|php|asp|jsp)$/.test(lower)) return "web";
  // 配置/数据
  if (/\.(json|xml|yaml|yml|toml|ini|conf|cfg|properties|env|sql|db|sqlite|sqlite3)$/.test(lower)) return "config";
  // 日志
  if (/\.log(\.\d+)?(\.(gz|xz|bz2|old))?$/.test(lower) || /\.log\./.test(lower)) return "log";
  // 临时文件
  if (/\.tmp$|\.temp$|\.bak$|~$|\/tmp\//.test(lower)) return "temp";
  return "default";
}

function getColor(item) {
  const type = getFileType(item.name, item.type === "dir");
  return TYPE_COLORS[type] || TYPE_COLORS.default;
}

// ─── 初始化 ─────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadDisks();
  window.addEventListener("resize", debounce(() => renderCurrent(), 200));
});

// ─── API ─────────────────────────────────────────────────

const PAGE_SIZE = 5;

async function fetchFiletreePage(path, page) {
  const res = await fetch(`/api/filetree?path=${encodeURIComponent(path)}&page=${page}&pageSize=${PAGE_SIZE}`);
  return res.json();
}

async function fetchDirSize(path) {
  const res = await fetch(`/api/dirsize?path=${encodeURIComponent(path)}`);
  return res.json();
}

async function fetchDisks() {
  const res = await fetch("/api/disk");
  return res.json();
}

let _disks = [];

async function loadDisks() {
  try {
    const data = await fetchDisks();
    _disks = data.disks || [];
    const select = document.getElementById("root-select");
    select.innerHTML = "";
    for (const disk of _disks) {
      const opt = document.createElement("option");
      opt.value = disk.mountpoint;
      opt.textContent = `${disk.mountpoint} (${disk.used_human} / ${disk.total_human})`;
      select.appendChild(opt);
    }
    if (_disks.length > 0) {
      jumpToRoot(_disks[0].mountpoint);
    } else {
      loadDir("/");
    }
  } catch {
    loadDir("/");
  }
}

let _dirSizeAbort = null;

function showProgress(active) {
  const bar = document.getElementById("progress-bar");
  if (active) {
    bar.classList.add("active");
    bar.classList.remove("complete");
  } else {
    bar.classList.add("complete");
    setTimeout(() => bar.classList.remove("active", "complete"), 300);
  }
}

function setProgress(pct) {
  document.getElementById("progress-fill").style.width = pct + "%";
}

async function loadDirSizes(items) {
  if (_dirSizeAbort) _dirSizeAbort.abort();
  _dirSizeAbort = new AbortController();

  const dirs = items.filter((i) => i.type === "dir");
  if (dirs.length === 0) return;

  setProgress(0);
  const total = dirs.length;
  let loaded = 0;

  const promises = dirs.map((d) =>
    fetchDirSize(d.path).then((data) => {
      if (data.size !== undefined) {
        d.size = data.size;
        d.size_human = data.size_human;
      }
      loaded++;
      setProgress(Math.round((loaded / total) * 100));
    }).catch(() => {
      loaded++;
      setProgress(Math.round((loaded / total) * 100));
    })
  );

  await Promise.allSettled(promises);
  renderCurrent();
}

// ─── 导航（分页加载） ──────────────────────────────────

let _loadAbort = null;

async function loadDir(path) {
  // 取消之前的加载，递增 epoch 使旧回调失效
  if (_loadAbort) _loadAbort.abort();
  _loadAbort = new AbortController();
  const epoch = ++_loadEpoch;

  showProgress(true);
  setProgress(0);

  try {
    currentPath = path;
    currentItems = [];
    updateBreadcrumb();
    updateInfoBar();
    renderCurrent();

    let page = 0;
    let hasMore = true;
    let totalDirs = 0;
    let loadedDirs = 0;

    // 串行：请求页面 → 请求该页文件大小 → 渲染 → 下一页
    while (true) {
      page++;
      const data = await fetchFiletreePage(path, page);
      if (epoch !== _loadEpoch) return;
      if (data.error) break;

      const newItems = data.items || [];
      currentItems = currentItems.concat(newItems);
      totalDirs += newItems.filter((i) => i.type === "dir").length;
      hasMore = data.has_more;

      updateInfoBar();

      // 等待该页所有 dir size 完成
      const newDirs = newItems.filter((i) => i.type === "dir");
      await Promise.allSettled(newDirs.map((d) =>
        fetchDirSize(d.path).then((data) => {
          if (epoch !== _loadEpoch) return; // 已切换目录，丢弃
          if (data.size !== undefined) {
            d.size = data.size;
            d.size_human = data.size_human;
          }
          loadedDirs++;
          setProgress(Math.round((loadedDirs / Math.max(totalDirs, 1)) * 100));
        }).catch(() => {
          if (epoch !== _loadEpoch) return;
          loadedDirs++;
          setProgress(Math.round((loadedDirs / Math.max(totalDirs, 1)) * 100));
        })
      ));

      // 渲染（此时该页文件大小已全部获取）
      renderCurrent();

      if (!hasMore) break;
    }

    showProgress(false);
  } catch {
    showToast("加载失败", "error");
    showProgress(false);
  }
}

function navigateTo(path) {
  pathStack.push(currentPath);
  loadDir(path);
}

function goBack() {
  if (pathStack.length === 0) return;
  const prev = pathStack.pop();
  loadDir(prev);
}

function jumpToRoot(path) {
  pathStack = [];
  loadDir(path);
}

// ─── D3 Treemap 渲染 ────────────────────────────────────

function renderCurrent() {
  const container = document.getElementById("treemap");
  if (!container) return;

  requestAnimationFrame(() => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || (window.innerHeight - 80);

    if (w < 10 || h < 10) {
      setTimeout(() => renderCurrent(), 100);
      return;
    }

    if (currentItems.length === 0) {
      container.innerHTML = '<div class="empty-hint">此目录为空</div>';
      return;
    }

    // 构建 D3 层级数据
    const root = d3.hierarchy({ name: currentPath, children: currentItems })
      .sum((d) => Math.max(d.size || 0, 1));

    // 创建 treemap 布局
    const treemap = d3.treemap()
      .tile(d3.treemapBinary)
      .size([w, h])
      .paddingInner(2)
      .round(true);

    treemap(root);

    // 渲染矩形
    container.innerHTML = "";
    container.style.position = "relative";

    for (const node of root.leaves()) {
      const d = node.data;
      const x0 = node.x0;
      const y0 = node.y0;
      const x1 = node.x1;
      const y1 = node.y1;
      const cellW = x1 - x0;
      const cellH = y1 - y0;

      if (cellW < 1 || cellH < 1) continue;

      const el = document.createElement("div");
      el.className = "tm-cell";
      el.style.cssText = `
        position: absolute;
        left: ${x0}px;
        top: ${y0}px;
        width: ${cellW}px;
        height: ${cellH}px;
        background: ${getColor(d)};
        border: 1px solid rgba(0,0,0,0.3);
        box-sizing: border-box;
        overflow: hidden;
        cursor: pointer;
        transition: filter 0.15s;
      `;

      el.dataset.path = d.path;
      el.dataset.name = d.name;
      el.dataset.size = d.size;
      el.dataset.type = d.type;

      // 标签
      if (cellW > 40 && cellH > 20) {
        const label = document.createElement("div");
        label.className = "tm-label";
        const fontSize = Math.min(12, Math.max(9, Math.min(cellW / 8, cellH / 3)));
        label.style.cssText = `
          padding: 3px 5px;
          font-size: ${fontSize}px;
          color: #fff;
          line-height: 1.2;
          word-break: break-all;
          text-shadow: 0 1px 2px rgba(0,0,0,0.5);
          pointer-events: none;
        `;
        label.textContent = d.name;
        el.appendChild(label);
      }

      // 大小标签
      if (cellW > 60 && cellH > 35) {
        const sizeLabel = document.createElement("div");
        sizeLabel.className = "tm-size";
        const fontSize = Math.min(11, Math.max(8, Math.min(cellW / 10, cellH / 4)));
        sizeLabel.style.cssText = `
          padding: 0 5px;
          font-size: ${fontSize}px;
          color: rgba(255,255,255,0.8);
          pointer-events: none;
        `;
        sizeLabel.textContent = d.size_human || humanSize(d.size);
        el.appendChild(sizeLabel);
      }

      if (d.type === "dir") {
        el.addEventListener("click", () => navigateTo(d.path));
        el.style.cursor = "pointer";
      }

      el.addEventListener("mouseenter", () => showTooltip(d, el));
      el.addEventListener("mouseleave", hideTooltip);

      container.appendChild(el);
    }

    document.getElementById("btn-back").disabled = pathStack.length === 0;
  });
}

// ─── 面包屑 ─────────────────────────────────────────────

function updateBreadcrumb() {
  const bc = document.getElementById("breadcrumb");
  const parts = currentPath.split("/").filter(Boolean);
  let html = `<span class="bc-item bc-root" onclick="jumpToRoot('/')">/</span>`;
  let cumPath = "";
  for (const part of parts) {
    cumPath += "/" + part;
    const p = cumPath;
    html += `<span class="bc-sep">/</span><span class="bc-item" onclick="jumpToRoot('${escapeJs(p)}')">${escapeHtml(part)}</span>`;
  }
  bc.innerHTML = html;
  document.getElementById("current-path").textContent = currentPath;
}

function updateInfoBar() {
  const dirs = currentItems.filter((i) => i.type === "dir").length;
  const files = currentItems.length - dirs;
  const totalSize = currentItems.reduce((s, i) => s + i.size, 0);
  document.getElementById("item-count").textContent = `${dirs} 个文件夹, ${files} 个文件`;
  document.getElementById("total-size").textContent = `共 ${humanSize(totalSize)}`;
}

// ─── Tooltip ─────────────────────────────────────────────

function showTooltip(node, el) {
  const tip = document.getElementById("tooltip");
  tip.innerHTML = `
    <div class="tip-name">${escapeHtml(node.name)}</div>
    <div class="tip-path">${escapeHtml(node.path)}</div>
    <div class="tip-size">${node.size_human || humanSize(node.size)}</div>
    <div class="tip-type">${node.type === "dir" ? "文件夹" : "文件"}${node.type !== "dir" ? " · " + (node.modified || "") : ""}</div>
  `;
  tip.style.display = "block";
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.bottom + 4;
  if (x + 250 > window.innerWidth) x = window.innerWidth - 260;
  if (y + 100 > window.innerHeight) y = r.top - 100;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

function hideTooltip() {
  document.getElementById("tooltip").style.display = "none";
}

// ─── 工具 ───────────────────────────────────────────────

function getParentPath(path) {
  const parts = path.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function humanSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeJs(str) {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function showToast(msg, type) {
  const toast = document.createElement("div");
  toast.className = "toast " + (type || "");
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
