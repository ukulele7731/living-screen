// Dev-панель (Shift+D): параметры ветра и физики в реальном времени, сила
// ветра (штиль / ветерок / буря), счётчики. «Сохранить» отправляет значения в
// dev-сервер Vite, который пишет их обратно в seasons/autumn.json.
import type { Season } from './config';

export interface DevPanelHooks {
  spawn(n: number): void;
  setStrength(k: number): void;
  stats(): { flying: number; ground: number; spawned: number; wind: string };
}

interface Field { path: (string | number)[]; label: string; min: number; max: number; step: number }

const FIELDS: Field[] = [
  { path: ['physics', 'pressure'], label: 'давление', min: 5, max: 200, step: 1 },
  { path: ['physics', 'leadShift'], label: 'центр давления', min: 0, max: 2, step: 0.05 },
  { path: ['physics', 'skin'], label: 'трение', min: 0, max: 20, step: 0.5 },
  { path: ['physics', 'angDampQuad'], label: 'демпф. вращ. кв.', min: 0, max: 2, step: 0.01 },
  { path: ['physics', 'angDampLin'], label: 'демпф. вращ. лин.', min: 0, max: 3, step: 0.05 },
  { path: ['physics', 'massOffset'], label: 'сдвиг центра масс', min: 0, max: 0.3, step: 0.01 },
  { path: ['physics', 'bendGain'], label: 'изгиб', min: 0, max: 0.2, step: 0.005 },
  { path: ['physics', 'liftSpeed'], label: 'взлёт с земли, м/с', min: 0.5, max: 8, step: 0.1 },
  { path: ['wind', 'base', 'speed', 0], label: 'фон мин, м/с', min: 0, max: 4, step: 0.1 },
  { path: ['wind', 'base', 'speed', 1], label: 'фон макс, м/с', min: 0, max: 6, step: 0.1 },
  { path: ['wind', 'gust', 'speed', 0], label: 'порыв мин, м/с', min: 0, max: 15, step: 0.1 },
  { path: ['wind', 'gust', 'speed', 1], label: 'порыв макс, м/с', min: 0, max: 20, step: 0.1 },
  { path: ['wind', 'gust', 'rise', 1], label: 'порыв вверх (доля)', min: 0, max: 1, step: 0.05 },
  { path: ['wind', 'gust', 'toCamera'], label: 'порывов к камере (доля)', min: 0, max: 1, step: 0.05 },
  { path: ['wind', 'gust', 'interval', 0], label: 'порыв интервал мин', min: 2, max: 60, step: 1 },
  { path: ['wind', 'gust', 'interval', 1], label: 'порыв интервал макс', min: 2, max: 90, step: 1 },
  { path: ['wind', 'turbulence', 'strength'], label: 'турбулентность', min: 0, max: 3, step: 0.05 },
  { path: ['wind', 'vortices', 'strength', 1], label: 'вихри макс', min: 0, max: 6, step: 0.1 },
  { path: ['wind', 'updraft'], label: 'восходящий поток', min: 0, max: 2, step: 0.05 },
  { path: ['field', 'autoSpawnPerSec'], label: 'листьев в секунду', min: 0, max: 5, step: 0.1 },
  { path: ['field', 'maxFlying'], label: 'летящих макс', min: 0, max: 300, step: 5 },
  { path: ['field', 'ambient', 'tint'], label: 'фоновые: яркость', min: 0.3, max: 1, step: 0.05 },
  { path: ['field', 'ambient', 'scale', 1], label: 'фоновые: размер макс', min: 0.3, max: 1.5, step: 0.05 },
  { path: ['field', 'ambient', 'nearFade'], label: 'фоновые: не ближе, м', min: 0, max: 6, step: 0.1 }
];

function get(obj: unknown, path: (string | number)[]): number {
  let o = obj as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  return o[path[path.length - 1]] as number;
}
function set(obj: unknown, path: (string | number)[], v: number) {
  let o = obj as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  o[path[path.length - 1]] = v;
}

export function makeDevPanel(season: Season, hooks: DevPanelHooks): { frame(): void } {
  const el = document.createElement('div');
  el.id = 'devpanel';
  el.hidden = true;
  el.innerHTML = `
    <style>
      #devpanel { position: fixed; right: 12px; top: 12px; width: 300px; max-height: calc(100vh - 24px); overflow: auto; z-index: 20;
        padding: 10px 12px; font: 12px/1.5 system-ui, sans-serif; color: #e8e4da; background: rgba(20,22,26,.8); border-radius: 8px; }
      #devpanel h3 { margin: 0 0 6px; font-size: 13px; }
      #devpanel label { display: grid; grid-template-columns: 120px 1fr 44px; gap: 6px; align-items: center; }
      #devpanel input[type=range] { width: 100%; }
      #devpanel .row { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
      #devpanel button { font: inherit; padding: 3px 8px; border-radius: 5px; border: 1px solid #666; background: #2a2d33; color: #eee; cursor: pointer; }
      #devpanel button.on { background: #6a5a2a; }
      #devpanel .stats { color: #b9b4a8; white-space: pre; }
    </style>
    <h3>Dev-панель <small>(Shift+D)</small></h3>
    <div class="row">
      <button data-str="0.15">штиль</button><button data-str="1" class="on">ветерок</button><button data-str="2.4">буря</button>
      <button id="dp-spawn">+10 главных листьев</button>
    </div>
    <div id="dp-fields"></div>
    <div class="row"><button id="dp-save">Сохранить в autumn.json</button><span id="dp-msg"></span></div>
    <div class="stats" id="dp-stats"></div>`;
  document.body.appendChild(el);

  const fields = el.querySelector('#dp-fields')!;
  for (const f of FIELDS) {
    const row = document.createElement('label');
    const v = get(season, f.path);
    row.innerHTML = `<span>${f.label}</span><input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}"><b>${v}</b>`;
    const input = row.querySelector('input')!, b = row.querySelector('b')!;
    input.addEventListener('input', () => { set(season, f.path, Number(input.value)); b.textContent = input.value; });
    fields.appendChild(row);
  }
  el.querySelectorAll<HTMLButtonElement>('button[data-str]').forEach((btn) => btn.addEventListener('click', () => {
    el.querySelectorAll('button[data-str]').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    hooks.setStrength(Number(btn.dataset.str));
  }));
  el.querySelector('#dp-spawn')!.addEventListener('click', () => hooks.spawn(10));
  const msg = el.querySelector('#dp-msg')!;
  el.querySelector('#dp-save')!.addEventListener('click', async () => {
    try {
      const res = await fetch('/__season', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(season) });
      msg.textContent = res.ok ? 'сохранено' : 'ошибка ' + res.status + ' (только в dev-режиме)';
    } catch (e) { msg.textContent = 'нет dev-сервера'; }
    setTimeout(() => { msg.textContent = ''; }, 3000);
  });
  window.addEventListener('keydown', (e) => {
    if (e.shiftKey && (e.key === 'D' || e.key === 'd' || e.key === 'В' || e.key === 'в')) el.hidden = !el.hidden;
  });
  const statsEl = el.querySelector('#dp-stats')!;
  let last = 0;
  return {
    frame() {
      if (el.hidden) return;
      const now = performance.now();
      if (now - last < 250) return;
      last = now;
      const s = hooks.stats();
      statsEl.textContent = `летит ${s.flying}   лежит ${s.ground}   всего ${s.spawned}\nветер ${s.wind}`;
    }
  };
}
