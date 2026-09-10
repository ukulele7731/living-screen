import { createScene } from './scene';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const devEl = document.getElementById('dev') as HTMLElement;

createScene(canvas, devEl).then((app) => {
  app.start();
  // для отладки из консоли и автотестов
  (window as unknown as { livingScene: typeof app }).livingScene = app;
}).catch((e) => {
  devEl.hidden = false;
  devEl.textContent = 'Ошибка: ' + (e instanceof Error ? e.message : String(e));
  console.error(e);
});
