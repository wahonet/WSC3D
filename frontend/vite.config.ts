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
