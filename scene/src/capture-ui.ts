// Демо без сервера: кнопка «Сфотографировать лист» → фото раскраски → capture.js прямо в
// браузере → рисунок ребёнка в атлас вида → главный лист влетает в сцену. Тот же путь потом
// повторит загрузчик на телефоне (этап 3), только текстура поедет на сервер и на телевизор.
import manifest from '../../assets/coloring/manifest.json';
import type { LeafField } from './leaf-field';

declare global {
  interface Window {
    FishCapture?: { processPhoto(source: CanvasImageSource, manifest: unknown): Promise<{ kind: string; title: string; texture: string; preview: string }> };
  }
}

const TITLES: Record<string, string> = {};
for (const f of manifest.fish as { name: string; title: string }[]) TITLES[f.name] = f.title;

export function makeCaptureUi(field: LeafField): void {
  const wrap = document.createElement('div');
  wrap.id = 'capture';
  wrap.innerHTML = `
    <label id="cap-btn" title="Сфотографируйте раскрашенный лист целиком, с четырьмя чёрными метками по углам">
      <span>📷</span> Сфотографировать лист
      <input type="file" accept="image/*" capture="environment" hidden>
    </label>
    <div id="cap-msg" hidden></div>
    <img id="cap-preview" alt="" hidden>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector('input')!;
  const btn = wrap.querySelector<HTMLElement>('#cap-btn')!;
  const msg = wrap.querySelector<HTMLElement>('#cap-msg')!;
  const preview = wrap.querySelector<HTMLImageElement>('#cap-preview')!;
  let hideTimer = 0;

  const say = (text: string, kind: 'ok' | 'err' | 'busy', ms = 6000) => {
    msg.textContent = text;
    msg.dataset.kind = kind;
    msg.hidden = false;
    clearTimeout(hideTimer);
    if (kind !== 'busy') hideTimer = window.setTimeout(() => { msg.hidden = true; preview.hidden = true; }, ms);
  };

  const handle = async (file: File) => {
    if (!window.FishCapture) { say('Распознавание не загрузилось: обновите страницу', 'err'); return; }
    btn.classList.add('busy');
    say('Ищу метки и вырезаю лист…', 'busy');
    try {
      // с телефона фото приходит с поворотом в EXIF — createImageBitmap выправляет
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const res = await window.FishCapture.processPhoto(bitmap, manifest);
      bitmap.close();
      const img = new Image();
      await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('текстура не прочиталась')); img.src = res.texture; });
      const variant = field.addLeafTexture(res.kind, img);
      const body = field.spawn({ role: 'hero', kind: res.kind, variant, dry: 0.15 });
      if (!body) throw new Error('в сцене нет места для листа');
      preview.src = res.preview;
      preview.hidden = false;
      say(`${TITLES[res.kind] ?? res.kind}: лист в листопаде!`, 'ok');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      say(`Не получилось: ${m}. Снимите лист целиком, ровно, при хорошем свете, без бликов — все четыре метки должны быть видны.`, 'err', 9000);
    } finally {
      btn.classList.remove('busy');
      input.value = '';
    }
  };

  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) void handle(f); });
  // на компьютере — просто перетащить фото на страницу
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('image/')) void handle(f);
  });
}
