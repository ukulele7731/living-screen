// Задник: нарисованная картина парка (scene/public/backdrop.jpg) и маска неба
// для живых облаков. Картина не проходит через освещение и тонмаппинг —
// она уже готовая; 3D-слой (ветки, листья, тени) накладывается поверх.
import * as THREE from 'three';
import type { Season } from './config';
import { makeCanvas, smoothstep } from './util';

export interface Backdrop {
  texture: THREE.Texture;      // сама картина, sRGB как есть (без декодирования в linear)
  skyMask: THREE.Texture;      // где на картине небо: 1 — небо, 0 — всё остальное
  aspect: number;              // ширина / высота картинки
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('не загрузился задник ' + url));
    img.src = url;
  });
}

// Маска неба: голубые и белые пиксели внутри окна skyRegion, размытые и с
// мягким спадом к краям окна. Считается один раз на уменьшенной копии.
function buildSkyMask(img: HTMLImageElement, region: Season['backdrop']['skyRegion']): THREE.Texture {
  const W = 512, H = Math.round(512 * img.naturalHeight / img.naturalWidth);
  const [, ctx] = makeCanvas(W, H);
  ctx.drawImage(img, 0, 0, W, H);
  const src = ctx.getImageData(0, 0, W, H).data;
  let mask = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H;
      const inRegion = u > region.x0 && u < region.x1 && v > region.y0 && v < region.y1;
      if (!inRegion) continue;
      const o = (y * W + x) * 4, r = src[o], g = src[o + 1], b = src[o + 2];
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      const blue = b > r + 12 && b >= g && lum > 90;                        // голубое небо
      const white = Math.min(r, g, b) > 190 && Math.max(r, g, b) - Math.min(r, g, b) < 45; // облака
      if (!blue && !white) continue;
      // мягкий спад к краям окна
      const fx = smoothstep(region.x0, region.x0 + 0.06, u) * smoothstep(region.x1, region.x1 - 0.06, u);
      const fy = smoothstep(region.y1, region.y1 - 0.10, v);
      mask[y * W + x] = fx * fy;
    }
  }
  // сжимаем (эрозия) — чтобы облака не лезли на кромку листвы, потом размываем
  const blur = (src: Float32Array, radius: number, erode: boolean) => {
    const out = new Float32Array(W * H);
    const tmp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let acc = erode ? 1 : 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(W - 1, Math.max(0, x + k));
        if (erode) acc = Math.min(acc, src[y * W + xx]); else { acc += src[y * W + xx]; n++; }
      }
      tmp[y * W + x] = erode ? acc : acc / n;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let acc = erode ? 1 : 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(H - 1, Math.max(0, y + k));
        if (erode) acc = Math.min(acc, tmp[yy * W + x]); else { acc += tmp[yy * W + x]; n++; }
      }
      out[y * W + x] = erode ? acc : acc / n;
    }
    return out;
  };
  mask = blur(mask, 2, true);
  mask = blur(mask, 4, false);
  mask = blur(mask, 4, false);

  let covered = 0;
  for (let i = 0; i < W * H; i++) covered += mask[i];
  console.log(`[scene] маска неба: ${(covered / (W * H) * 100).toFixed(1)}% картинки`);
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(Math.min(1, mask[i]) * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.flipY = true;                              // как у картинки: строка 0 — верх
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export async function loadBackdrop(season: Season, base: string): Promise<Backdrop> {
  const img = await loadImage(base + season.backdrop.image);
  const texture = new THREE.Texture(img);
  texture.colorSpace = THREE.NoColorSpace;       // композитим в sRGB, декодировать не нужно
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return {
    texture,
    skyMask: buildSkyMask(img, season.backdrop.skyRegion),
    aspect: img.naturalWidth / img.naturalHeight
  };
}
