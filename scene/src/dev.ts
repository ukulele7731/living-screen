// Dev-оверлей: fps, время кадра, draw calls, треугольники. Клавиша H прячет/показывает.
import * as THREE from 'three';

export interface DevOverlay {
  frame(renderer: THREE.WebGLRenderer, dtMs: number): void;
}

export function makeDevOverlay(el: HTMLElement): DevOverlay {
  let fps = 0, ms = 0, acc = 0, frames = 0, last = performance.now();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H' || e.key === 'р' || e.key === 'Р') el.hidden = !el.hidden;
  });
  return {
    frame(renderer, dtMs) {
      acc += dtMs; frames++;
      const now = performance.now();
      if (now - last >= 500) {
        fps = frames * 1000 / (now - last);
        ms = acc / frames;
        acc = 0; frames = 0; last = now;
        if (!el.hidden) {
          const r = renderer.info.render;
          const size = renderer.getSize(new THREE.Vector2());
          el.textContent =
            `${fps.toFixed(0)} fps   кадр ${(1000 / Math.max(fps, 0.01)).toFixed(1)} мс   JS ${ms.toFixed(1)} мс\n` +
            `draw calls ${r.calls}   triangles ${r.triangles.toLocaleString('ru')}\n` +
            `${size.x}×${size.y} @${renderer.getPixelRatio().toFixed(2)}   [H] скрыть`;
        }
      }
    }
  };
}
