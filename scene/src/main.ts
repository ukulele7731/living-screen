import { createScene } from './scene';
import { makeCaptureUi } from './capture-ui';
import { detectServer, TvMode } from './tv';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const devEl = document.getElementById('dev') as HTMLElement;

createScene(canvas, devEl).then(async (app) => {
  app.start();
  // есть сервер (страница /tv на нашем домене) — режим телевизора; нет — демо с кнопкой съёмки
  const pairing = await detectServer();
  if (pairing) {
    const tv = new TvMode(app.field, pairing);
    (window as unknown as { livingTv: TvMode }).livingTv = tv;
  } else {
    makeCaptureUi(app.field);
  }
  // для отладки из консоли и автотестов
  (window as unknown as { livingScene: typeof app }).livingScene = app;
}).catch((e) => {
  devEl.hidden = false;
  devEl.textContent = 'Ошибка: ' + (e instanceof Error ? e.message : String(e));
  console.error(e);
});
