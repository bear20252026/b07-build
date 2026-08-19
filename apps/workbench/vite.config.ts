import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 开发代理仅连接回环网关；生产桌面壳将以 C1/C3 adapter 替换，不向浏览器暴露 SQLite 或工具端口。 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4318',
        changeOrigin: false,
      },
    },
  },
});
