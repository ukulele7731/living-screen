#!/usr/bin/env node
'use strict';
/* Сборка листов раскраски в PDF через headless Chrome.

   assets/coloring/<вид>.svg → assets/coloring/raskraski.pdf      (8 страниц)
                             → assets/coloring/raskraski-mini.pdf (клён и дуб)

   A4 альбомный, 1:1 в миллиметрах, без полей и масштабирования: метки на бумаге
   должны быть ровно 18 мм. После сборки PDF разбирается (потоки страниц,
   zlib) и по чёрным квадратам меток измеряются их центры; расхождение с
   манифестом больше MAX_DEV_MM — ошибка (код выхода 1).

   Node 20+, без зависимостей. Нужен Chrome/Chromium: путь берётся из
   переменной CHROME_PATH или ищется в обычных местах.

   Запуск: node tools/make-pdf.js */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COLORING = path.join(ROOT, 'assets', 'coloring');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(COLORING, 'manifest.json'), 'utf8'));

const ORDER = ['maple', 'oak', 'linden', 'aspen', 'birch', 'chestnut', 'rowan', 'willow'];
const MINI = ['maple', 'oak'];
const MAX_DEV_MM = 0.5;
const PT_PER_MM = 72 / 25.4;

// ══════════════════════════════════════════════════════════════════════════
// Chrome
// ══════════════════════════════════════════════════════════════════════════

function findChrome() {
  const env = process.env.CHROME_PATH || process.env.CHROME || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, name));
    }
    candidates.push('/opt/pw-browsers/chromium');           // Playwright в контейнере
  }
  const found = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
  if (!found) throw new Error('Chrome не найден. Укажи путь в переменной окружения CHROME_PATH.');
  return found;
}

function buildHtml(kinds) {
  const pages = kinds.map((kind) => {
    const file = path.join(COLORING, kind + '.svg');
    if (!fs.existsSync(file)) throw new Error(`нет ${file} — сначала node tools/make-sheets.js`);
    const svg = fs.readFileSync(file, 'utf8').replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
    return `<div class="page">${svg}</div>`;
  });
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Живой листопад — раскраски</title>
<style>
  @page { size: 297mm 210mm; margin: 0; }
  html, body { margin: 0; padding: 0; }
  .page { width: 297mm; height: 210mm; overflow: hidden; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .page svg { display: block; width: 297mm; height: 210mm; }
</style></head><body>${pages.join('')}</body></html>`;
}

function printPdf(chrome, html, outFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leaffall-pdf-'));
  const htmlFile = path.join(tmp, 'sheets.html');
  fs.writeFileSync(htmlFile, html);
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + path.join(tmp, 'profile'),
    '--no-pdf-header-footer',
    '--print-to-pdf=' + outFile,
    'file://' + htmlFile
  ];
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  try {
    execFileSync(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!fs.existsSync(outFile)) throw new Error('Chrome не записал ' + outFile);
}

// ══════════════════════════════════════════════════════════════════════════
// Разбор PDF: страницы → содержимое → чёрные квадраты меток
// ══════════════════════════════════════════════════════════════════════════

function parsePdf(buf) {
  const s = buf.toString('latin1');                 // 1 символ = 1 байт, индексы = смещения
  const objects = {};
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1], start = m.index + m[0].length;
    const dictEnd = s.indexOf('endobj', start);
    let body = s.slice(start, dictEnd);
    let stream = null;
    const st = body.indexOf('stream');
    if (st >= 0 && /stream\r?\n/.test(body.slice(st, st + 8))) {
      const dict = body.slice(0, st);
      let len;
      const lenRef = /\/Length\s+(\d+)\s+0\s+R/.exec(dict);
      if (lenRef) len = 'ref:' + lenRef[1];
      else { const ld = /\/Length\s+(\d+)/.exec(dict); len = ld ? +ld[1] : null; }
      const dataStart = start + st + (body.slice(st, st + 8).indexOf('\n') + 1);
      stream = { dataStart, len, dict };
      body = dict;
    }
    objects[num] = { body, stream };
  }
  const resolveLen = (o) => {
    if (typeof o.stream.len === 'string') {
      const ref = objects[+o.stream.len.slice(4)];
      o.stream.len = ref ? parseInt(ref.body, 10) : null;
    }
    if (o.stream.len == null) {                     // на всякий случай — до endstream
      const end = s.indexOf('endstream', o.stream.dataStart);
      o.stream.len = end - o.stream.dataStart;
    }
    return o.stream.len;
  };
  const streamData = (num) => {
    const o = objects[num];
    if (!o || !o.stream) return null;
    const len = resolveLen(o);
    let data = buf.subarray(o.stream.dataStart, o.stream.dataStart + len);
    if (/\/FlateDecode/.test(o.stream.dict)) data = zlib.inflateSync(data);
    return data.toString('latin1');
  };
  return { objects, streamData, text: s };
}

// порядок страниц по дереву /Pages → /Kids
function pageOrder(pdf) {
  const { objects } = pdf;
  let rootNum = null;
  for (const num of Object.keys(objects)) {
    const b = objects[num].body;
    if (/\/Type\s*\/Pages\b/.test(b) && !/\/Parent\b/.test(b)) { rootNum = +num; break; }
  }
  if (rootNum == null) throw new Error('в PDF не найден корень /Pages');
  const pages = [];
  const walk = (num) => {
    const b = objects[num].body;
    if (/\/Type\s*\/Page\b/.test(b)) { pages.push(num); return; }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(b);
    if (kids) for (const k of kids[1].matchAll(/(\d+)\s+0\s+R/g)) walk(+k[1]);
  };
  walk(rootNum);
  return pages;
}

function dictValue(body, key, objects) {           // значение ключа, разворачивая ссылку
  const m = new RegExp(`\\/${key}\\s*(\\d+\\s+0\\s+R|\\[[^\\]]*\\]|<<|[^\\s/>]+)`).exec(body);
  if (!m) return null;
  let v = m[1];
  const ref = /^(\d+)\s+0\s+R$/.exec(v);
  if (ref) return objects[+ref[1]] ? objects[+ref[1]].body : null;
  if (v === '<<') {                                 // вложенный словарь: вырезаем по балансу скобок
    let depth = 0, i = m.index + m[0].length - 2;
    for (; i < body.length; i++) {
      if (body.startsWith('<<', i)) { depth++; i++; } else if (body.startsWith('>>', i)) { depth--; i++; if (!depth) break; }
    }
    return body.slice(m.index + m[0].length - 2, i + 1);
  }
  return v;
}

function mul(a, b) {                                // a × b для матриц [a b c d e f]
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
  ];
}
const xf = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

// Интерпретируем поток: собираем закрашенные прямоугольники {x,y,w,h (pt), gray}
function collectRects(pdf, content, resources, ctm0, out, depth) {
  const tokens = content.match(/\/[^\s/\[\]<>()]+|-?\d*\.?\d+(?:[eE][-+]?\d+)?|<<|>>|\[|\]|\([^)]*\)|<[0-9A-Fa-f]*>|[A-Za-z'"*]+/g) || [];
  let ctm = ctm0.slice(), stack = [], nums = [], names = [];
  let fill = 0, subpaths = [], cur = null;
  const flushPath = (doFill) => {
    if (doFill) {
      for (const sp of subpaths) {
        const pts = sp.length === 5 && Math.hypot(sp[0][0] - sp[4][0], sp[0][1] - sp[4][1]) < 1e-6 ? sp.slice(0, 4) : sp;
        if (pts.length !== 4) continue;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        // прямоугольник по осям: каждая вершина в углу bbox
        const axis = pts.every((p) => (Math.abs(p[0] - x0) < 0.05 || Math.abs(p[0] - x1) < 0.05) && (Math.abs(p[1] - y0) < 0.05 || Math.abs(p[1] - y1) < 0.05));
        if (axis) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, gray: fill });
      }
    }
    subpaths = []; cur = null;
  };
  for (const t of tokens) {
    if (/^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(t)) { nums.push(parseFloat(t)); continue; }
    if (t[0] === '/') { names.push(t.slice(1)); continue; }
    switch (t) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': ctm = mul(nums.slice(-6), ctm); break;
      case 'g': fill = nums[nums.length - 1]; break;
      case 'rg': fill = (nums[nums.length - 3] + nums[nums.length - 2] + nums[nums.length - 1]) / 3; break;
      case 'k': fill = 1 - Math.min(1, nums[nums.length - 1] + (nums[nums.length - 4] + nums[nums.length - 3] + nums[nums.length - 2]) / 3); break;
      case 'sc': case 'scn': if (nums.length >= 1) fill = nums.slice(-Math.min(3, nums.length)).reduce((a, b) => a + b, 0) / Math.min(3, nums.length); break;
      case 'm': cur = [xf(ctm, nums[nums.length - 2], nums[nums.length - 1])]; subpaths.push(cur); break;
      case 'l': if (cur) cur.push(xf(ctm, nums[nums.length - 2], nums[nums.length - 1])); break;
      case 'c': if (cur) cur.push(xf(ctm, nums[nums.length - 2], nums[nums.length - 1]), [NaN, NaN]); break;
      case 'v': case 'y': if (cur) cur.push(xf(ctm, nums[nums.length - 2], nums[nums.length - 1]), [NaN, NaN]); break;
      case 'h': if (cur && cur.length) cur.push(cur[0].slice()); cur = null; break;
      case 're': {
        const [x, y, w, h] = nums.slice(-4);
        subpaths.push([xf(ctm, x, y), xf(ctm, x + w, y), xf(ctm, x + w, y + h), xf(ctm, x, y + h), xf(ctm, x, y)]);
        cur = null; break;
      }
      case 'f': case 'F': case 'f*': case 'b': case 'B': case 'b*': case 'B*': flushPath(true); break;
      case 'n': case 'S': case 's': flushPath(false); break;
      case 'Do': {                                   // форма XObject — рекурсия с её матрицей
        const name = names[names.length - 1];
        if (depth < 4 && resources) {
          const xdict = dictValue(resources, 'XObject', pdf.objects);
          const ref = xdict && new RegExp(`\\/${name}\\s+(\\d+)\\s+0\\s+R`).exec(xdict);
          if (ref) {
            const num = +ref[1], o = pdf.objects[num];
            if (o && o.stream && /\/Subtype\s*\/Form/.test(o.stream.dict)) {
              const mm = /\/Matrix\s*\[([^\]]*)\]/.exec(o.stream.dict);
              const mat = mm ? mm[1].trim().split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0];
              const res = dictValue(o.stream.dict, 'Resources', pdf.objects) || resources;
              collectRects(pdf, pdf.streamData(num), res, mul(mat, ctm), out, depth + 1);
            }
          }
        }
        break;
      }
      default: break;
    }
    if (!/^(BI|ID)$/.test(t)) { nums = []; names = names.slice(-2); }
  }
}

// Метки на странице: чёрные квадраты ≈18 мм; код — по белым клеткам внутри
function markersOnPage(pdf, pageNum) {
  const body = pdf.objects[pageNum].body;
  const mb = /\/MediaBox\s*\[([^\]]*)\]/.exec(body);
  const box = mb ? mb[1].trim().split(/\s+/).map(Number) : [0, 0, 0, 0];
  const pageW = box[2] - box[0], pageH = box[3] - box[1];
  const contents = [];
  const cm = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(body);
  if (cm) for (const r of cm[1].matchAll(/(\d+)\s+0\s+R/g)) contents.push(+r[1]);
  const resources = dictValue(body, 'Resources', pdf.objects);
  const rects = [];
  for (const c of contents) collectRects(pdf, pdf.streamData(c) || '', resources, [1, 0, 0, 1, 0, 0], rects, 0);

  const size = MANIFEST.sheet.marker.size * PT_PER_MM, cells = MANIFEST.sheet.marker.cells;
  const squares = rects.filter((r) => r.gray < 0.2 && Math.abs(r.w - size) < 2 * PT_PER_MM && Math.abs(r.h - size) < 2 * PT_PER_MM);
  return {
    pageW, pageH,
    markers: squares.map((sq) => {
      // PDF: начало координат внизу слева → мм от верхнего левого угла
      const cx = (sq.x + sq.w / 2) / PT_PER_MM, cy = (pageH - (sq.y + sq.h / 2)) / PT_PER_MM;
      const cell = sq.w / cells, bits = new Array(16).fill(0);
      for (const r of rects) {
        if (r.gray < 0.8 || r.w > cell * 1.5 || r.h > cell * 1.5) continue;
        const mx = r.x + r.w / 2, my = r.y + r.h / 2;
        if (mx < sq.x || mx > sq.x + sq.w || my < sq.y || my > sq.y + sq.h) continue;
        const col = Math.floor((mx - sq.x) / cell), rowFromBottom = Math.floor((my - sq.y) / cell);
        const row = cells - 1 - rowFromBottom;
        if (row >= 1 && row <= 4 && col >= 1 && col <= 4) bits[(row - 1) * 4 + (col - 1)] = 1;
      }
      return { cx, cy, sizeMM: sq.w / PT_PER_MM, bits };
    })
  };
}

function rotateBits(bits) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + (3 - r)] = bits[r * 4 + c];
  return o;
}
function identify(bits) {                           // код метки → {kind, corner} по манифесту (с поворотами)
  for (const f of MANIFEST.fish) {
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      let b = f.markers[corner];
      for (let r = 0; r < 4; r++) {
        if (b.join('') === bits.join('')) return { kind: f.name, corner, rot: r };
        b = rotateBits(b);
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// Проверка собранного PDF
// ══════════════════════════════════════════════════════════════════════════

function verify(pdfFile, kinds) {
  const pdf = parsePdf(fs.readFileSync(pdfFile));
  const pages = pageOrder(pdf);
  const sheet = MANIFEST.sheet, half = sheet.marker.size / 2;
  const expected = {};
  for (const c of ['tl', 'tr', 'bl', 'br']) expected[c] = [sheet.markerPositions[c][0] + half, sheet.markerPositions[c][1] + half];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pairs = [['tl', 'tr'], ['tl', 'bl'], ['tl', 'br'], ['tr', 'bl'], ['tr', 'br'], ['bl', 'br']];

  let errors = 0, worst = 0;
  console.log(`\n${path.basename(pdfFile)}: страниц ${pages.length}, ожидалось ${kinds.length}`);
  if (pages.length !== kinds.length) errors++;
  pages.forEach((pageNum, i) => {
    const { pageW, pageH, markers } = markersOnPage(pdf, pageNum);
    const wMM = pageW / PT_PER_MM, hMM = pageH / PT_PER_MM;
    const problems = [];
    if (Math.abs(wMM - sheet.w) > MAX_DEV_MM || Math.abs(hMM - sheet.h) > MAX_DEV_MM) problems.push(`страница ${wMM.toFixed(2)}×${hMM.toFixed(2)} мм`);

    const byCorner = {};
    let kind = null;
    for (const mk of markers) {
      const id = identify(mk.bits);
      if (!id) { problems.push(`метка с неизвестным кодом в (${mk.cx.toFixed(0)}, ${mk.cy.toFixed(0)})`); continue; }
      if (id.rot !== 0) problems.push(`метка ${id.corner} повёрнута на ${id.rot * 90}°`);
      kind = kind || id.kind;
      if (id.kind !== kind) problems.push(`метки разных видов на одной странице (${kind}, ${id.kind})`);
      byCorner[id.corner] = mk;
    }
    const corners = Object.keys(byCorner);
    if (corners.length !== 4) problems.push(`найдено меток: ${corners.length} из 4`);
    if (kind !== kinds[i]) problems.push(`ожидался ${kinds[i]}, на странице ${kind || 'ничего'}`);

    let devCenter = 0, devDist = 0, devSize = 0;
    for (const c of corners) {
      devCenter = Math.max(devCenter, dist([byCorner[c].cx, byCorner[c].cy], expected[c]));
      devSize = Math.max(devSize, Math.abs(byCorner[c].sizeMM - sheet.marker.size));
    }
    for (const [a, b] of pairs) {
      if (!byCorner[a] || !byCorner[b]) continue;
      const got = dist([byCorner[a].cx, byCorner[a].cy], [byCorner[b].cx, byCorner[b].cy]);
      devDist = Math.max(devDist, Math.abs(got - dist(expected[a], expected[b])));
    }
    worst = Math.max(worst, devCenter, devDist, devSize);
    if (devCenter > MAX_DEV_MM) problems.push(`центры меток уехали на ${devCenter.toFixed(2)} мм`);
    if (devDist > MAX_DEV_MM) problems.push(`расстояния между метками расходятся на ${devDist.toFixed(2)} мм`);
    if (devSize > MAX_DEV_MM) problems.push(`размер метки отличается на ${devSize.toFixed(2)} мм`);
    if (problems.length) errors++;

    const title = (MANIFEST.fish.find((f) => f.name === kinds[i]) || {}).title || kinds[i];
    console.log(`  стр. ${i + 1}  ${title.padEnd(8)} ${(kind || '?').padEnd(9)} меток ${corners.length}/4  ` +
      `центры ±${devCenter.toFixed(3)} мм  расстояния ±${devDist.toFixed(3)} мм  метка ${(byCorner.tl ? byCorner.tl.sizeMM : NaN).toFixed(2)} мм` +
      (problems.length ? `  ✗ ${problems.join('; ')}` : '  ✓'));
  });
  console.log(`  максимальное расхождение: ${worst.toFixed(3)} мм (допуск ${MAX_DEV_MM})`);
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════

function main() {
  const chrome = findChrome();
  console.log('Chrome:', chrome);
  const jobs = [
    { file: path.join(COLORING, 'raskraski.pdf'), kinds: ORDER },
    { file: path.join(COLORING, 'raskraski-mini.pdf'), kinds: MINI }
  ];
  let errors = 0;
  for (const job of jobs) {
    printPdf(chrome, buildHtml(job.kinds), job.file);
    console.log(`Записан ${path.relative(ROOT, job.file)} (${(fs.statSync(job.file).size / 1024).toFixed(0)} КБ)`);
    errors += verify(job.file, job.kinds);
  }
  if (errors) {
    console.error(`\nОшибок: ${errors}. PDF не годится для печати.`);
    process.exit(1);
  }
  console.log('\nВсё сходится: метки на месте, масштаб 1:1.');
}

main();
