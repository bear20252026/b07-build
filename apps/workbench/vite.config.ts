import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 开发代理仅连接回环网关；生产桌面壳将以 C1/C3 adapter 替换，不向浏览器暴露 SQLite 或工具端口。 */
export default defineConfig({
  // 相对资源路径同时支持浏览器部署和 Tauri 本地资源协议；开发代理保持回环限定。
  base: './',
  plugins: [react()],
  server: {
    allowedHosts: ['5173-iz2xki9wsuy148l2hwr47-6b7bb924.us3.manus.computer'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4318',
        changeOrigin: false,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react-vendor';
          if (id.includes('/node_modules/@tauri-apps/')) return 'tauri-vendor';
          return undefined;
        },
      },
    },
  },
});
