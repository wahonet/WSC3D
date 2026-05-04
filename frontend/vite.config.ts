/**
 * Vite 前端构建配置
 *
 * dev 启动时通过 `concurrently` 与后端、AI 服务并排起来；端口分配：
 * - `:5173`  前端 dev server
 * - `:3100`  后端 Express
 * - `:8000`  AI FastAPI
 *
 * 前端代码里所有 fetch 都用相对路径（如 `/api/stones`），由本配置的 `proxy`
 * 字段在 dev 阶段把 `/api` `/assets` 透传到后端、`/ai` 透传到 AI 服务。生产
 * 部署时需要在反向代理（Nginx 等）做同样的路由。
 *
 * 构建产物落到仓库根目录的 `dist/frontend`，方便后端按需静态托管。
 */

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/assets": "http://127.0.0.1:3100",
      "/ai": "http://127.0.0.1:8000"
    }
  },
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true
  }
});
