# FN_SpaceSniffer

飞牛 NAS 磁盘空间可视化分析工具，类似 PC 端 SpaceSniffer。
基于 D3.js Treemap 实现文件大小可视化，支持渐进式加载。

## 快速启动

```bash
python3 app/src/app.py
# 或通过 cmd/main 管理
cmd/main start
```

默认监听端口 `15853`，可通过环境变量 `APP_PORT` 覆盖。

## API 接口

### GET /api/disk

获取所有有效数据盘列表（排除根分区和虚拟文件系统）。

**响应：**

```json
{
  "disks": [
    {
      "device": "/dev/sda2",
      "mountpoint": "/vol1",
      "fstype": "ext4",
      "total": 1099511627776,
      "total_human": "1.0 TB",
      "used": 549755813888,
      "used_human": "500.0 GB",
      "free": 549755813888,
      "free_human": "500.0 GB",
      "percent": 50.0
    }
  ],
  "parent": "/"
}
```

### GET /api/filetree

分页获取目录下的文件和文件夹列表。

**参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `path` | string | 必填 | 目录路径 |
| `page` | int | 1 | 页码（1-based） |
| `pageSize` | int | 0 | 每页数量，0=不分页 |

**响应：**

```json
{
  "path": "/vol1/1000",
  "parent": "/vol1",
  "items": [
    {
      "name": "raw",
      "path": "/vol1/1000/raw",
      "type": "dir",
      "size": 0,
      "modified": "2026-09-24T10:00:00"
    }
  ],
  "total": 15,
  "page": 1,
  "page_size": 5,
  "has_more": true
}
```

### GET /api/dirsize

获取指定目录的总大小（通过 `du` 命令）。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 目录路径 |

**响应：**

```json
{
  "path": "/vol1/1000/raw",
  "parent": "/vol1/1000",
  "size": 760900000000,
  "size_human": "708.6 GB"
}
```

## 前端技术栈

- D3.js v7 — Treemap 布局算法
- 原生 HTML/CSS/JS — 无框架依赖
- 响应式布局，支持窗口缩放

## 前端加载流程

```
获取磁盘列表 → 选择磁盘 → 加载文件列表(分页)
  → page 1 返回 → 获取 page 1 目录大小 → 渲染
    → page 2 返回 → 获取 page 2 目录大小 → 渲染
      → ...直到 has_more=false
```

每页串行加载：先获取文件列表，再获取目录大小，最后渲染。
