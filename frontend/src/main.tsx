/**
 * 前端入口文件
 *
 * Vite 在 `frontend/index.html` 里把本文件作为唯一的脚本入口加载，挂载完成后
 * 由 `App` 组件接管全部 UI 与状态。`StrictMode` 仅在开发模式下生效，用于检测
 * useEffect / setState 的副作用与并发安全。
 */

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("无法找到根节点 #root，请检查 index.html");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
