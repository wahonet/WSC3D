# 汉画像石数字化研究平台 (WSC3D)

面向汉画像石数字化研究的本地化工作台，提供画像石三维浏览、多石块拼接和结构化档案查阅。

## 技术栈

- 前端：React 19 + Vite + Three.js
- 后端：Node.js + Express + TypeScript
- 资源：本地 GLB 模型、缩略图与 Markdown 结构化档案

## 快速开始

```bash
npm install
npm run dev
```

启动后访问：

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:3100

## 常用命令

```bash
npm run scan        # 扫描本地资源、生成缓存
npm run typecheck   # TypeScript 类型检查
npm run build       # 构建前后端产物
```

## 目录结构

```text
frontend/   前端代码（React + Three.js）
backend/    后端 API、解析器、服务
data/       术语库与配置
docs/       技术方案与扫描报告
```

## 主要接口

- `GET /api/scan`
- `GET /api/stones`
- `GET /api/stones/:id/model`
- `GET /api/stones/:id/metadata`
- `GET /api/reference-images`

## 模块概览

- **浏览**：单块画像石三维 / 二维查看，支持视角与背景切换。
- **拼接**：多块画像石的位置、角度、缩放微调，支持贴地、复位、保存方案。
- **标注**：结构化标注与术语对接（开发中）。
