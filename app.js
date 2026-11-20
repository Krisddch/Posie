/* Posie — a soft, infinite pin board.
 * The main board holds unsorted ideas. Every album is a board of its own, with the same rules:
 * it opens over the softly blurred main board, can be panned and zoomed, and holds pins and albums.
 * Everything lives in the browser (IndexedDB), so it works offline with no account;
 * sync.js mirrors it to the cloud after signing in. No build step.
 */
(() => {
  'use strict';

  const $id = (s) => document.getElementById(s);
  const boardEl = $id('board');
  const albumEl = $id('albumBoard');
  const hint = $id('hint');
  const picker = $id('picker');
  const modal = $id('modal');
  const menu = $id('menu');
  const accountModal = $id('account');

  // album colors + a deeper shade of each, for the back of the folder
  const PALETTE = [
    { name: 'sky', hex: '#75A1EE', deep: '#4E7FDB' },
    { name: 'butter', hex: '#FDE575', deep: '#EDC63C' },
    { name: 'blossom', hex: '#F890C5', deep: '#E466A6' },
    { name: 'cocoa', hex: '#733D20', deep: '#552A14' },
  ];
  const shade = (hex) => PALETTE.find((p) => p.hex.toLowerCase() === String(hex).toLowerCase())?.deep || hex;
  const MAGNETS = ['#efe2cf', '#1f3a7a', '#cdb0bd', '#5b2a52', '#a3201c', '#f4ecd9', '#f2cd2e', '#a9bfc4', '#c89a74'];
  const NOTE_COLORS = ['#fff1bf', '#fde0d8', '#e2ebd3', '#dce7f1', '#ede0f2'];
  const WIDTH = { image: 220, note: 210, album: 172 };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const isHttp = (s) => /^https?:\/\/\S+$/i.test(s || '');
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const hash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  const isDark = (hex) => {
    const n = parseInt(String(hex).slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.45;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  /* ---------------- storage (IndexedDB) ---------------- */
  const db = (() => {
    let opening;
    const open = () => opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('posie', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const run = (mode, fn) => open().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction('items', mode);
      const req = fn(tx.objectStore('items'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    }));
    return {
      all: () => run('readonly', (s) => s.getAll()),
      put: (item) => run('readwrite', (s) => s.put(item)).catch((e) => console.warn('posie: save failed', e)),
      del: (id) => run('readwrite', (s) => s.delete(id)).catch(() => {}),
    };
  })();

  /* ---------------- data + change feed (used by sync.js) ---------------- */
  const items = new Map();   // id -> item (pins and albums, on every board)
  const urls = new Map();    // id -> { blob, url }
  const changeFns = new Set();
  const tombs = new Set(JSON.parse(store.get('posie.tombs') || '[]'));
  const saveTombs = () => store.set('posie.tombs', JSON.stringify([...tombs]));
  const emit = (kind, id) => changeFns.forEach((fn) => { try { fn(kind, id); } catch (e) { console.warn(e); } });

  function persist(item) {
    item.updatedAt = Date.now();
    db.put(item);
    emit('put', item.id);
  }

  // which board an item lives on: an album id, or null for the main board
  const boardOf = (item) => (item.album && items.has(item.album) ? item.album : null);
  const childrenOf = (albumId) => [...items.values()]
    .filter((i) => i.album === albumId)
    .sort((a, b) => (b.addedAt || b.createdAt) - (a.addedAt || a.createdAt));

  function srcOf(item) {
    if (item.blob) {
      let u = urls.get(item.id);
      if (!u || u.blob !== item.blob) {
        if (u) URL.revokeObjectURL(u.url);
        u = { blob: item.blob, url: URL.createObjectURL(item.blob) };
        urls.set(item.id, u);
      }
      return u.url;
    }
    return item.src || '';
  }

  /* ---------------- theme ---------------- */
  const root = document.documentElement;
  const setTheme = (t) => { root.dataset.theme = t; store.set('posie.theme', t); };
  $id('themeDot').addEventListener('click', () => setTheme(root.dataset.theme === 'metal' ? 'linen' : 'metal'));

  /* ---------------- boards (surfaces) ----------------
   * `main` shows the main board. `sub` shows whichever album is open (boardId), on top of it.
   */
  const makeSurface = (el, boardId) => ({
    el, boardId,
    world: el.querySelector('.world'),
    views: new Map(),
    cam: { x: 0, y: 0, scale: 1 },
    pointers: new Map(), pan: null, pinch: null, lastTap: { t: 0, x: 0, y: 0 },
    camTimer: null,
  });
  const main = makeSurface(boardEl, null);
  const sub = makeSurface(albumEl, undefined);
  const surfaces = [main, sub];
  const activeSurface = () => (sub.boardId ? sub : main);
  let albumStack = [];   // parents of the open album, for nested albums

  let origin = { x: 0, y: 0 };   // both boards share the same inset on the wall
  const measure = () => { const r = boardEl.getBoundingClientRect(); origin = { x: r.left, y: r.top }; };
  measure();
  window.addEventListener('resize', measure);
  const local = (cx, cy) => ({ x: cx - origin.x, y: cy - origin.y });

  const camKey = (id) => (id ? `posie.cam:${id}` : 'posie.cam');
  function loadCam(id) {
    try {
      const c = JSON.parse(store.get(camKey(id)));
      if (c && [c.x, c.y, c.scale].every(Number.isFinite)) return c;
    } catch {}
    return { x: boardEl.clientWidth / 2, y: boardEl.clientHeight / 2 + (id ? 40 : 0), scale: 1 };
  }
  function applyCam(S) {
    S.world.style.transform = `translate(${S.cam.x}px, ${S.cam.y}px) scale(${S.cam.scale})`;
    // the texture travels and scales with the board, so it reads as one endless surface
    S.el.style.setProperty('--bx', `${S.cam.x}px`);
    S.el.style.setProperty('--by', `${S.cam.y}px`);
    S.el.style.setProperty('--z', S.cam.scale);
    if (S === sub && !S.boardId) return;
    clearTimeout(S.camTimer);
    const key = camKey(S.boardId);
    const snap = JSON.stringify(S.cam);
    S.camTimer = setTimeout(() => store.set(key, snap), 300);
  }
  const clampScale = (s) => Math.min(3, Math.max(0.15, s));
  function zoomAt(S, cx, cy, factor) {
    const { x: px, y: py } = local(cx, cy);
    const s = clampScale(S.cam.scale * factor);
    const k = s / S.cam.scale;
    S.cam.x = px - (px - S.cam.x) * k;
    S.cam.y = py - (py - S.cam.y) * k;
    S.cam.scale = s;
    applyCam(S);
  }
  const toWorld = (S, cx, cy) => { const p = local(cx, cy); return { x: (p.x - S.cam.x) / S.cam.scale, y: (p.y - S.cam.y) / S.cam.scale }; };

  /* ---------------- building cards ---------------- */
  let topZ = 1;

  function decorate(el, item) {
    if (item.type === 'album') return;   // folders stand on their own: no tape, no magnet
    if (item.tape && item.type === 'image') {
      const t = document.createElement('i');
      t.className = 'tape';
      el.append(t);
    }
    const h = hash(item.id);
    const m = document.createElement('i');
    m.className = 'magnet';
    m.style.setProperty('--m', MAGNETS[h % MAGNETS.length]);
    m.style.setProperty('--mx', `${((h >> 4) % 41) - 20}px`);
    el.append(m);
  }

  function setCaption(el, item) {
    let cap = el.querySelector(':scope > .cap');
    const text = item.title || (item.type === 'note' && item.link && !item.text ? hostOf(item.link) : '');
    if (!text) { cap?.remove(); return; }
    if (!cap) { cap = document.createElement('div'); cap.className = 'cap'; el.append(cap); }
    cap.textContent = text;
  }

  // a real folder: back with a tab, papers tucked inside at slightly different angles,
  // and a front with a thumb cut on the right through which you see what's inside
  function fillAlbum(el, item) {
    const color = item.color || PALETTE[0].hex;
    el.style.setProperty('--c', color);
    el.style.setProperty('--deep', shade(color));
    el.classList.toggle('dark', isDark(color));
    const kids = childrenOf(item.id);
    el.querySelectorAll(':scope > .folder-back, :scope > .papers, :scope > .folder').forEach((n) => n.remove());

    const back = document.createElement('div');
    back.className = 'folder-back';

    const papers = document.createElement('div');
    papers.className = 'papers';
    const shown = kids.slice(0, 3).reverse();
    const h = hash(item.id);
    shown.forEach((k, i) => {
      const p = document.createElement('div');
      p.className = 'paper';
      const tilt = [-2.6, 1.8, -1, 2.8][(h + i) % 4] + (i - 1) * 0.5;
      p.style.rotate = `${tilt}deg`;
      p.style.translate = `${((h >> (i + 2)) % 5) - 2}px ${i * -2}px`;
      if (k.type === 'image') {
        const im = new Image();
        im.draggable = false;
        im.src = srcOf(k);
        p.append(im);
      } else {
        p.style.background = k.color || NOTE_COLORS[0];
      }
      papers.append(p);
    });

    const front = document.createElement('div');
    front.className = 'folder';
    front.innerHTML = '<span class="album-count"></span><div class="album-name"></div><div class="album-desc"></div>';
    front.querySelector('.album-count').textContent = kids.length ? String(kids.length) : '';
    const name = front.querySelector('.album-name');
    name.textContent = item.title || 'untitled';
    name.classList.toggle('empty', !item.title);
    front.querySelector('.album-desc').textContent = item.note || '';

    el.prepend(back, papers, front);
  }

  function buildCard(item, S) {
    const el = document.createElement('div');
    el.className = `card ${item.type}`;
    el.dataset.id = item.id;
    el.style.width = `${item.w}px`;
    el.style.zIndex = item.z;
    el.style.setProperty('--r', `${item.type === 'album' ? 0 : item.rot}deg`);
    el.style.translate = `${item.x}px ${item.y}px`;

    if (item.type === 'image') {
      const img = new Image();
      img.draggable = false;
      img.decoding = 'async';
      img.alt = item.title || '';
      if (item.iw && item.ih) img.style.aspectRatio = `${item.iw} / ${item.ih}`;
      img.onerror = () => el.classList.add('broken');
      const src = srcOf(item);
      if (!src) el.classList.add('broken'); else img.src = src;
      el.append(img);
    } else if (item.type === 'note') {
      el.style.background = item.color;
      const t = document.createElement('div');
      t.className = 'note-text';
      t.textContent = item.text || '';
      el.append(t);
    } else if (item.type === 'album') {
      fillAlbum(el, item);
      if (sub.boardId === item.id || albumStack.includes(item.id)) el.classList.add('opening');
    }
    decorate(el, item);
    if (item.type !== 'album') setCaption(el, item);
    attachDrag(el, item.id, S);
    return el;
  }

  // (re)draw an item on whichever board shows it, and remove it from boards that don't
  function render(id) {
    const item = items.get(id);
    for (const S of surfaces) {
      const old = S.views.get(id);
      const wanted = item && (S === main ? boardOf(item) === null : Boolean(S.boardId) && boardOf(item) === S.boardId);
      if (!wanted) {
        if (old) { old.remove(); S.views.delete(id); }
        continue;
      }
      const el = buildCard(item, S);
      if (old) old.replaceWith(el); else S.world.append(el);
      S.views.set(id, el);
    }
  }
  const viewOf = (id) => main.views.get(id) || sub.views.get(id);

  const flash = (id, cls, ms = 450) => {
    const el = viewOf(id);
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  };
  const abEmpty = albumEl.querySelector('.ab-empty');
  function updateHint() {
    hint.hidden = Boolean(sub.boardId) || [...items.values()].some((i) => boardOf(i) === null);
    abEmpty.hidden = !sub.boardId || childrenOf(sub.boardId).length > 0;
  }

  /* ---------------- placing things inside albums ---------------- */
  // a loose grid around the album board's centre
  function placeInAlbum(item, albumId) {
    const n = childrenOf(albumId).filter((k) => k.id !== item.id && k.ap).length;
    const col = n % 4;
    const row = Math.floor(n / 4);
    item.x = Math.round(-470 + col * 250 + rand(-14, 14));
    item.y = Math.round(-170 + row * 300 + rand(-14, 14));
    item.ap = 1;
  }
  function layoutLoose(albumId) {
    childrenOf(albumId).reverse().filter((k) => !k.ap).forEach((k) => { placeInAlbum(k, albumId); persist(k); });
  }

  /* ---------------- creating & removing ---------------- */
  function create(data, at) {
    const type = data.type;
    const w = WIDTH[type];
    const h = type === 'image' ? w * ((data.ih || 5) / (data.iw || 4)) + 14 : type === 'note' ? 170 : 220;
    const item = {
      id: uid(),
      title: '', note: '', link: '', source: '', album: null,
      createdAt: Date.now(),
      w,
      rot: type === 'album' ? 0 : +rand(-4, 4).toFixed(2),
      tape: type === 'image' && Math.random() < 0.45,
      z: ++topZ,
      ...data,
      x: Math.round(at.x - w / 2),
      y: Math.round(at.y - h / 2),
    };
    if (!item.album || !items.has(item.album)) item.album = null;
    if (type === 'note') item.color ??= pick(NOTE_COLORS);
    if (type === 'album') item.color ??= pick(PALETTE).hex;
    if (item.album) {
      item.addedAt = Date.now();
      if (sub.boardId === item.album) item.ap = 1;   // dropped right where you are on the open album
      else placeInAlbum(item, item.album);        // filed into a folder from the outside
    }
    items.set(item.id, item);
    persist(item);
    render(item.id);
    if (item.album) render(item.album);
    if (viewOf(item.id)) flash(item.id, 'pop');
    else if (item.album) flash(item.album, 'bump');
    updateHint();
    return item;
  }

  // leave the open album without animation (it was removed or deleted elsewhere)
  function dropOpenAlbum() {
    if (albumStack.length) { showAlbum(items.get(albumStack.pop()), null); return; }
    albumEl.classList.remove('open');
    sub.boardId = undefined;
    const els = [...sub.views.values()];
    sub.views.clear();
    setTimeout(() => { if (!sub.boardId) { albumEl.hidden = true; els.forEach((e) => e.remove()); } }, 250);
  }

  function removeItem(item) {
    const kids = item.type === 'album' ? childrenOf(item.id) : [];
    if (sub.boardId === item.id) dropOpenAlbum();
    albumStack = albumStack.filter((id) => id !== item.id);

    // an album never takes its contents with it: they go to the board the album was on
    const home = boardOf(item);
    kids.forEach((k, i) => {
      k.album = home;
      k.ap = 0;
      k.x = item.x + 30 + i * 34;
      k.y = item.y + 20 + i * 26;
      k.z = ++topZ;
      persist(k);
    });

    items.delete(item.id);
    db.del(item.id);
    tombs.add(item.id);
    saveTombs();
    emit('del', item.id);
    for (const S of surfaces) {
      const el = S.views.get(item.id);
      if (!el) continue;
      S.views.delete(item.id);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 240);
    }
    kids.forEach((k) => { render(k.id); flash(k.id, 'pop'); });
    if (item.album) render(item.album);
    const u = urls.get(item.id);
    if (u) { setTimeout(() => URL.revokeObjectURL(u.url), 300); urls.delete(item.id); }
    updateHint();
  }

  function putInAlbum(item, albumId) {
    viewOf(item.id)?.classList.add('into');
    setTimeout(() => {
      item.album = albumId;
      item.addedAt = Date.now();
      placeInAlbum(item, albumId);
      item.z = ++topZ;
      persist(item);
      render(item.id);
      render(albumId);
      flash(albumId, 'bump');
      updateHint();
    }, 200);
  }

  // back to the board the album sits on, right next to the folder
  function takeOut(item) {
    const parent = items.get(item.album);
    item.album = parent ? boardOf(parent) : null;
    item.ap = item.album ? 1 : 0;
    if (parent) {
      item.x = Math.round(parent.x + parent.w + 30 + rand(0, 40));
      item.y = Math.round(parent.y + rand(-20, 40));
    }
    item.z = ++topZ;
    persist(item);
    render(item.id);
    if (parent) render(parent.id);
    flash(item.id, 'pop');
    updateHint();
  }

  /* ---------------- adding things ---------------- */
  // A picture is always stored as its own bytes, never as a reference to a file on disk:
  // Safari can lose access to such references later, which left empty (0-byte) pictures.
  async function toMemoryBlob(blob, type) {
    const buf = await blob.arrayBuffer();
    if (!buf.byteLength) throw new Error('empty picture');
    return new Blob([buf], { type: type || blob.type || 'image/jpeg' });
  }
  const loadImg = (url) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  const canvasBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

  async function prepare(input) {
    let blob;
    try { blob = await toMemoryBlob(input); } catch { return null; }
    let source = null;
    let w = 0;
    let h = 0;
    try { source = await createImageBitmap(blob); w = source.width; h = source.height; } catch {}
    let url = null;
    if (!source) {
      url = URL.createObjectURL(blob);
      source = await loadImg(url);
      if (!source) { URL.revokeObjectURL(url); return { blob, w: 4, h: 5 }; }
      w = source.naturalWidth;
      h = source.naturalHeight;
    }
    const MAX = 1600;
    const keep = blob.type === 'image/gif'
      || (Math.max(w, h) <= MAX && blob.size < 1.2e6 && /^image\/(jpeg|png|webp)$/.test(blob.type));
    if (!keep) {
      // keep a reasonably sized copy so the board stays fast and storage stays small
      const k = Math.min(1, MAX / Math.max(w, h));
      const cw = Math.round(w * k);
      const ch = Math.round(h * k);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
      let out = await canvasBlob(canvas, 'image/webp', 0.86);
      if (!out || out.type !== 'image/webp') out = await canvasBlob(canvas, 'image/jpeg', 0.88);   // Safari can't make webp
      if (out && out.size) { blob = out; w = cw; h = ch; }
    }
    source.close?.();
    if (url) URL.revokeObjectURL(url);
    return { blob, w, h };
  }

  async function addImageBlob(blob, at, extra = {}) {
    const p = await prepare(blob);
    if (!p) { toast('couldn’t read that picture. Try saving it first, then add it'); return null; }
    return create({ type: 'image', blob: p.blob, iw: p.w, ih: p.h, ...extra }, at);
  }

  // pictures saved before this fix may be file references: copy them into memory while they're still readable
  async function healPictures() {
    for (const item of items.values()) {
      if (!item.blob) continue;
      try {
        item.blob = await toMemoryBlob(item.blob);
        db.put(item);
      } catch {
        console.warn('posie: picture unreadable on this device', item.id);
        item.blob = null;
        db.put(item);
        render(item.id);
        if (item.album) render(item.album);
      }
    }
  }

  async function addRemoteImage(url, at, extra = {}) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) { await addImageBlob(blob, at, { source: url, ...extra }); return true; }
      }
    } catch {}
    const dims = await new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), 8000);
      img.onload = () => { clearTimeout(timer); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = url;
    });
    if (!dims) return false;
    create({ type: 'image', src: url, iw: dims.w, ih: dims.h, source: url, ...extra }, at);
    return true;
  }

  const addNote = (data, at) => create({ type: 'note', text: '', ...data }, at);
  const offset = (at, i) => ({ x: at.x + i * 38, y: at.y + i * 30 });

  async function ingest(dt, at, extra = {}) {
    let files = [...(dt.files || [])];
    if (!files.length && dt.items) files = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    files = files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|avif|webp)$/i.test(f.name || ''));
    const html = dt.getData('text/html') || '';
    const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#')) || '';
    const text = (dt.getData('text/plain') || '').trim();

    let imgUrl = '';
    let pageUrl = '';
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      imgUrl = doc.querySelector('img')?.getAttribute('src') || '';
      pageUrl = doc.querySelector('a[href]')?.getAttribute('href') || '';
    }
    if (!isHttp(imgUrl)) imgUrl = '';
    if (!isHttp(pageUrl)) pageUrl = '';

    if (files.length) {
      for (let i = 0; i < files.length; i++) {
        await addImageBlob(files[i], offset(at, i), { link: pageUrl, source: imgUrl, ...extra });
      }
      return;
    }
    const url = imgUrl || (isHttp(uri) ? uri : '') || (isHttp(text) ? text : '');
    if (url) {
      const ok = await addRemoteImage(url, at, { link: pageUrl, ...extra });
      if (!ok) addNote({ link: url, ...extra }, at);
      return;
    }
    if (text) addNote({ text, ...extra }, at);
  }

  // the folder under a point, on the given board only
  const albumAt = (S, cx, cy, skipId) => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const c = el.closest?.('.card.album');
      if (c && c.dataset.id !== skipId && S.el.contains(c)) return c.dataset.id;
    }
    return null;
  };

  /* drag & drop from desktop / other tabs: onto the board you're on, or into a folder */
  let dropTarget = null;
  const setDropTarget = (id) => {
    if (id === dropTarget) return;
    viewOf(dropTarget)?.classList.remove('drop-target');
    dropTarget = id;
    viewOf(id)?.classList.add('drop-target');
  };
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!modal.hidden) return;
    const S = activeSurface();
    S.el.classList.add('dropping');
    setDropTarget(albumAt(S, e.clientX, e.clientY));
  });
  const clearDropping = () => { main.el.classList.remove('dropping'); sub.el.classList.remove('dropping'); setDropTarget(null); };
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearDropping(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDropping();
    if (!modal.hidden || !e.dataTransfer) return;
    const S = activeSurface();
    const folder = albumAt(S, e.clientX, e.clientY);
    ingest(e.dataTransfer, toWorld(S, e.clientX, e.clientY), { album: folder || S.boardId || null });
  });

  window.addEventListener('paste', (e) => {
    if (!modal.hidden || !accountModal.hidden || e.target.closest?.('input, textarea')) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    const S = activeSurface();
    ingest(e.clipboardData, toWorld(S, innerWidth / 2 + rand(-50, 50), innerHeight / 2 + rand(-40, 40)), { album: S.boardId || null });
  });

  /* ---------------- double-tap menu ---------------- */
  let menuAt = { x: 0, y: 0 };
  let menuBoard = null;
  function openMenu(S, cx, cy) {
    menuAt = toWorld(S, cx, cy);
    menuBoard = S.boardId || null;
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(cx, innerWidth - w - 12)}px`;
    menu.style.top = `${Math.min(cy, innerHeight - h - 12)}px`;
  }
  const closeMenu = () => { menu.hidden = true; };
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === 'picture') openPicker(menuAt, menuBoard);
    if (act === 'paste') pasteFromClipboard(menuAt, menuBoard);
    if (act === 'album') {
      const a = create({ type: 'album', album: menuBoard }, menuAt);
      openSheet(a, { focusTitle: true });
    }
  });
  window.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });

  async function pasteFromClipboard(at, boardId) {
    const extra = { album: boardId };
    const textOnly = (text) => ({ files: [], items: null, getData: (t) => (t === 'text/plain' ? text : '') });
    try {
      if (navigator.clipboard?.read) {
        const list = await navigator.clipboard.read();
        let i = 0;
        for (const entry of list) {
          const type = entry.types.find((t) => t.startsWith('image/'));
          if (type) { await addImageBlob(await entry.getType(type), offset(at, i++), extra); continue; }
          if (entry.types.includes('text/plain')) {
            const text = await (await entry.getType('text/plain')).text();
            if (text.trim()) { await ingest(textOnly(text), offset(at, i++), extra); }
          }
        }
        if (!i) toast('nothing to paste yet. Copy a picture or a link first');
        return;
      }
      const text = await navigator.clipboard?.readText?.();
      if (text?.trim()) ingest(textOnly(text), at, extra);
      else toast('nothing to paste yet. Copy a picture or a link first');
    } catch (e) {
      console.warn('posie: clipboard', e);
      toast('allow “Paste” when your browser asks, or press ⌘V');
    }
  }

  let pickAt = { x: 0, y: 0 };
  let pickBoard = null;
  function openPicker(at, boardId) {
    pickAt = at;
    pickBoard = boardId;
    picker.value = '';
    picker.click();
  }
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    for (let i = 0; i < files.length; i++) await addImageBlob(files[i], offset(pickAt, i), { album: pickBoard });
  });

  /* ---------------- moving pins ---------------- */
  function attachDrag(el, id, S) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const item = items.get(id);
      if (!item) return;
      e.stopPropagation();
      closeMenu();
      el.setPointerCapture(e.pointerId);
      item.z = ++topZ;
      el.style.zIndex = item.z;

      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y };
      let moved = false;
      let target = null;

      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        if (!moved) { moved = true; el.classList.add('lifted'); }
        item.x = Math.round(start.ix + dx / S.cam.scale);
        item.y = Math.round(start.iy + dy / S.cam.scale);
        el.style.translate = `${item.x}px ${item.y}px`;
        const t = albumAt(S, ev.clientX, ev.clientY, id);
        if (t !== target) {
          viewOf(target)?.classList.remove('drop-target');
          target = t;
          viewOf(t)?.classList.add('drop-target');
        }
      };
      const end = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        el.classList.remove('lifted');
        if (target) {
          viewOf(target)?.classList.remove('drop-target');
          if (ev.type === 'pointerup' && items.has(target)) { putInAlbum(item, target); return; }
        }
        if (moved) persist(item);
        else if (ev.type === 'pointerup' && items.has(id)) (item.type === 'album' ? openAlbum(item) : openSheet(item));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }

  /* ---------------- moving a board (same rules for the main board and albums) ---------------- */
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function bindSurface(S) {
    const el = S.el;
    const ignore = (t) => t.closest('.card, .ab-head, .ab-foot');

    // a slide keeps gliding after you let go, slowing down naturally
    let samples = [];
    let glide = 0;
    const stopGlide = () => { cancelAnimationFrame(glide); glide = 0; };
    function startGlide() {
      const now = performance.now();
      const recent = samples.filter((p) => now - p.t < 90);
      samples = [];
      if (recent.length < 2) return;
      const a = recent[0];
      const z = recent[recent.length - 1];
      const dt = Math.max(z.t - a.t, 8);
      let vx = (z.x - a.x) / dt;   // px per ms
      let vy = (z.y - a.y) / dt;
      if (Math.hypot(vx, vy) < 0.12) return;
      let last = now;
      const step = (t) => {
        const ms = Math.min(t - last, 32);
        last = t;
        S.cam.x += vx * ms;
        S.cam.y += vy * ms;
        applyCam(S);
        const k = Math.pow(0.95, ms / 16.7);   // gentle friction
        vx *= k;
        vy *= k;
        glide = Math.hypot(vx, vy) > 0.01 ? requestAnimationFrame(step) : 0;
      };
      glide = requestAnimationFrame(step);
    }

    const startPan = (p) => { S.pan = { sx: p.x, sy: p.y, cx: S.cam.x, cy: S.cam.y, moved: false }; samples = [{ t: performance.now(), ...p }]; };
    let tapTimer = null;

    el.addEventListener('pointerdown', (e) => {
      stopGlide();
      if (ignore(e.target) || e.button > 0) return;
      el.setPointerCapture(e.pointerId);
      S.pointers.set(e.pointerId, local(e.clientX, e.clientY));
      if (S.pointers.size === 1) startPan(local(e.clientX, e.clientY));
      else if (S.pointers.size === 2) {
        const [a, b] = [...S.pointers.values()];
        S.pinch = { d: dist(a, b) || 1, s: S.cam.scale, m: mid(a, b), cx: S.cam.x, cy: S.cam.y };
        S.pan = null;
        samples = [];
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!S.pointers.has(e.pointerId)) return;
      const lp = local(e.clientX, e.clientY);
      S.pointers.set(e.pointerId, lp);
      if (S.pinch && S.pointers.size >= 2) {
        const [a, b] = [...S.pointers.values()];
        const m = mid(a, b);
        const s = clampScale(S.pinch.s * dist(a, b) / S.pinch.d);
        const wx = (S.pinch.m.x - S.pinch.cx) / S.pinch.s;
        const wy = (S.pinch.m.y - S.pinch.cy) / S.pinch.s;
        S.cam.x = m.x - wx * s;
        S.cam.y = m.y - wy * s;
        S.cam.scale = s;
        applyCam(S);
      } else if (S.pan) {
        const dx = lp.x - S.pan.sx;
        const dy = lp.y - S.pan.sy;
        if (!S.pan.moved && Math.hypot(dx, dy) > 4) { S.pan.moved = true; el.classList.add('panning'); }
        if (S.pan.moved) {
          S.cam.x = S.pan.cx + dx;
          S.cam.y = S.pan.cy + dy;
          applyCam(S);
          samples.push({ t: performance.now(), x: lp.x, y: lp.y });
          if (samples.length > 8) samples.shift();
        }
      }
    });
    const endPointer = (e) => {
      if (!S.pointers.has(e.pointerId)) return;
      const wasTap = S.pan && !S.pan.moved && !S.pinch && S.pointers.size === 1 && e.type === 'pointerup';
      const wasSlide = S.pan && S.pan.moved && S.pointers.size === 1 && e.type === 'pointerup';
      S.pointers.delete(e.pointerId);
      if (S.pointers.size < 2) S.pinch = null;
      if (S.pointers.size === 1) startPan([...S.pointers.values()][0]);
      if (S.pointers.size === 0) { S.pan = null; el.classList.remove('panning'); }
      if (wasSlide) startGlide();
      if (wasTap) {
        const now = performance.now();
        if (now - S.lastTap.t < 350 && Math.hypot(e.clientX - S.lastTap.x, e.clientY - S.lastTap.y) < 30) {
          S.lastTap.t = 0;
          clearTimeout(tapTimer);
          openMenu(S, e.clientX, e.clientY);
        } else {
          S.lastTap = { t: now, x: e.clientX, y: e.clientY };
          // on an album board, a single tap on empty space steps back out of the album
          if (S === sub) {
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => { if (S.lastTap.t === now && menu.hidden) closeAlbum(); }, 360);
          }
        }
      }
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    el.addEventListener('contextmenu', (e) => {
      if (ignore(e.target)) return;
      e.preventDefault();
      clearTimeout(tapTimer);
      openMenu(S, e.clientX, e.clientY);
    });
    el.addEventListener('wheel', (e) => {
      if (e.target.closest('.ab-head')) return;
      e.preventDefault();
      stopGlide();
      closeMenu();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(S, e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else {
        const unit = e.deltaMode === 1 ? 16 : 1;
        S.cam.x -= e.deltaX * unit;
        S.cam.y -= e.deltaY * unit;
        applyCam(S);
      }
    }, { passive: false });
    let gestureScale = 1;
    el.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
    el.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (S.pointers.size) return;
      zoomAt(S, e.clientX, e.clientY, e.scale / gestureScale);
      gestureScale = e.scale;
    });
    S.stopGlide = stopGlide;
  }

  /* ---------------- an open album: a board of its own ---------------- */
  const abTitle = albumEl.querySelector('.av-title');
  const abDesc = albumEl.querySelector('.av-desc');
  const abColors = albumEl.querySelector('.av-colors');
  const abDot = albumEl.querySelector('.av-dot');
  const abOptions = albumEl.querySelector('.av-options');
  const abBack = albumEl.querySelector('.ab-back');
  const abRemove = albumEl.querySelector('.av-remove');
  let abSave = null;
  let closeTimer = null;

  PALETTE.forEach((p, k) => {
    const b = document.createElement('button');
    b.className = 'av-opt';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', p.name);
    b.style.setProperty('--s', p.hex);
    b.style.setProperty('--k', k);
    b.dataset.hex = p.hex;
    abOptions.append(b);
  });

  // the name field hugs its text so the tiny color circle sits right next to it
  const measureCtx = document.createElement('canvas').getContext('2d');
  function sizeTitle() {
    measureCtx.font = getComputedStyle(abTitle).font;
    const w = measureCtx.measureText(abTitle.value || abTitle.placeholder).width;
    abTitle.style.width = `${Math.ceil(Math.min(w + 6, innerWidth * 0.6))}px`;
  }
  function setDot(color) {
    abDot.style.setProperty('--s', color);
    abOptions.querySelectorAll('.av-opt').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.hex === color)));
  }
  function fillHead(a) {
    abTitle.value = a.title || '';
    abDesc.value = a.note || '';
    sizeTitle();
    setDot(a.color);
    abColors.classList.remove('open');
    delete abRemove.dataset.armed;
    abRemove.textContent = 'remove album';
    const parent = albumStack.length ? items.get(albumStack[albumStack.length - 1]) : null;
    abBack.textContent = `← ${parent ? parent.title || 'untitled' : 'all ideas'}`;
    albumEl.style.setProperty('--c', a.color);
  }

  function showAlbum(album, from) {
    clearTimeout(closeTimer);
    sub.stopGlide?.();
    sub.views.forEach((el) => el.remove());
    sub.views.clear();
    sub.boardId = album.id;
    sub.cam = loadCam(album.id);
    layoutLoose(album.id);
    albumEl.hidden = false;
    fillHead(album);
    applyCam(sub);
    childrenOf(album.id).sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((k) => render(k.id));
    render(album.id);   // dims the folder on the board behind
    updateHint();

    // the contents flow out of the folder onto their own board
    if (from) {
      [...sub.views.values()].forEach((el, i) => {
        const c = centerOf(el);
        const dx = (from.x - c.x) / sub.cam.scale;
        const dy = (from.y - c.y) / sub.cam.scale;
        el.animate([
          { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: 0 },
          { opacity: 1, offset: 0.3 },
          { transform: 'none', opacity: 1 },
        ], { duration: 560, delay: Math.min(i * 45, 450), easing: 'cubic-bezier(.2, 1.25, .35, 1)', fill: 'backwards' });
      });
    }
    requestAnimationFrame(() => albumEl.classList.add('open'));
  }

  function openAlbum(album) {
    closeMenu();
    flushHead();
    const fromEl = viewOf(album.id);
    const from = fromEl ? centerOf(fromEl) : null;
    if (sub.boardId) albumStack.push(sub.boardId); else albumStack = [];
    showAlbum(album, from);
  }

  function closeAlbum() {
    if (!sub.boardId) return;
    flushHead();
    abColors.classList.remove('open');
    const id = sub.boardId;
    if (albumStack.length) {          // nested: step back up one level
      showAlbum(items.get(albumStack.pop()), null);
      flash(id, 'bump');
      return;
    }
    const folder = main.views.get(id);
    const to = folder ? centerOf(folder) : null;
    const els = [...sub.views.values()];
    if (to) {
      els.forEach((el, i) => {
        const c = centerOf(el);
        const dx = (to.x - c.x) / sub.cam.scale;
        const dy = (to.y - c.y) / sub.cam.scale;
        el.animate([
          { transform: 'none', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: 0 },
        ], { duration: 320, delay: Math.min((els.length - 1 - i) * 22, 220), easing: 'cubic-bezier(.5, 0, .75, 0)', fill: 'forwards' });
      });
    }
    albumEl.classList.remove('open');
    sub.boardId = undefined;
    sub.views.clear();
    closeTimer = setTimeout(() => {
      albumEl.hidden = true;
      els.forEach((el) => el.remove());
      render(id);
      flash(id, 'bump');
      updateHint();
    }, to && els.length ? 380 : 260);
  }

  function headChanged() {
    const a = items.get(sub.boardId);
    if (!a) return;
    render(a.id);
    clearTimeout(abSave);
    abSave = setTimeout(() => { abSave = null; persist(a); }, 400);
  }
  function flushHead() {
    if (!abSave) return;
    clearTimeout(abSave);
    abSave = null;
    const a = items.get(sub.boardId);
    if (a) persist(a);
  }
  abTitle.addEventListener('input', () => { const a = items.get(sub.boardId); if (!a) return; a.title = abTitle.value; sizeTitle(); headChanged(); });
  abDesc.addEventListener('input', () => { const a = items.get(sub.boardId); if (!a) return; a.note = abDesc.value; headChanged(); });
  abTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); abDesc.focus(); } });
  abDesc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); abDesc.blur(); } });

  // the tiny circle pulls out the palette
  abDot.addEventListener('click', () => abColors.classList.toggle('open'));
  abOptions.addEventListener('click', (e) => {
    const o = e.target.closest('.av-opt');
    const a = items.get(sub.boardId);
    if (!o || !a) return;
    a.color = o.dataset.hex;
    setDot(a.color);
    albumEl.style.setProperty('--c', a.color);
    render(a.id);
    persist(a);
    setTimeout(() => abColors.classList.remove('open'), 220);
  });
  albumEl.addEventListener('pointerdown', (e) => { if (!abColors.contains(e.target)) abColors.classList.remove('open'); }, true);

  const onKeyActivate = (el, fn) => {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  };
  onKeyActivate(abBack, closeAlbum);
  onKeyActivate(abRemove, () => {
    if (!abRemove.dataset.armed) {
      abRemove.dataset.armed = '1';
      abRemove.textContent = 'tap again — pins go back to the board';
      return;
    }
    const a = items.get(sub.boardId);
    flushHead();
    if (a) removeItem(a);
  });

  /* ---------------- the pop-up (a pin, or a new album) ---------------- */
  const $ = (s) => modal.querySelector(s);
  const media = $('.sheet-media');
  const fBack = $('.f-back');
  const fTitle = $('.f-title');
  const fNote = $('.f-note');
  const fSwatches = $('.f-swatches');
  const fLinkRow = $('.f-link-row');
  const fLink = $('.f-link');
  const fVisit = $('.f-visit');
  const fDate = $('.f-date');
  const fOut = $('.f-out');
  const fRemove = $('.f-remove');
  let current = null;
  let saveTimer = null;
  let hideTimer = null;
  let preview = null;   // live folder preview while creating an album

  const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  PALETTE.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', p.name);
    b.style.setProperty('--s', p.hex);
    b.dataset.hex = p.hex;
    fSwatches.append(b);
  });

  function normalizeUrl(v) {
    v = v.trim();
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && v.includes('.')) v = `https://${v}`;
    try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
  }

  function updateVisit() {
    const target = current.link || current.source;
    fVisit.hidden = !target;
    if (!target) return;
    fVisit.href = target;
    fVisit.textContent = `${current.link ? 'visit' : 'found on'} ${hostOf(target)} ↗`;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    const item = current;
    saveTimer = setTimeout(() => { saveTimer = null; persist(item); }, 400);
  }
  function flushSave() {
    if (saveTimer && current) { clearTimeout(saveTimer); saveTimer = null; persist(current); }
  }

  // reflect edits on the board without rebuilding the image
  function reflect(item) {
    if (item.type === 'album') { render(item.id); if (preview) fillAlbum(preview, item); return; }
    const el = viewOf(item.id);
    if (el) {
      if (item.type === 'note') el.querySelector('.note-text').textContent = item.text || '';
      setCaption(el, item);
    }
    if (item.album) render(item.album);
  }

  function openSheet(item, { focusTitle = false } = {}) {
    flushSave();
    clearTimeout(hideTimer);
    current = item;
    const isAlbum = item.type === 'album';
    media.replaceChildren();
    media.classList.toggle('album-media', isAlbum);
    preview = null;

    if (isAlbum) {
      media.style.setProperty('--c', item.color);
      const wrap = document.createElement('div');
      wrap.className = 'album-preview';
      preview = document.createElement('div');
      preview.className = 'card album';
      preview.style.width = `${WIDTH.album}px`;
      fillAlbum(preview, item);
      wrap.append(preview);
      media.append(wrap);
    } else if (item.type === 'image') {
      const img = new Image();
      img.alt = item.title || '';
      img.src = srcOf(item);
      media.append(img);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'f-text';
      ta.value = item.text || '';
      ta.placeholder = 'write something…';
      ta.style.background = item.color;
      ta.addEventListener('input', () => { item.text = ta.value; reflect(item); scheduleSave(); });
      media.append(ta);
    }

    fBack.hidden = true;
    fTitle.placeholder = isAlbum ? 'album name' : 'give it a name…';
    fNote.placeholder = isAlbum ? 'a short description' : "why do you love it? what's the plan?";
    fTitle.value = item.title || '';
    fNote.value = item.note || '';
    // colors are offered while creating; later they live behind the tiny circle on the album board
    fSwatches.hidden = !isAlbum;
    fSwatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.hex === item.color)));
    fLinkRow.hidden = isAlbum;
    fLink.value = item.link || '';
    if (!isAlbum) updateVisit();
    fOut.hidden = !(item.album && items.has(item.album));
    fDate.textContent = `${isAlbum ? 'made' : 'added'} ${fmtDate(item.createdAt)}`;
    delete fRemove.dataset.armed;
    fRemove.textContent = 'remove';

    modal.hidden = false;
    autosize(fNote);
    requestAnimationFrame(() => modal.classList.add('open'));
    if (focusTitle) setTimeout(() => fTitle.focus(), 60);
  }

  function closeSheet() {
    if (!current) return;
    flushSave();
    current = null;
    preview = null;
    modal.classList.remove('open');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { modal.hidden = true; media.replaceChildren(); }, 200);
  }

  fTitle.addEventListener('input', () => { current.title = fTitle.value; reflect(current); scheduleSave(); });
  fNote.addEventListener('input', () => { current.note = fNote.value; autosize(fNote); if (current.type === 'album') reflect(current); scheduleSave(); });
  fLink.addEventListener('input', () => { current.link = normalizeUrl(fLink.value); updateVisit(); reflect(current); scheduleSave(); });
  fTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fNote.focus(); } });
  fSwatches.addEventListener('click', (e) => {
    const s = e.target.closest('.swatch');
    if (!s || !current) return;
    current.color = s.dataset.hex;
    fSwatches.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-checked', String(x === s)));
    media.style.setProperty('--c', current.color);
    reflect(current);
    persist(current);
  });

  onKeyActivate(fOut, () => {
    const item = current;
    takeOut(item);
    closeSheet();
  });
  onKeyActivate(fRemove, () => {
    if (!fRemove.dataset.armed) {
      fRemove.dataset.armed = '1';
      fRemove.textContent = current.type === 'album' ? 'tap again — pins go back to the board' : 'tap again to remove';
      return;
    }
    const item = current;
    flushSave();
    removeItem(item);
    closeSheet();
  });

  let downOnBackdrop = false;
  modal.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === modal; });
  modal.addEventListener('click', (e) => { if (downOnBackdrop && e.target === modal) closeSheet(); });

  /* ---------------- account sheet ---------------- */
  const acct = accountModal.querySelector('.acct');
  const APPLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.37 1.43c0 1.14-.49 2.27-1.18 3.08-.74.9-1.99 1.57-2.99 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.57-2.27 1.21-2.98.8-.94 2.14-1.64 3.25-1.68.03.13.05.28.05.43zm4.56 15.71c-.03.07-.46 1.58-1.52 3.12-.94 1.34-1.94 2.71-3.43 2.71-1.52 0-1.9-.88-3.63-.88-1.7 0-2.3.91-3.67.91-1.38 0-2.33-1.26-3.43-2.8-1.29-1.82-2.32-4.63-2.32-7.28 0-4.28 2.8-6.55 5.55-6.55 1.45 0 2.68.95 3.6.95.87 0 2.22-1.01 3.9-1.01.61 0 2.89.06 4.37 2.19-.13.09-2.38 1.37-2.38 4.19 0 3.26 2.85 4.42 2.96 4.45z"/></svg>';

  function renderAccount() {
    const acc = window.posie.account;
    const s = acc?.state || { enabled: false };
    if (s.user) {
      const when = s.lastSync ? new Date(s.lastSync).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
      const status = s.status === 'syncing' ? 'syncing…'
        : s.status === 'error' ? "couldn't sync just now — will try again"
          : when ? `synced at ${when}` : 'synced';
      acct.innerHTML = `
        <p class="acct-mark">posie</p>
        <p class="acct-title">your board is synced</p>
        <p class="acct-sub">signed in as <b>${esc(s.user.email || 'your Apple ID')}</b></p>
        <p class="acct-status${s.status === 'error' ? ' error' : ''}">${esc(status)}</p>
        <span class="acct-link" role="button" tabindex="0" data-act="signout">sign out</span>`;
    } else {
      acct.innerHTML = `
        <p class="acct-mark">posie</p>
        <p class="acct-title">keep your board everywhere</p>
        <p class="acct-sub">sign in to sync your pins and albums between your phone and your computer.</p>
        ${s.apple ? `<button class="apple-btn" data-act="signin">${APPLE}<span>Sign in with Apple</span></button><p class="acct-or">or</p>` : ''}
        <form class="acct-email">
          <input type="email" name="email" required autocomplete="email" placeholder="your email" ${s.enabled ? '' : 'disabled'}>
          <button type="submit" ${s.enabled ? '' : 'disabled'}>email me a sign-in link</button>
        </form>
        <p class="acct-note">${s.enabled ? 'no password, just tap the link we send you' : 'sync isn’t connected yet (see SETUP.md)'}</p>`;
    }
  }
  acct.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'signin') window.posie.account?.signIn();
    if (act === 'signout') window.posie.account?.signOut();
  });
  acct.addEventListener('submit', async (e) => {
    if (!e.target.classList.contains('acct-email')) return;
    e.preventDefault();
    const form = e.target;
    const note = acct.querySelector('.acct-note');
    const email = form.email.value.trim();
    if (!email || !window.posie.account?.signInWithEmail) return;
    form.querySelector('button').disabled = true;
    note.textContent = 'sending…';
    const { error } = await window.posie.account.signInWithEmail(email);
    note.textContent = error ? `couldn’t send: ${error}` : `check ${email} and tap the link once, on this device ✉︎`;
    note.classList.toggle('error', Boolean(error));
    form.querySelector('button').disabled = false;
  });
  function openAccount() {
    renderAccount();
    accountModal.hidden = false;
    requestAnimationFrame(() => accountModal.classList.add('open'));
  }
  function closeAccount() {
    accountModal.classList.remove('open');
    setTimeout(() => { accountModal.hidden = true; }, 200);
  }
  $id('wordmark').addEventListener('click', openAccount);
  accountModal.addEventListener('click', (e) => { if (e.target === accountModal) closeAccount(); });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!accountModal.hidden) closeAccount();
    else if (current) closeSheet();
    else if (!menu.hidden) closeMenu();
    else if (e.target.closest?.('input, textarea')) e.target.blur();
    else closeAlbum();
  });

  /* ---------------- toast ---------------- */
  let toastEl = null;
  let toastTimer = null;
  function toast(text) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.append(toastEl); }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  /* ---------------- shared from another app ----------------
   * Posie accepts  ?add=<link>  (iPhone Shortcut) and  ?url=&text=&title=  (Android share sheet).
   * A shared Pinterest pin becomes its picture, titled, with a link back to the pin.
   */
  async function intakeShare() {
    const q = new URLSearchParams(location.search);
    const raw = [q.get('add'), q.get('url'), q.get('text')].filter(Boolean).join(' ');
    const title = (q.get('title') || '').trim();
    if (!raw && !title) return;
    history.replaceState(null, '', location.pathname);   // so a reload doesn't add it twice

    const url = (raw.match(/https?:\/\/\S+/) || [])[0] || '';
    const text = raw.replace(url, '').trim();
    const at = toWorld(main, innerWidth / 2 + rand(-60, 60), innerHeight / 2 + rand(-50, 50));
    toast('adding to your board…');

    if (!url) { addNote({ text: text || title }, at); toast('added to your board ✓'); return; }

    let info = null;
    try { info = await window.posie.unfurl?.(url); } catch (e) { console.warn('posie: link preview failed', e); }
    const page = info?.url || url;
    const name = (title || info?.title || '').slice(0, 120);
    if (info?.image && await addRemoteImage(info.image, at, { link: page, title: name })) { toast('added to your board ✓'); return; }
    if (await addRemoteImage(url, at, { title: name })) { toast('added to your board ✓'); return; }
    addNote({ link: page, title: name, text }, at);
    toast('saved the link to your board ✓');
  }

  /* ---------------- interface for sync.js ---------------- */
  window.posie = {
    account: null,
    all: () => [...items.values()],
    get: (id) => items.get(id),
    onChange: (fn) => changeFns.add(fn),
    tombstones: () => new Set(tombs),
    clearTombstone: (id) => { tombs.delete(id); saveTombs(); },
    accountChanged: () => { if (!accountModal.hidden) renderAccount(); },
    toast: (text) => toast(text),
    // apply a pin/album that changed on another device (no echo back to the cloud)
    applyRemote(item) {
      const prev = items.get(item.id);
      if (!item.blob?.size && prev?.blob?.size) item.blob = prev.blob;   // never trade a good picture for an empty one
      items.set(item.id, item);
      topZ = Math.max(topZ, item.z || 1);
      db.put(item);
      render(item.id);
      if (item.type === 'album') childrenOf(item.id).forEach((k) => render(k.id));
      new Set([prev?.album, item.album].filter(Boolean)).forEach((a) => render(a));
      if (sub.boardId === item.id) fillHead(item);
      updateHint();
    },
    applyRemoteDelete(id) {
      const item = items.get(id);
      if (!item) return;
      if (sub.boardId === id) dropOpenAlbum();
      items.delete(id);
      db.del(id);
      render(id);
      if (item.type === 'album') childrenOf(id).forEach((k) => render(k.id));
      if (item.album) render(item.album);
      if (current?.id === id) closeSheet();
      updateHint();
    },
  };

  /* ---------------- start ---------------- */
  main.cam = loadCam(null);
  applyCam(main);
  bindSurface(main);
  bindSurface(sub);
  db.all()
    .then((list) => {
      list.sort((a, b) => (a.z || 0) - (b.z || 0));
      for (const item of list) { items.set(item.id, item); topZ = Math.max(topZ, item.z || 1); }
      for (const item of list) render(item.id);
    })
    .catch((e) => console.warn('posie: could not load board', e))
    .finally(async () => { await healPictures(); updateHint(); document.dispatchEvent(new Event('posie:ready')); setTimeout(intakeShare, 0); });

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
