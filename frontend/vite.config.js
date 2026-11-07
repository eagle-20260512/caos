import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 双实例(2026-11-07 原生 WebUI):API 目标 env 可指,默认保 web 树 8321;
  // preview 段让 `vite preview` 也能反代(原生=build 产物 + preview:3001)
  server: { proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://localhost:8321' } },
  preview: { proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://localhost:8321' } },
  build: { outDir: 'dist' },
});
