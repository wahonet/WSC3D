# 汉画像石数字化研究平台

这是 `E:\WSC3D` 工作区内的汉画像石数字化研究平台启动版。当前已建立 P0/P1 骨架：本地资源扫描、Markdown 结构化解析、Express API、React + Three.js 三维浏览界面。

## 启动

```bash
npm install
npm run dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:3100

## 常用命令

```bash
npm run scan
npm run typecheck
npm run build
```

## 项目结构

```text
frontend/          前端代码
backend/           后端 API、解析器、服务
data/              术语库与配置
docs/              技术方案与扫描报告
temp/              本地三维模型与缩略图
画像石结构化分档/   Markdown 结构化文档
参考图/             标注系统参考图
```

## 当前接口

- `GET /api/scan`
- `GET /api/stones`
- `GET /api/stones/:id/model`
- `GET /api/stones/:id/metadata`
- `GET /api/reference-images`
