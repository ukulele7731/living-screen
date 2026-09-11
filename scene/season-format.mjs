// Компактная запись seasons/*.json: параметры-числа и короткие объекты — в одну строку,
// массивы объектов — по объекту на строку, между разделами верхнего уровня — пустая строка.
// Используется панелью Shift+D (vite.config.ts) и скриптами, чтобы файл оставался читаемым.
export function formatSeason(data) {
  const inline = (v) => JSON.stringify(v).replace(/,(?=")|,(?=-?\d)|,(?=\[)|,(?=\{)|,(?=true|false|null)/g, ', ').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }').replace(/^\{  \}$/, '{}');
  const isLeaf = (v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object'));
  const fmt = (v, ind) => {
    if (Array.isArray(v)) {
      if (isLeaf(v)) return inline(v);
      return '[\n' + v.map((x) => ind + '  ' + fmt(x, ind + '  ')).join(',\n') + '\n' + ind + ']';
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      const simple = keys.every((k) => isLeaf(v[k]));
      if (simple) { const s = inline(v); if (s.length <= 140) return s; }
      return '{\n' + keys.map((k) => ind + '  ' + JSON.stringify(k) + ': ' + fmt(v[k], ind + '  ')).join(',\n') + '\n' + ind + '}';
    }
    return JSON.stringify(v);
  };
  const keys = Object.keys(data);
  const lines = keys.map((k, i) => {
    const v = data[k];
    const s = '  ' + JSON.stringify(k) + ': ' + fmt(v, '  ');
    const section = v && typeof v === 'object' && !isLeaf(v);
    const nextSection = i + 1 < keys.length && data[keys[i + 1]] && typeof data[keys[i + 1]] === 'object' && !isLeaf(data[keys[i + 1]]);
    return s + (i + 1 < keys.length ? ',' : '') + ((section || nextSection) && i + 1 < keys.length ? '\n' : '');
  });
  return '{\n' + lines.join('\n') + '\n}\n';
}
