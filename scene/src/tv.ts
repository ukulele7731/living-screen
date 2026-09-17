// Режим телевизора (server-spec.md, разделы 2–3, 6): та же сцена, но с сервером.
//   1. GET /api/tv/pairing: экран без комнаты — показываем код привязки (владелец вводит его
//      на телефоне) и кнопку «Создать новую комнату»; привязан — загружаем комнату.
//   2. Загрузка комнаты: все листья комнаты ложатся в ковёр (рисунки детей — из /files/...).
//   3. WebSocket: leaf.new — новый лист влетает главным; leaf.deleted / room.reset — убираем;
//      room.season — перезагрузка страницы (другой конфиг сезона).
//   4. В углу — код комнаты и QR на /r/<код>: гость сканирует и добавляет лист.
// Без сервера (GitHub Pages) fetch /api/tv/pairing не отвечает JSON — режим не включается,
// остаётся демо с кнопкой «Сфотографировать лист».
import QRCode from 'qrcode';
import type { LeafField } from './leaf-field';
import type { LeafBody } from './leaf-body';

interface LeafView { id: string; kind: string; name: string; tex_url: string; atlas_slot: number }
interface RoomInfo { code: string; season: string; leaves: LeafView[] }
type Pairing = { paired: true; room: string; season: string } | { paired: false; code: string; ttl_sec: number };

const api = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error(`не JSON: ${text.slice(0, 80)}`); }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
};

/** Есть ли сервер за этой страницей. */
export async function detectServer(): Promise<Pairing | null> {
  try {
    const res = await fetch('/api/tv/pairing', { credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return await res.json() as Pairing;
  } catch { return null; }
}

export class TvMode {
  private el: HTMLElement;
  private byId = new Map<string, LeafBody>();
  private ws: WebSocket | null = null;
  private wsDelay = 1000;
  private room: RoomInfo | null = null;

  constructor(private field: LeafField, first: Pairing) {
    this.el = document.createElement('div');
    this.el.id = 'tv';
    document.body.appendChild(this.el);
    if (first.paired) void this.enterRoom(first.room); else this.showPairing(first.code);
  }

  // ── экран без комнаты ──
  private showPairing(code: string) {
    this.el.innerHTML = `
      <div class="tv-card">
        <div class="tv-title">Живой листопад</div>
        <div class="tv-hint">Код привязки экрана — введите его на телефоне в кабинете</div>
        <div class="tv-code">${code.split('').join(' ')}</div>
        <div class="tv-hint">или</div>
        <button class="tv-btn" id="tv-create">Создать новую комнату</button>
        <div class="tv-err" id="tv-err" hidden></div>
      </div>`;
    this.el.querySelector<HTMLButtonElement>('#tv-create')!.addEventListener('click', () => void this.createRoom());
    // владелец ввёл код на телефоне — узнаём об этом опросом
    const poll = window.setInterval(async () => {
      const p = await detectServer();
      if (p && p.paired) { clearInterval(poll); void this.enterRoom(p.room); }
      else if (p && !p.paired && p.code !== code) { clearInterval(poll); this.showPairing(p.code); }   // код истёк — новый
    }, 5000);
  }

  private async createRoom() {
    const err = this.el.querySelector<HTMLElement>('#tv-err')!;
    try {
      const r = await api<{ code: string; password: string }>('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      // пароль показывается один раз — крупно
      this.el.innerHTML = `
        <div class="tv-card">
          <div class="tv-title">Комната создана</div>
          <div class="tv-hint">Код комнаты</div>
          <div class="tv-code">${r.code}</div>
          <div class="tv-hint">Пароль владельца — показывается один раз, запишите</div>
          <div class="tv-code tv-pass">${r.password}</div>
          <button class="tv-btn" id="tv-go">Открыть листопад</button>
        </div>`;
      this.el.querySelector<HTMLButtonElement>('#tv-go')!.addEventListener('click', () => void this.enterRoom(r.code));
    } catch (e) {
      err.hidden = false;
      err.textContent = (e as Error).message;
    }
  }

  // ── комната ──
  private async enterRoom(code: string) {
    this.room = await api<RoomInfo>(`/api/rooms/${code}`);
    const link = `${location.origin}/r/${code}`;
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 180, color: { dark: '#3a2410', light: '#fff8ea' } });
    this.el.innerHTML = `
      <div class="tv-corner">
        <img src="${qr}" alt="QR" width="120" height="120">
        <div>
          <div class="tv-corner-title">Добавь свой лист</div>
          <div class="tv-corner-hint">наведи камеру телефона на QR</div>
          <div class="tv-corner-code">${code}</div>
        </div>
      </div>`;
    for (const leaf of this.room.leaves) await this.placeSettled(leaf);
    this.connect(code);
  }

  private async loadTexture(leaf: LeafView): Promise<HTMLImageElement> {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error(`текстура ${leaf.id} не загрузилась`)); img.src = leaf.tex_url; });
    return img;
  }

  private async placeSettled(leaf: LeafView) {
    try {
      const img = await this.loadTexture(leaf);
      const variant = this.field.addLeafTexture(leaf.kind, img);
      const body = this.field.spawnSettled({ kind: leaf.kind, variant, dry: 0.2 });
      if (body) { body.leafId = leaf.id; this.byId.set(leaf.id, body); }
    } catch (e) { console.warn('[tv]', (e as Error).message); }
  }

  private async flyIn(leaf: LeafView) {
    try {
      const img = await this.loadTexture(leaf);
      const variant = this.field.addLeafTexture(leaf.kind, img);
      const body = this.field.spawn({ role: 'hero', kind: leaf.kind, variant, dry: 0.15 });
      if (body) { body.leafId = leaf.id; this.byId.set(leaf.id, body); }
    } catch (e) { console.warn('[tv]', (e as Error).message); }
  }

  private removeLeaf(id: string) {
    const body = this.byId.get(id);
    if (!body) return;
    this.byId.delete(id);
    this.field.removeLeaf(body);
  }

  private connect(code: string) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/rooms/${code}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.wsDelay = 1000; };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string; leaf?: LeafView; id?: string; season?: string };
      if (m.type === 'leaf.new' && m.leaf) void this.flyIn(m.leaf);
      else if (m.type === 'leaf.deleted' && m.id) this.removeLeaf(m.id);
      else if (m.type === 'room.reset') { for (const id of [...this.byId.keys()]) this.removeLeaf(id); }
      else if (m.type === 'room.season' && m.season && this.room && m.season !== this.room.season) location.reload();
    };
    ws.onclose = () => {
      // сеть моргнула или сервер перезапустился: переподключаемся и досинхронизируем список
      setTimeout(() => void this.resync(code), this.wsDelay);
      this.wsDelay = Math.min(this.wsDelay * 2, 30_000);
    };
  }

  private async resync(code: string) {
    try {
      const info = await api<RoomInfo>(`/api/rooms/${code}`);
      const live = new Set(info.leaves.map((l) => l.id));
      for (const id of [...this.byId.keys()]) if (!live.has(id)) this.removeLeaf(id);
      for (const leaf of info.leaves) if (!this.byId.has(leaf.id)) await this.flyIn(leaf);
      this.room = info;
    } catch { /* сервер ещё лежит — попробуем после следующего onclose */ }
    this.connect(code);
  }

  get leafCount(): number { return this.byId.size; }
  get socket(): WebSocket | null { return this.ws; }
}
