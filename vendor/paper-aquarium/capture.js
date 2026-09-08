/* Обработка фотографии листа раскраски: поиск угловых меток, определение вида
   рыбы, выравнивание перспективы, вырезание раскраски по контуру, баланс
   белого. Чистый JS без зависимостей — работает на телефоне в браузере.

   API: FishCapture.processPhoto(source, manifest) → Promise<{
     kind, title, texture (dataURL png), preview (dataURL png),
     boost (ползунок «Ярче цвета»: auto, value, set(v), texCanvas, pvCanvas, bake())
   }> либо reject(Error) с понятным сообщением. */
(function () {
  'use strict';

  var WORK_MAX = 1600;      // рабочий размер фото
  var PX_PER_MM = 5;        // разрешение выровненного листа
  var TEX_W = 1024;         // ширина итоговой текстуры

  // ── линал ────────────────────────────────────────────────────────────────
  function solve8(M, b) {
    var n = 8, A = M.map(function (row, i) { return row.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      var tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === c || Math.abs(A[c][c]) < 1e-12) continue;
        var f = A[r2][c] / A[c][c];
        for (var k = c; k <= n; k++) A[r2][k] -= f * A[c][k];
      }
    }
    return A.map(function (row, i) { return row[n] / row[i]; });
  }

  function homography(src, dst) {
    var M = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1];
      M.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      M.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    return solve8(M, b).concat([1]);
  }

  function applyH(h, x, y) {
    var d = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
  }

  // ── геометрия компонент ──────────────────────────────────────────────────
  function hull(pts) {
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], hi = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], pts[i]) <= 0) lo.pop();
      lo.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], pts[i]) <= 0) hi.pop();
      hi.push(pts[i]);
    }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  }

  // 4 вершины четырёхугольника: пара точек оболочки + самые удалённые от их прямой
  function quadOf(pts) {
    var h = hull(pts);
    if (h.length < 4) return null;
    var best = null, bestArea = 0;
    for (var a = 0; a < h.length; a++) {
      for (var b = a + 1; b < h.length; b++) {
        var dx = h[b][0] - h[a][0], dy = h[b][1] - h[a][1];
        var cMax = 0, cPt = null, dMax = 0, dPt = null;
        for (var k = 0; k < h.length; k++) {
          var cr = (h[k][0] - h[a][0]) * dy - (h[k][1] - h[a][1]) * dx;
          if (cr > cMax) { cMax = cr; cPt = h[k]; }
          if (-cr > dMax) { dMax = -cr; dPt = h[k]; }
        }
        if (cPt && dPt) {
          var area = (cMax + dMax) / 2;
          if (area > bestArea) { bestArea = area; best = [h[a], cPt, h[b], dPt]; }
        }
      }
    }
    return best;
  }

  // ── метки ────────────────────────────────────────────────────────────────
  function rotateBits(bits) {
    var o = new Array(16);
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) o[c * 4 + (3 - r)] = bits[r * 4 + c];
    return o;
  }

  function buildLookup(manifest) {
    var lookup = {};
    manifest.fish.forEach(function (f) {
      ['tl', 'tr', 'bl', 'br'].forEach(function (corner) {
        var bits = f.markers[corner];
        for (var r = 0; r < 4; r++) {
          lookup[bits.join('')] = { kind: f.name, corner: corner };
          bits = rotateBits(bits);
        }
      });
    });
    return lookup;
  }

  function findMarkers(gray, W, H, thr, lookup) {
    var bin = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) bin[i] = gray[i] < thr ? 1 : 0;

    var labels = new Int32Array(W * H), stack = [], found = [];
    var minArea = 250, maxArea = (W * H) / 30;

    for (var start = 0; start < W * H; start++) {
      if (!bin[start] || labels[start]) continue;
      var pts = [];
      stack.length = 0;
      stack.push(start);
      labels[start] = 1;
      while (stack.length) {
        var p = stack.pop();
        var x = p % W, y = (p / W) | 0;
        pts.push([x, y]);
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            var q = ny * W + nx;
            if (bin[q] && !labels[q]) { labels[q] = 1; stack.push(q); }
          }
        }
        if (pts.length > maxArea) break;
      }
      if (pts.length < minArea || pts.length > maxArea) continue;

      var quad = quadOf(pts);
      if (!quad) continue;

      // клетки 6×6: каждую сэмплируем 5 точками, чтобы пережить шум
      var Hq = homography([[0, 0], [6, 0], [6, 6], [0, 6]], quad);
      var samples = [];
      var offs = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];
      for (var r = 0; r < 6; r++) {
        for (var c = 0; c < 6; c++) {
          var sum = 0, cnt = 0;
          for (var o = 0; o < offs.length; o++) {
            var pt = applyH(Hq, c + offs[o][0], r + offs[o][1]);
            var xi = Math.round(pt[0]), yi = Math.round(pt[1]);
            if (xi >= 0 && yi >= 0 && xi < W && yi < H) { sum += gray[yi * W + xi]; cnt++; }
          }
          samples.push(cnt ? sum / cnt : 255);
        }
      }
      var mn = Infinity, mx = -Infinity;
      samples.forEach(function (v) { if (v < mn) mn = v; if (v > mx) mx = v; });
      if (mx - mn < 35) continue;
      var mid = (mn + mx) / 2;
      var cells = samples.map(function (v) { return v < mid ? 0 : 1; });

      var ringBlack = 0;
      for (var rr = 0; rr < 6; rr++) {
        for (var cc = 0; cc < 6; cc++) {
          if (rr === 0 || rr === 5 || cc === 0 || cc === 5) ringBlack += cells[rr * 6 + cc] === 0 ? 1 : 0;
        }
      }
      if (ringBlack < 18) continue;

      var inner = [];
      for (var r2 = 1; r2 < 5; r2++) for (var c2 = 1; c2 < 5; c2++) inner.push(cells[r2 * 6 + c2]);
      var hit = lookup[inner.join('')];
      if (!hit) continue;

      var cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
      var cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
      found.push({ kind: hit.kind, corner: hit.corner, center: [cx, cy] });
    }
    return found;
  }

  // ── контур на канвасе ────────────────────────────────────────────────────
  function contourPath(ctx, fish, toPx) {
    ctx.beginPath();
    fish.contourModel.forEach(function (p, i) {
      var pt = toPx(p);
      if (i === 0) ctx.moveTo(pt[0], pt[1]); else ctx.lineTo(pt[0], pt[1]);
    });
    ctx.closePath();
  }

  // ── главный пайплайн ─────────────────────────────────────────────────────
  function processPhoto(source, manifest) {
    return new Promise(function (resolve, reject) {
      var sw = source.width || source.naturalWidth || source.videoWidth;
      var sh = source.height || source.naturalHeight || source.videoHeight;
      var k = Math.min(1, WORK_MAX / Math.max(sw, sh));
      var W = Math.round(sw * k), H = Math.round(sh * k);

      var photo = document.createElement('canvas');
      photo.width = W; photo.height = H;
      var pctx = photo.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(source, 0, 0, W, H);
      var data = pctx.getImageData(0, 0, W, H).data;

      var gray = new Float32Array(W * H), mean = 0;
      for (var i = 0; i < W * H; i++) {
        gray[i] = (data[i * 4] * 0.35 + data[i * 4 + 1] * 0.5 + data[i * 4 + 2] * 0.15);
        mean += gray[i];
      }
      mean /= W * H;

      // подбираем порог, пока у какого-то вида не найдутся все 4 угла
      var lookup = buildLookup(manifest);
      var byKind = null, kind = null, bestFound = 0;
      var tries = [0.55, 0.45, 0.65, 0.72, 0.38];
      for (var t = 0; t < tries.length && !kind; t++) {
        var found = findMarkers(gray, W, H, mean * tries[t], lookup);
        bestFound = Math.max(bestFound, found.length);
        var groups = {};
        found.forEach(function (f) {
          groups[f.kind] = groups[f.kind] || {};
          groups[f.kind][f.corner] = f.center;
        });
        for (var kd in groups) {
          if (['tl', 'tr', 'bl', 'br'].every(function (c) { return groups[kd][c]; })) {
            kind = kd;
            byKind = groups[kd];
            break;
          }
        }
      }

      if (!kind) {
        reject(new Error(window.I18N
          ? window.I18N.t('cap.err.markers', { n: bestFound })
          : 'Нашёл меток: ' + bestFound + ' из 4. Сфотографируй весь лист целиком, ' +
            'при хорошем свете и без бликов — все четыре чёрных квадрата должны быть в кадре.'));
        return;
      }

      var fish = manifest.fish.filter(function (f) { return f.name === kind; })[0];

      // ── выравнивание листа по центрам меток ──
      var mmPos = manifest.sheet.markerPositions;
      var half = manifest.sheet.marker.size / 2;
      var order = ['tl', 'tr', 'br', 'bl'];
      var srcPts = order.map(function (c) { return [(mmPos[c][0] + half) * PX_PER_MM, (mmPos[c][1] + half) * PX_PER_MM]; });
      var dstPts = order.map(function (c) { return byKind[c]; });
      var Hrect = homography(srcPts, dstPts);   // лист(px) → фото(px)

      var SW = Math.round(manifest.sheet.w * PX_PER_MM);
      var SH = Math.round(manifest.sheet.h * PX_PER_MM);
      var sheet = document.createElement('canvas');
      sheet.width = SW; sheet.height = SH;
      var sctx = sheet.getContext('2d', { willReadFrequently: true });
      var simg = sctx.createImageData(SW, SH);
      for (var y = 0; y < SH; y++) {
        for (var x = 0; x < SW; x++) {
          var pt = applyH(Hrect, x, y);
          var xi = Math.round(pt[0]), yi = Math.round(pt[1]);
          var o = (y * SW + x) * 4;
          if (xi >= 0 && yi >= 0 && xi < W && yi < H) {
            var si = (yi * W + xi) * 4;
            simg.data[o] = data[si]; simg.data[o + 1] = data[si + 1]; simg.data[o + 2] = data[si + 2];
          } else {
            simg.data[o] = simg.data[o + 1] = simg.data[o + 2] = 255;
          }
          simg.data[o + 3] = 255;
        }
      }

      // ── баланс белого по бумаге вокруг рыбы ──
      var st = fish.sheetTransform;
      var bz = fish.bboxModel.z, by = fish.bboxModel.y;
      var cropMM = {
        x0: st.ox + st.scale * bz[0], x1: st.ox + st.scale * bz[1],
        y0: st.oy - st.scale * by[1], y1: st.oy - st.scale * by[0]
      };
      var wr = [0, 0, 0], wn = 0;
      var wa = manifest.sheet.work;
      for (var wy = wa.y0; wy < wa.y1; wy += 3) {
        for (var wx = wa.x0; wx < wa.x1; wx += 3) {
          if (wx > cropMM.x0 - 6 && wx < cropMM.x1 + 6 && wy > cropMM.y0 - 6 && wy < cropMM.y1 + 6) continue;
          var pi = ((wy * PX_PER_MM | 0) * SW + (wx * PX_PER_MM | 0)) * 4;
          var lum = (simg.data[pi] + simg.data[pi + 1] + simg.data[pi + 2]) / 3;
          if (lum > 90) { wr[0] += simg.data[pi]; wr[1] += simg.data[pi + 1]; wr[2] += simg.data[pi + 2]; wn++; }
        }
      }
      var gain = [1, 1, 1];
      if (wn > 20) {
        for (var ch = 0; ch < 3; ch++) {
          gain[ch] = Math.min(2.4, Math.max(0.8, 247 / (wr[ch] / wn)));
        }
      }
      for (var p2 = 0; p2 < SW * SH; p2++) {
        simg.data[p2 * 4] = Math.min(255, simg.data[p2 * 4] * gain[0]);
        simg.data[p2 * 4 + 1] = Math.min(255, simg.data[p2 * 4 + 1] * gain[1]);
        simg.data[p2 * 4 + 2] = Math.min(255, simg.data[p2 * 4 + 2] * gain[2]);
      }
      sctx.putImageData(simg, 0, 0);

      // ── текстура: кадр по bbox контура, фон — средний цвет раскраски ──
      var cropW = cropMM.x1 - cropMM.x0, cropH = cropMM.y1 - cropMM.y0;
      var TH = Math.round(TEX_W * cropH / cropW);
      var tex = document.createElement('canvas');
      tex.width = TEX_W; tex.height = TH;
      var tctx = tex.getContext('2d');

      function mmToTex(p) {   // модельные (z,y) → пиксели текстуры
        return [
          (st.ox + st.scale * p[0] - cropMM.x0) / cropW * TEX_W,
          (st.oy - st.scale * p[1] - cropMM.y0) / cropH * TH
        ];
      }

      // Маска раскраски с «выеденной» печатной обводкой: заливка контура минус
      // штрих вдоль самого контура. Обводка на листе 1.6 мм по центру линии
      // плюс размытие печати и фото — срезаем по TRIM_MM с каждой стороны.
      // Контур стал тоньше и светлее, поэтому и полоса уже: у рыбки остаётся
      // больше детского рисунка по краю.
      var TRIM_MM = 1.8;
      var pxPerMMTex = TEX_W / cropW;
      var maskCv = document.createElement('canvas');
      maskCv.width = TEX_W; maskCv.height = TH;
      var mctx = maskCv.getContext('2d');
      contourPath(mctx, fish, mmToTex);
      mctx.fillStyle = '#fff';
      mctx.fill();
      mctx.globalCompositeOperation = 'destination-out';
      contourPath(mctx, fish, mmToTex);
      mctx.lineWidth = TRIM_MM * 2 * pxPerMMTex;
      mctx.lineJoin = 'round';
      mctx.lineCap = 'round';
      mctx.stroke();
      var mask = mctx.getImageData(0, 0, TEX_W, TH).data;

      tctx.drawImage(sheet,
        cropMM.x0 * PX_PER_MM, cropMM.y0 * PX_PER_MM, cropW * PX_PER_MM, cropH * PX_PER_MM,
        0, 0, TEX_W, TH);
      var img = tctx.getImageData(0, 0, TEX_W, TH);
      var d = img.data;
      var N = TEX_W * TH;

      var filled = new Uint8Array(N);
      var ar = [0, 0, 0], an = 0;
      for (var fi = 0; fi < N; fi++) {
        if (mask[fi * 4 + 3] > 128) {
          filled[fi] = 1;
          if (fi % 13 === 0) { ar[0] += d[fi * 4]; ar[1] += d[fi * 4 + 1]; ar[2] += d[fi * 4 + 2]; an++; }
        }
      }
      var avg = an ? [ar[0] / an | 0, ar[1] / an | 0, ar[2] / an | 0] : [220, 214, 200];

      // Цвета раскраски вытягиваем наружу за срезанный край: волна дилатации —
      // на краях рыбки продолжается детский рисунок, а не чёрная кайма.
      var passes = Math.ceil(TRIM_MM * pxPerMMTex) + 6;
      for (var p = 0; p < passes; p++) {
        var next = new Uint8Array(filled);
        var changed = false;
        for (var y = 0; y < TH; y++) {
          for (var x = 0; x < TEX_W; x++) {
            var i = y * TEX_W + x;
            if (filled[i]) continue;
            var sr = 0, sg = 0, sb = 0, c = 0;
            if (x > 0 && filled[i - 1]) { sr += d[(i - 1) * 4]; sg += d[(i - 1) * 4 + 1]; sb += d[(i - 1) * 4 + 2]; c++; }
            if (x < TEX_W - 1 && filled[i + 1]) { sr += d[(i + 1) * 4]; sg += d[(i + 1) * 4 + 1]; sb += d[(i + 1) * 4 + 2]; c++; }
            if (y > 0 && filled[i - TEX_W]) { sr += d[(i - TEX_W) * 4]; sg += d[(i - TEX_W) * 4 + 1]; sb += d[(i - TEX_W) * 4 + 2]; c++; }
            if (y < TH - 1 && filled[i + TEX_W]) { sr += d[(i + TEX_W) * 4]; sg += d[(i + TEX_W) * 4 + 1]; sb += d[(i + TEX_W) * 4 + 2]; c++; }
            if (c) {
              d[i * 4] = sr / c; d[i * 4 + 1] = sg / c; d[i * 4 + 2] = sb / c;
              next[i] = 1;
              changed = true;
            }
          }
        }
        filled = next;
        if (!changed) break;
      }
      for (var ri = 0; ri < N; ri++) {
        if (!filled[ri]) { d[ri * 4] = avg[0]; d[ri * 4 + 1] = avg[1]; d[ri * 4 + 2] = avg[2]; }
      }
      tctx.putImageData(img, 0, 0);

      // ── «Ярче цвета» ──
      // Светлый карандаш на рыбке почти не виден. Голая яркость не лечит:
      // темнеет и бумага между штрихами, рисунок серее, а не сочнее. Поэтому
      // усиливаем «чернила» (255−c растягивается — белая бумага на месте)
      // и следом насыщенность вокруг собственной яркости пикселя.
      // Сырые пиксели держим отдельно: ползунок всегда крутит оригинал,
      // а не результат прошлого положения.
      var raw = new Uint8ClampedArray(d);

      function boostPixels(v) {
        if (v <= 0) { d.set(raw); return; }
        var g = 1 + v * 1.6;
        var s = 1 + v * 1.4;
        for (var bi = 0; bi < N; bi++) {
          var o2 = bi * 4;
          var r = 255 - (255 - raw[o2]) * g;
          var gr = 255 - (255 - raw[o2 + 1]) * g;
          var b = 255 - (255 - raw[o2 + 2]) * g;
          if (r < 0) r = 0;
          if (gr < 0) gr = 0;
          if (b < 0) b = 0;
          var l = r * 0.299 + gr * 0.587 + b * 0.114;
          d[o2] = l + (r - l) * s;          // Uint8Clamped сам режет 0..255
          d[o2 + 1] = l + (gr - l) * s;
          d[o2 + 2] = l + (b - l) * s;
        }
      }

      // Авто-положение: меряем силу штриха (80-й перцентиль темноты) внутри
      // контура. Фломастер и так сочный — ноль; светлый карандаш — ощутимый
      // буст. Почти пустой лист не трогаем: усиливать там нечего, а шум
      // бумаги проступил бы пятнами.
      var inks = [];
      for (var mi = 0; mi < N; mi += 7) {
        if (mask[mi * 4 + 3] > 128) {
          inks.push(255 - (raw[mi * 4] * 0.299 + raw[mi * 4 + 1] * 0.587 + raw[mi * 4 + 2] * 0.114));
        }
      }
      inks.sort(function (a, b) { return a - b; });
      var p80 = inks.length ? inks[(inks.length * 0.8) | 0] : 0;
      var auto = p80 < 10 ? 0 : Math.max(0, Math.min(0.8, (115 - p80) / 115));

      // ── превью для телефона: рыбка на тёмном фоне ──
      var PV_W = 640, PV_H = Math.round(PV_W * cropH / cropW);
      var pv = document.createElement('canvas');
      pv.width = PV_W; pv.height = PV_H;
      var pvctx = pv.getContext('2d');
      function mmToPv(p) {
        return [
          (st.ox + st.scale * p[0] - cropMM.x0) / cropW * PV_W,
          (st.oy - st.scale * p[1] - cropMM.y0) / cropH * PV_H
        ];
      }
      function drawPreview() {
        pvctx.fillStyle = '#0a2233';
        pvctx.fillRect(0, 0, PV_W, PV_H);
        pvctx.save();
        contourPath(pvctx, fish, mmToPv);
        pvctx.clip();
        pvctx.drawImage(tex, 0, 0, PV_W, PV_H);
        pvctx.restore();
        contourPath(pvctx, fish, mmToPv);
        pvctx.strokeStyle = 'rgba(255,255,255,.85)';
        pvctx.lineWidth = 3;
        pvctx.stroke();
      }

      var boost = {
        auto: auto,
        value: 0,
        texCanvas: tex,
        pvCanvas: pv,
        set: function (v) {
          boost.value = v;
          boostPixels(v);
          tctx.putImageData(img, 0, 0);
          drawPreview();
        },
        // dataURL — только по требованию: на каждое движение ползунка PNG
        // кодировать дорого, а нужен он один раз, при отправке в аквариум
        bake: function () {
          return { texture: tex.toDataURL('image/png'), preview: pv.toDataURL('image/png') };
        }
      };
      boost.set(auto);

      resolve({
        kind: kind,
        title: fish.title,
        titles: fish.titles || null,   // название вида на языках сайта
        texture: tex.toDataURL('image/png'),
        preview: pv.toDataURL('image/png'),
        boost: boost
      });
    });
  }

  window.FishCapture = { processPhoto: processPhoto };
})();
