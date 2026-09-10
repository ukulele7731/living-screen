// Формы листьев из assets/coloring/manifest.json — те же контуры, что печатаются
// на раскрасках и по которым capture.js вырезает рисунок. Координаты модельные:
// x = z_model (горизонталь), y = y_model (вверх), длинная сторона bbox = 1.
import manifest from '../../assets/coloring/manifest.json';

export interface LeafShape {
  name: string;
  title: string;
  contour: [number, number][];
  bbox: { x0: number; x1: number; y0: number; y1: number };
  /** ширина / высота bbox */
  aspect: number;
  /** центральная жилка: основание → кончик */
  vein: [[number, number], [number, number]];
}

export const LEAF_SHAPES: Record<string, LeafShape> = {};
for (const f of manifest.fish) {
  const vein = (f as { vein?: number[][] }).vein;
  const bbox = { x0: f.bboxModel.z[0], x1: f.bboxModel.z[1], y0: f.bboxModel.y[0], y1: f.bboxModel.y[1] };
  LEAF_SHAPES[f.name] = {
    name: f.name,
    title: f.title,
    contour: f.contourModel.map((p) => [p[0], p[1]] as [number, number]),
    bbox,
    aspect: (bbox.x1 - bbox.x0) / (bbox.y1 - bbox.y0),
    vein: vein
      ? [[vein[0][0], vein[0][1]], [vein[1][0], vein[1][1]]]
      : [[0, bbox.y0], [0, bbox.y1]]
  };
}

export const LEAF_KINDS = Object.keys(LEAF_SHAPES);
