import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { formatSeason } from './season-format.mjs';

// Dev-панель сцены (Shift+D) шлёт POST /__season — пишем параметры обратно в seasons/autumn.json.
// Только в dev-режиме; в сборке эндпоинта нет.
function seasonWriter(): Plugin {
  return {
    name: 'season-writer',
    configureServer(server) {
      server.middlewares.use('/__season', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const file = path.resolve(__dirname, '..', 'seasons', 'autumn.json');
            fs.writeFileSync(file, formatSeason(data));
            res.setHeader('content-type', 'application/json');
            res.end('{"ok":true}');
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    }
  };
}

// vendor/paper-aquarium/capture.js лежит вне scene/ и не копируется в наш код: в dev отдаём
// файл как есть по /vendor/capture.js, в сборке кладём его и LICENSE автора в dist/vendor/.
function vendorCapture(): Plugin {
  const src = path.resolve(__dirname, '..', 'vendor', 'paper-aquarium');
  return {
    name: 'vendor-capture',
    configureServer(server) {
      server.middlewares.use('/vendor/capture.js', (_req, res) => {
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(path.join(src, 'capture.js')));
      });
    },
    writeBundle(options) {
      const out = path.join(options.dir ?? path.resolve(__dirname, 'dist'), 'vendor');
      fs.mkdirSync(out, { recursive: true });
      for (const f of ['capture.js', 'LICENSE']) fs.copyFileSync(path.join(src, f), path.join(out, f));
    }
  };
}

// seasons/*.json лежит на уровень выше scene/ — разрешаем Vite отдавать его в dev-режиме
export default defineConfig({
  base: './',
  plugins: [seasonWriter(), vendorCapture()],
  server: { fs: { allow: [path.resolve(__dirname, '..')] }, port: 5173 },
  build: {
    target: 'es2022', sourcemap: false,
    rolldownOptions: { input: { main: path.resolve(__dirname, 'index.html'), leaf: path.resolve(__dirname, 'leaf.html') } }
  }
});
