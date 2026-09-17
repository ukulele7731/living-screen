// Загрузчик /r/<код>: гость фотографирует раскраску, capture.js вырезает лист прямо в телефоне,
// текстура уходит на сервер (POST /api/rooms/:code/leaves), сервер шлёт её на экраны.
// Без сборки: обычный ES-модуль, работает в любом современном мобильном браузере.
const code = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase();
const $ = (id) => document.getElementById(id);
const els = {
  room: $('room'), shootBtn: $('shoot-btn'), input: document.querySelector('#shoot-btn input'), msg: $('msg'),
  send: $('s-send'), preview: $('preview'), kind: $('kind'), name: $('name'), retake: $('retake'), sendBtn: $('send'),
  mine: $('mine'), ownerOut: $('owner-out'), ownerIn: $('owner-in'), password: $('password'), loginBtn: $('login-btn'),
  loginMsg: $('login-msg'), pairCode: $('pair-code'), pairLabel: $('pair-label'), pairBtn: $('pair-btn'), ownerMsg: $('owner-msg'), screens: $('screens')
};

let manifest = null, titles = {}, captured = null;   // captured: {kind, texture (dataURL), preview}

async function api(url, init = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 120) || `HTTP ${res.status}` }; }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function say(el, text, kind = 'info', ms = 6000) {
  el.textContent = text; el.dataset.kind = kind; el.hidden = false;
  clearTimeout(el._t);
  if (ms) el._t = setTimeout(() => { el.hidden = true; }, ms);
}

async function loadRoom() {
  if (!code) { say(els.msg, 'В адресе нет кода комнаты. Отсканируйте QR с телевизора ещё раз.', 'err', 0); els.shootBtn.classList.add('busy'); return; }
  try {
    const room = await api(`/api/rooms/${encodeURIComponent(code)}`);
    els.room.textContent = `${room.code} · листьев: ${room.leaf_count}`;
    if (room.role === 'owner') showOwner(true);
    manifest = await api(`/api/manifest?season=${encodeURIComponent(room.season)}`);
    for (const f of manifest.fish) titles[f.name] = f.title;
    await loadMine();
  } catch (e) {
    say(els.msg, `Комната не открылась: ${e.message}`, 'err', 0);
    els.shootBtn.classList.add('busy');
  }
}

async function onPhoto(file) {
  if (!window.FishCapture || !manifest) { say(els.msg, 'Распознавание не загрузилось, обновите страницу', 'err'); return; }
  els.shootBtn.classList.add('busy');
  say(els.msg, 'Ищу метки и вырезаю лист…', 'info', 0);
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const res = await window.FishCapture.processPhoto(bitmap, manifest);
    bitmap.close();
    captured = res;
    els.preview.src = res.preview;
    els.kind.textContent = titles[res.kind] || res.kind;
    els.msg.hidden = true;
    document.getElementById('s-shoot').hidden = true;
    els.send.hidden = false;
    els.name.focus();
  } catch (e) {
    say(els.msg, `Не получилось: ${e.message}`, 'err', 12000);
  } finally {
    els.shootBtn.classList.remove('busy');
    els.input.value = '';
  }
}

async function sendLeaf() {
  if (!captured) return;
  els.sendBtn.disabled = true;
  els.sendBtn.textContent = 'Отправляю…';
  try {
    const blob = await (await fetch(captured.texture)).blob();
    const fd = new FormData();
    fd.append('kind', captured.kind);
    fd.append('name', els.name.value.trim());
    fd.append('texture', blob, 'leaf.png');
    const leaf = await api(`/api/rooms/${encodeURIComponent(code)}/leaves`, { method: 'POST', body: fd });
    try { localStorage.setItem('ls_name', els.name.value.trim()); } catch { /* приватный режим */ }
    els.send.hidden = true;
    document.getElementById('s-shoot').hidden = false;
    say(els.msg, `${titles[leaf.kind] || leaf.kind}${leaf.name ? ' — ' + leaf.name : ''}: лист улетел на экран! 🍂`, 'ok', 8000);
    captured = null;
    await loadMine();
    try { const room = await api(`/api/rooms/${encodeURIComponent(code)}`); els.room.textContent = `${room.code} · листьев: ${room.leaf_count}`; } catch { /* не критично */ }
  } catch (e) {
    say(els.msg, `Не отправилось: ${e.message}`, 'err', 12000);
    els.send.hidden = true;
    document.getElementById('s-shoot').hidden = false;
  } finally {
    els.sendBtn.disabled = false;
    els.sendBtn.textContent = 'Отправить на экран';
  }
}

async function loadMine() {
  try {
    const mine = await api(`/api/rooms/${encodeURIComponent(code)}/leaves/mine`);
    els.mine.innerHTML = mine.length ? '' : '<span class="hint">пока пусто</span>';
    for (const l of mine) {
      const card = document.createElement('div');
      card.className = 'leaf';
      card.innerHTML = `<img src="${l.thumb_url}" alt=""><div class="name">${escapeHtml(l.name || titles[l.kind] || l.kind)}</div><button title="Удалить">✕</button>`;
      card.querySelector('button').addEventListener('click', async () => {
        if (!confirm('Убрать этот лист с экрана?')) return;
        try { await api(`/api/rooms/${encodeURIComponent(code)}/leaves/${l.id}`, { method: 'DELETE' }); await loadMine(); }
        catch (e) { say(els.msg, e.message, 'err'); }
      });
      els.mine.appendChild(card);
    }
  } catch { /* список — не критично */ }
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ── владелец: вход, привязка телевизора, экраны ──
function showOwner(on) {
  els.ownerOut.hidden = !on;
  els.ownerIn.hidden = on;
  if (on) void loadScreens();
}

async function login() {
  try {
    await api(`/api/rooms/${encodeURIComponent(code)}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: els.password.value }) });
    els.password.value = '';
    showOwner(true);
  } catch (e) { say(els.loginMsg, e.message, 'err'); }
}

async function pair() {
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(code)}/screens`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: els.pairCode.value.trim(), label: els.pairLabel.value.trim() }) });
    say(els.ownerMsg, `Экран «${r.label}» привязан — на телевизоре сейчас откроется листопад`, 'ok');
    els.pairCode.value = '';
    await loadScreens();
  } catch (e) { say(els.ownerMsg, e.message, 'err', 10000); }
}

async function loadScreens() {
  try {
    const list = await api(`/api/rooms/${encodeURIComponent(code)}/screens`);
    els.screens.innerHTML = list.length ? '' : '<span class="hint">экранов нет</span>';
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'screen';
      row.innerHTML = `<span>${escapeHtml(s.label || 'Экран')}</span><button>отвязать</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Отвязать «${s.label || 'Экран'}»?`)) return;
        await api(`/api/rooms/${encodeURIComponent(code)}/screens/${s.id}`, { method: 'DELETE' });
        await loadScreens();
      });
      els.screens.appendChild(row);
    }
  } catch { /* не владелец */ }
}

els.input.addEventListener('change', () => { const f = els.input.files && els.input.files[0]; if (f) void onPhoto(f); });
els.retake.addEventListener('click', () => { captured = null; els.send.hidden = true; document.getElementById('s-shoot').hidden = false; });
els.sendBtn.addEventListener('click', () => void sendLeaf());
els.loginBtn.addEventListener('click', () => void login());
els.pairBtn.addEventListener('click', () => void pair());
try { els.name.value = localStorage.getItem('ls_name') || ''; } catch { /* приватный режим */ }
void loadRoom();
