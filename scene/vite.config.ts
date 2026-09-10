import { defineConfig } from 'vite';
import path from 'node:path';

// seasons/*.json лежит на уровень выше scene/ — разрешаем Vite отдавать его в dev-режиме
export default defineConfig({
  base: './',
  server: { fs: { allow: [path.resolve(__dirname, '..')] }, port: 5173 },
  build: {
    target: 'es2022', sourcemap: false,
    rolldownOptions: { input: { main: path.resolve(__dirname, 'index.html'), leaf: path.resolve(__dirname, 'leaf.html') } }
  }
});
