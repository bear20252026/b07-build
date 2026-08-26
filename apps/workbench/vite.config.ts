import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对资源路径同时支持浏览器部署和 Tauri 本地资源协议；Provider 直连由原生客户端负责。
  base: './',
  plugins: [react()],
  server: {
    allowedHosts: ['5173-iz2xki9wsuy148l2hwr47-6b7bb924.us3.manus.computer'],
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
