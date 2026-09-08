import { createScene } from './scene';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const devEl = document.getElementById('dev') as HTMLElement;

const app = createScene(canvas, devEl);
app.start();

// для отладки из консоли и автотестов
(window as unknown as { livingScene: typeof app }).livingScene = app;
