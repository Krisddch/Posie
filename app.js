/* Posie — a soft, infinite pin board.
 * Pins and albums live in the browser (IndexedDB) so it works offline with no account.
 * sync.js (optional) mirrors them to the cloud after "Sign in with Apple".
 * No build step: serve this folder with any static server.
 */
(() => {
  'use strict';

  const $id = (s) => document.getElementById(s);
  const board = $id('board');
  const world = $id('world');
  const hint = $id('hint');
  const picker = $id('picker');
  const modal = $id('modal');
  const menu = $id('menu');
  const accountModal = $id('account');

  // album colors + a deeper shade of each for depth (never muddied toward grey)
  const PALETTE = [
    { name: 'sky', hex: '#75A1EE', deep: '#3F6FD0' },
    { name: 'butter', hex: '#FDE575', deep: '#F2C230' },
    { name: 'blossom', hex: '#F890C5', deep: '#E35A9F' },
    { name: 'cocoa', hex: '#733D20', deep: '#4A230F' },
  ];
  const shade = (hex) => PALETTE.find((p) => p.hex.toLowerCase() === String(hex).toLowerCase())?.deep || hex;
  const MAGNETS = ['#efe2cf', '#1f3a7a', '#cdb0bd', '#5b2a52', '#a3201c', '#f4ecd9', '#f2cd2e', '#a9bfc4', '#c89a74'];
  const NOTE_COLORS = ['#fff1bf', '#fde0d8', '#e2ebd3', '#dce7f1', '#ede0f2'];
  const WIDTH = { image: 220, note: 210, album: 180 };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const isHttp = (s) => /^https?:\/\/\S+$/i.test(s || '');
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const hash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  const isDark = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.45;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

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
  const items = new Map();   // id -> item (everything, including pins inside albums)
  const views = new Map();   // id -> element on the board
  const urls = new Map();    // id -> { blob, url }
  const changeFns = new Set();
  let tombs = new Set(JSON.parse(store.get('posie.tombs') || '[]'));
  const saveTombs = () => store.set('posie.tombs', JSON.stringify([...tombs]));
  const emit = (kind, id) => changeFns.forEach((fn) => { try { fn(kind, id); } catch (e) { console.warn(e); } });

  function persist(item) {
    item.updatedAt = Date.now();
    db.put(item);
    emit('put', item.id);
  }

  const childrenOf = (albumId) => [...items.values()]
    .filter((i) => i.album === albumId)
    .sort((a, b) => (b.addedAt || b.createdAt) - (a.addedAt || a.createdAt));
  const onBoard = (item) => !(item.album && items.has(item.album));

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

  /* ---------------- camera ---------------- */
  const cam = (() => {
    try {
      const c = JSON.parse(store.get('posie.cam'));
      if (c && [c.x, c.y, c.scale].every(Number.isFinite)) return c;
    } catch {}
    return { x: board.clientWidth / 2, y: board.clientHeight / 2, scale: 1 };
  })();

  // The board sits inset on the "wall", so screen points are converted to board-local ones.
  let origin = { x: 0, y: 0 };
  const measure = () => { const r = board.getBoundingClientRect(); origin = { x: r.left, y: r.top }; };
  measure();
  window.addEventListener('resize', measure);
  const local = (px, py) => ({ x: px - origin.x, y: py - origin.y });

  let camTimer;
  function applyCam() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`;
    // the texture travels and scales with the board, so it reads as one endless surface
    board.style.setProperty('--bx', `${cam.x}px`);
    board.style.setProperty('--by', `${cam.y}px`);
    board.style.setProperty('--z', cam.scale);
    clearTimeout(camTimer);
    camTimer = setTimeout(() => store.set('posie.cam', JSON.stringify(cam)), 300);
  }
  const clampScale = (s) => Math.min(3, Math.max(0.15, s));
  function zoomAt(cx, cy, factor) {
    const { x: px, y: py } = local(cx, cy);
    const s = clampScale(cam.scale * factor);
    const k = s / cam.scale;
    cam.x = px - (px - cam.x) * k;
    cam.y = py - (py - cam.y) * k;
    cam.scale = s;
    applyCam();
  }
  const toWorld = (cx, cy) => { const p = local(cx, cy); return { x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale }; };

  /* ---------------- building cards ---------------- */
  let topZ = 1;

  function decorate(el, item) {
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
    if (!cap) {
      cap = document.createElement('div');
      cap.className = 'cap';
      el.append(cap);
    }
    cap.textContent = text;
  }

  function fillAlbum(el, item) {
    const color = item.color || PALETTE[0].hex;
    el.style.setProperty('--c', color);
    el.style.setProperty('--deep', shade(color));
    el.classList.toggle('dark', isDark(color));
    const kids = childrenOf(item.id);
    el.querySelector(':scope > .peeks')?.remove();
    el.querySelector(':scope > .folder')?.remove();

    // contents slide out of the right side; the deepest one sticks out the furthest
    const peeks = document.createElement('div');
    peeks.className = 'peeks';
    const shown = kids.slice(0, 3);
    if (!shown.length) {
      const p = document.createElement('div');
      p.className = 'peek blank';
      p.style.setProperty('--i', 0);
      peeks.append(p);
    }
    shown.forEach((k, i) => {
      const p = document.createElement('div');
      p.className = 'peek';
      p.style.setProperty('--i', i);
      p.style.zIndex = 3 - i;
      if (k.type === 'image') {
        const im = new Image();
        im.draggable = false;
        im.src = srcOf(k);
        p.append(im);
      } else {
        p.style.background = k.color || NOTE_COLORS[0];
      }
      peeks.append(p);
    });

    const folder = document.createElement('div');
    folder.className = 'folder';
    folder.innerHTML = '<span class="album-pill"></span><div class="album-name"></div><div class="album-desc"></div>';
    folder.querySelector('.album-pill').textContent = kids.length ? `${kids.length} ${kids.length === 1 ? 'thing' : 'things'}` : 'empty';
    const name = folder.querySelector('.album-name');
    name.textContent = item.title || 'untitled album';
    name.classList.toggle('empty', !item.title);
    folder.querySelector('.album-desc').textContent = item.note || '';

    el.prepend(peeks, folder);
  }

  function buildCard(item) {
    const el = document.createElement('div');
    el.className = `card ${item.type}`;
    el.dataset.id = item.id;
    el.style.width = `${item.w}px`;
    el.style.zIndex = item.z;
    el.style.setProperty('--r', `${item.rot}deg`);
    el.style.translate = `${item.x}px ${item.y}px`;

    if (item.type === 'image') {
      const img = new Image();
      img.draggable = false;
      img.decoding = 'async';
      img.alt = item.title || '';
      if (item.iw && item.ih) img.style.aspectRatio = `${item.iw} / ${item.ih}`;
      img.onerror = () => el.classList.add('broken');
      img.src = srcOf(item);
      el.append(img);
    } else if (item.type === 'note') {
      el.style.background = item.color;
      const t = document.createElement('div');
      t.className = 'note-text';
      t.textContent = item.text || '';
      el.append(t);
    } else if (item.type === 'album') {
      fillAlbum(el, item);
    }
    decorate(el, item);
    if (item.type !== 'album') setCaption(el, item);
    attachDrag(el, item.id);
    return el;
  }

  function render(id) {
    const item = items.get(id);
    const old = views.get(id);
    if (!item || !onBoard(item)) {
      old?.remove();
      views.delete(id);
      return null;
    }
    const el = buildCard(item);
    if (old) old.replaceWith(el); else world.append(el);
    views.set(id, el);
    return el;
  }

  const flash = (id, cls, ms = 450) => {
    const el = views.get(id);
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  };
  const updateHint = () => { hint.hidden = items.size > 0; };

  /* ---------------- creating & removing ---------------- */
  function create(data, at) {
    const type = data.type;
    const w = WIDTH[type];
    const h = type === 'image' ? w * ((data.ih || 5) / (data.iw || 4)) + 14 : type === 'note' ? 170 : 232;
    const item = {
      id: uid(),
      title: '', note: '', link: '', source: '', album: null,
      createdAt: Date.now(),
      w,
      rot: +(type === 'album' ? rand(-2, 2) : rand(-4, 4)).toFixed(2),
      tape: type === 'image' && Math.random() < 0.45,
      z: ++topZ,
      ...data,
      x: Math.round(at.x - w / 2),
      y: Math.round(at.y - h / 2),
    };
    if (type === 'note') item.color ??= pick(NOTE_COLORS);
    if (type === 'album') item.color ??= pick(PALETTE).hex;
    if (item.album) item.addedAt = Date.now();
    items.set(item.id, item);
    persist(item);
    if (item.album && items.has(item.album)) {
      render(item.album);
      flash(item.album, 'bump');
      if (avAlbum?.id === item.album) refreshAlbumView();
    } else {
      render(item.id);
      flash(item.id, 'pop');
    }
    updateHint();
    return item;
  }

  function removeItem(item) {
    // an album never takes its contents with it: they go back onto the board
    if (item.type === 'album') {
      childrenOf(item.id).forEach((k, i) => {
        k.album = null;
        k.x = item.x + 30 + i * 34;
        k.y = item.y + 20 + i * 26;
        k.z = ++topZ;
        persist(k);
      });
    }
    items.delete(item.id);
    db.del(item.id);
    tombs.add(item.id);
    saveTombs();
    emit('del', item.id);
    const el = views.get(item.id);
    views.delete(item.id);
    if (el) { el.classList.add('leaving'); setTimeout(() => el.remove(), 240); }
    if (item.type === 'album') [...items.values()].filter((k) => !views.has(k.id) && onBoard(k)).forEach((k) => { render(k.id); flash(k.id, 'pop'); });
    if (item.album) render(item.album);
    const u = urls.get(item.id);
    if (u) { setTimeout(() => URL.revokeObjectURL(u.url), 300); urls.delete(item.id); }
    updateHint();
  }

  function putInAlbum(item, albumId) {
    const el = views.get(item.id);
    el?.classList.add('into');
    setTimeout(() => {
      item.album = albumId;
      item.addedAt = Date.now();
      persist(item);
      render(item.id);
      render(albumId);
      flash(albumId, 'bump');
    }, 200);
  }

  function takeOut(item) {
    const a = items.get(item.album);
    item.album = null;
    if (a) {
      item.x = Math.round(a.x + a.w + 30 + rand(0, 40));
      item.y = Math.round(a.y + rand(-20, 40));
    }
    item.z = ++topZ;
    persist(item);
    render(item.id);
    flash(item.id, 'pop');
    if (a) render(a.id);
  }

  /* ---------------- adding things ---------------- */
  async function prepare(blob) {
    // Keep a reasonably sized copy so the board stays fast and storage stays small.
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { return { blob, w: 4, h: 5 }; }
    const { width: w, height: h } = bmp;
    const MAX = 1600;
    if (blob.type === 'image/gif' || (Math.max(w, h) <= MAX && blob.size < 1.2e6)) {
      bmp.close?.();
      return { blob, w, h };
    }
    const k = Math.min(1, MAX / Math.max(w, h));
    const cw = Math.round(w * k);
    const ch = Math.round(h * k);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
    bmp.close?.();
    const out = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.86));
    return { blob: out || blob, w: cw, h: ch };
  }

  async function addImageBlob(blob, at, extra = {}) {
    const p = await prepare(blob);
    return create({ type: 'image', blob: p.blob, iw: p.w, ih: p.h, ...extra }, at);
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
    const files = [...(dt.files || [])].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|avif|webp)$/i.test(f.name));
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

  const albumAt = (cx, cy, skipId) => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const c = el.closest?.('.card.album');
      if (c && c.dataset.id !== skipId) return c.dataset.id;
    }
    return null;
  };

  /* drag & drop from desktop / other tabs — drop onto an album to file it there */
  let dropTarget = null;
  const setDropTarget = (id) => {
    if (id === dropTarget) return;
    views.get(dropTarget)?.classList.remove('drop-target');
    dropTarget = id;
    views.get(id)?.classList.add('drop-target');
  };
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!modal.hidden) return;
    board.classList.add('dropping');
    setDropTarget(albumAt(e.clientX, e.clientY));
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) { board.classList.remove('dropping'); setDropTarget(null); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    board.classList.remove('dropping');
    setDropTarget(null);
    if (!modal.hidden || !e.dataTransfer) return;
    const album = avAlbum ? avAlbum.id : albumAt(e.clientX, e.clientY);
    ingest(e.dataTransfer, toWorld(e.clientX, e.clientY), album ? { album } : {});
  });

  window.addEventListener('paste', (e) => {
    if (!modal.hidden || !accountModal.hidden || e.target.closest?.('input, textarea')) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    ingest(e.clipboardData, toWorld(innerWidth / 2 + rand(-50, 50), innerHeight / 2 + rand(-40, 40)), avAlbum ? { album: avAlbum.id } : {});
  });

  /* ---------------- double-tap menu ---------------- */
  let menuAt = { x: 0, y: 0 };
  function openMenu(cx, cy) {
    menuAt = toWorld(cx, cy);
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
    if (act === 'picture') openPicker(menuAt);
    if (act === 'album') {
      const a = create({ type: 'album' }, menuAt);
      openSheet(a, { focusTitle: true });
    }
  });
  window.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });

  let pickAt = { x: 0, y: 0 };
  function openPicker(at) {
    pickAt = at;
    picker.value = '';
    picker.click();
  }
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    for (let i = 0; i < files.length; i++) await addImageBlob(files[i], offset(pickAt, i));
  });

  /* ---------------- moving pins ---------------- */
  function attachDrag(el, id) {
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
        item.x = Math.round(start.ix + dx / cam.scale);
        item.y = Math.round(start.iy + dy / cam.scale);
        el.style.translate = `${item.x}px ${item.y}px`;
        if (item.type !== 'album') {
          const t = albumAt(ev.clientX, ev.clientY, id);
          if (t !== target) {
            views.get(target)?.classList.remove('drop-target');
            target = t;
            views.get(t)?.classList.add('drop-target');
          }
        }
      };
      const end = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        el.classList.remove('lifted');
        if (target) {
          views.get(target)?.classList.remove('drop-target');
          if (ev.type === 'pointerup' && items.has(target)) { putInAlbum(item, target); return; }
        }
        if (moved) persist(item);
        else if (ev.type === 'pointerup' && items.has(id)) (item.type === 'album' ? openAlbumView(item) : openSheet(item));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }

  /* ---------------- moving the board ---------------- */
  const pointers = new Map();
  let pan = null;
  let pinch = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const startPan = (p) => { pan = { sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false }; };
  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { d: dist(a, b) || 1, s: cam.scale, m: mid(a, b), cx: cam.x, cy: cam.y };
    pan = null;
  }

  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.card') || e.button > 0) return;
    board.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e.clientX, e.clientY));
    if (pointers.size === 1) startPan(local(e.clientX, e.clientY));
    else if (pointers.size === 2) startPinch();
  });
  board.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const lp = local(e.clientX, e.clientY);
    pointers.set(e.pointerId, lp);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const m = mid(a, b);
      const s = clampScale(pinch.s * dist(a, b) / pinch.d);
      const wx = (pinch.m.x - pinch.cx) / pinch.s;
      const wy = (pinch.m.y - pinch.cy) / pinch.s;
      cam.x = m.x - wx * s;
      cam.y = m.y - wy * s;
      cam.scale = s;
      applyCam();
    } else if (pan) {
      const dx = lp.x - pan.sx;
      const dy = lp.y - pan.sy;
      if (!pan.moved && Math.hypot(dx, dy) > 4) { pan.moved = true; board.classList.add('panning'); }
      if (pan.moved) { cam.x = pan.cx + dx; cam.y = pan.cy + dy; applyCam(); }
    }
  });
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const wasTap = pan && !pan.moved && !pinch && pointers.size === 1 && e.type === 'pointerup';
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) startPan([...pointers.values()][0]);
    if (pointers.size === 0) { pan = null; board.classList.remove('panning'); }
    if (wasTap) {
      const now = performance.now();
      if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap.t = 0;
        openMenu(e.clientX, e.clientY);
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  }
  board.addEventListener('pointerup', endPointer);
  board.addEventListener('pointercancel', endPointer);
  board.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.card')) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  });

  board.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeMenu();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      const unit = e.deltaMode === 1 ? 16 : 1;
      cam.x -= e.deltaX * unit;
      cam.y -= e.deltaY * unit;
      applyCam();
    }
  }, { passive: false });

  let gestureScale = 1;
  board.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
  board.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (pointers.size) return;
    zoomAt(e.clientX, e.clientY, e.scale / gestureScale);
    gestureScale = e.scale;
  });

  /* ---------------- the pop-up (pins & albums) ---------------- */
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
    const el = views.get(item.id);
    if (el) {
      if (item.type === 'note') el.querySelector('.note-text').textContent = item.text || '';
      setCaption(el, item);
    } else if (item.album) {
      render(item.album);
    }
  }

  let preview = null; // live folder preview while creating an album

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

    const inAlbum = Boolean(item.album && items.has(item.album));
    fBack.hidden = true;
    fTitle.placeholder = isAlbum ? 'album name' : 'give it a name…';
    fNote.placeholder = isAlbum ? 'a short description' : "why do you love it? what's the plan?";
    fTitle.value = item.title || '';
    fNote.value = item.note || '';
    // colors are offered while creating; later they live behind the tiny circle in the open album
    fSwatches.hidden = !isAlbum;
    fSwatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.hex === item.color)));
    fLinkRow.hidden = isAlbum;
    fLink.value = item.link || '';
    if (!isAlbum) updateVisit();
    fOut.hidden = !inAlbum;
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

  const onKeyActivate = (el, fn) => {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  };
  onKeyActivate(fOut, () => {
    const item = current;
    takeOut(item);
    closeSheet();
    refreshAlbumView();
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
    refreshAlbumView();
  });

  let downOnBackdrop = false;
  modal.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === modal; });
  modal.addEventListener('click', (e) => { if (downOnBackdrop && e.target === modal) closeSheet(); });

  /* ---------------- open album: pins jump out of the folder ---------------- */
  const av = $id('albumView');
  const avTitle = av.querySelector('.av-title');
  const avDesc = av.querySelector('.av-desc');
  const avGrid = av.querySelector('.av-grid');
  const avColors = av.querySelector('.av-colors');
  const avDot = av.querySelector('.av-dot');
  const avOptions = av.querySelector('.av-options');
  const avRemove = av.querySelector('.av-remove');
  let avAlbum = null;
  let avSave = null;
  let avTimer = null;

  PALETTE.forEach((p, k) => {
    const b = document.createElement('button');
    b.className = 'av-opt';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', p.name);
    b.style.setProperty('--s', p.hex);
    b.style.setProperty('--k', k);
    b.dataset.hex = p.hex;
    avOptions.append(b);
  });

  const folderCenter = (id) => {
    const el = views.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const tileHeight = () => (innerWidth <= 720 ? 150 : 210);

  function tileFor(k) {
    const t = document.createElement('div');
    t.className = 'av-tile';
    t.dataset.id = k.id;
    if (k.type === 'image') {
      const im = new Image();
      im.src = srcOf(k);
      im.alt = k.title || '';
      im.draggable = false;
      t.append(im);
      const H = tileHeight();
      const ratio = k.iw && k.ih ? k.iw / k.ih : 0.8;
      t.style.width = `${Math.round(Math.min(Math.max((H - 10) * ratio + 10, 110), H * 1.6))}px`;
    } else if (k.text) {
      t.classList.add('note');
      t.style.background = k.color;
      t.textContent = k.text;
    } else {
      t.classList.add('note', 'link');
      t.style.background = k.color;
      t.textContent = hostOf(k.link) || k.title || 'note';
    }
    t.addEventListener('click', () => openSheet(k));
    return t;
  }

  function fillAlbumView() {
    const kids = childrenOf(avAlbum.id);
    avGrid.replaceChildren(...kids.map(tileFor));
    if (!kids.length) avGrid.innerHTML = '<div class="av-empty"><b>nothing here yet</b>drag pins onto the folder, or drop pictures right on it</div>';
  }
  // the name field hugs its text so the tiny color circle sits right next to it
  const measureCtx = document.createElement('canvas').getContext('2d');
  function sizeAvTitle() {
    measureCtx.font = getComputedStyle(avTitle).font;
    const w = measureCtx.measureText(avTitle.value || avTitle.placeholder).width;
    avTitle.style.width = `${Math.ceil(Math.min(w + 6, innerWidth * 0.7))}px`;
  }
  function setAvColor() {
    avDot.style.setProperty('--s', avAlbum.color);
    avOptions.querySelectorAll('.av-opt').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.hex === avAlbum.color)));
  }
  const keepFolderDim = () => views.get(avAlbum?.id)?.classList.add('opening');

  function openAlbumView(album) {
    closeMenu();
    clearTimeout(avTimer);
    avAlbum = album;
    avTitle.value = album.title || '';
    avDesc.value = album.note || '';
    setAvColor();
    avColors.classList.remove('open');
    delete avRemove.dataset.armed;
    avRemove.textContent = 'remove album';
    fillAlbumView();
    av.hidden = false;
    av.scrollTop = 0;
    autosize(avDesc);
    sizeAvTitle();
    keepFolderDim();

    const from = folderCenter(album.id);
    const tiles = [...avGrid.querySelectorAll('.av-tile')];
    if (from) {
      tiles.forEach((t, i) => {
        const r = t.getBoundingClientRect();
        const dx = from.x - (r.left + r.width / 2);
        const dy = from.y - (r.top + r.height / 2);
        const rot = rand(-10, 10).toFixed(1);
        t.animate([
          { transform: `translate(${dx}px, ${dy}px) scale(.22) rotate(${rot}deg)`, opacity: 0 },
          { opacity: 1, offset: 0.3 },
          { transform: 'none', opacity: 1 },
        ], { duration: 560, delay: Math.min(i * 45, 450), easing: 'cubic-bezier(.2, 1.3, .35, 1)', fill: 'backwards' });
      });
    }
    requestAnimationFrame(() => av.classList.add('open'));
  }

  function closeAlbumView() {
    if (!avAlbum) return;
    flushAv();
    const album = avAlbum;
    avAlbum = null;
    avColors.classList.remove('open');
    const to = folderCenter(album.id);
    const tiles = [...avGrid.querySelectorAll('.av-tile')];
    if (to) {
      tiles.forEach((t, i) => {
        const r = t.getBoundingClientRect();
        const dx = to.x - (r.left + r.width / 2);
        const dy = to.y - (r.top + r.height / 2);
        t.animate([
          { transform: 'none', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(.22)`, opacity: 0 },
        ], { duration: 320, delay: Math.min((tiles.length - 1 - i) * 22, 220), easing: 'cubic-bezier(.5, 0, .75, 0)', fill: 'forwards' });
      });
    }
    av.classList.remove('open');
    avTimer = setTimeout(() => {
      av.hidden = true;
      avGrid.replaceChildren();
      views.get(album.id)?.classList.remove('opening');
      flash(album.id, 'bump');
    }, to && tiles.length ? 380 : 250);
  }

  function refreshAlbumView() {
    if (!avAlbum) return;
    if (!items.has(avAlbum.id)) { closeAlbumView(); return; }
    fillAlbumView();
    keepFolderDim();
  }

  function avChanged() {
    render(avAlbum.id);
    keepFolderDim();
    clearTimeout(avSave);
    const a = avAlbum;
    avSave = setTimeout(() => { avSave = null; persist(a); }, 400);
  }
  function flushAv() {
    if (avSave && avAlbum) { clearTimeout(avSave); avSave = null; persist(avAlbum); }
  }

  avTitle.addEventListener('input', () => { avAlbum.title = avTitle.value; sizeAvTitle(); avChanged(); });
  avDesc.addEventListener('input', () => { avAlbum.note = avDesc.value; autosize(avDesc); avChanged(); });
  avTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); avDesc.focus(); } });
  avDesc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); avDesc.blur(); } });

  // the tiny circle pulls out the palette
  avDot.addEventListener('click', () => avColors.classList.toggle('open'));
  avOptions.addEventListener('click', (e) => {
    const o = e.target.closest('.av-opt');
    if (!o || !avAlbum) return;
    avAlbum.color = o.dataset.hex;
    setAvColor();
    render(avAlbum.id);
    keepFolderDim();
    persist(avAlbum);
    setTimeout(() => avColors.classList.remove('open'), 220);
  });

  onKeyActivate(avRemove, () => {
    if (!avRemove.dataset.armed) {
      avRemove.dataset.armed = '1';
      avRemove.textContent = 'tap again — pins go back to the board';
      return;
    }
    const a = avAlbum;
    flushAv();
    avAlbum = null;
    av.classList.remove('open');
    avTimer = setTimeout(() => { av.hidden = true; avGrid.replaceChildren(); }, 250);
    removeItem(a);
  });

  const isBlank = (t) => t === av || t.matches?.('.av-grid, .av-head, .av-foot, .av-title-row, .av-empty, .av-empty b');
  let avDown = false;
  av.addEventListener('pointerdown', (e) => {
    avDown = isBlank(e.target);
    if (!avColors.contains(e.target)) avColors.classList.remove('open');
  });
  av.addEventListener('click', (e) => { if (avDown && isBlank(e.target)) closeAlbumView(); });

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
        <button class="apple-btn" data-act="signin" ${s.enabled ? '' : 'disabled'}>${APPLE}<span>Sign in with Apple</span></button>
        ${s.enabled ? '' : '<p class="acct-note">sync isn’t connected yet (see SETUP.md)</p>'}`;
    }
  }
  acct.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'signin') window.posie.account?.signIn();
    if (act === 'signout') window.posie.account?.signOut();
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
    closeMenu();
    if (!accountModal.hidden) closeAccount();
    else if (current) closeSheet();
    else closeAlbumView();
  });

  /* ---------------- interface for sync.js ---------------- */
  window.posie = {
    account: null,
    all: () => [...items.values()],
    get: (id) => items.get(id),
    onChange: (fn) => changeFns.add(fn),
    tombstones: () => new Set(tombs),
    clearTombstone: (id) => { tombs.delete(id); saveTombs(); },
    accountChanged: () => { if (!accountModal.hidden) renderAccount(); },
    // apply a pin/album that changed on another device (no echo back to the cloud)
    applyRemote(item) {
      const prev = items.get(item.id);
      items.set(item.id, item);
      topZ = Math.max(topZ, item.z || 1);
      db.put(item);
      render(item.id);
      if (item.type === 'album') childrenOf(item.id).forEach((k) => render(k.id));
      new Set([prev?.album, item.album].filter(Boolean)).forEach((a) => render(a));
      refreshAlbumView();
      updateHint();
    },
    applyRemoteDelete(id) {
      const item = items.get(id);
      if (!item) return;
      items.delete(id);
      db.del(id);
      views.get(id)?.remove();
      views.delete(id);
      if (item.type === 'album') childrenOf(id).forEach((k) => render(k.id));
      if (item.album) render(item.album);
      if (current?.id === id) closeSheet();
      refreshAlbumView();
      updateHint();
    },
  };

  /* ---------------- start ---------------- */
  applyCam();
  db.all()
    .then((list) => {
      list.sort((a, b) => (a.z || 0) - (b.z || 0));
      for (const item of list) { items.set(item.id, item); topZ = Math.max(topZ, item.z || 1); }
      for (const item of list) render(item.id);
    })
    .catch((e) => console.warn('posie: could not load board', e))
    .finally(() => { updateHint(); document.dispatchEvent(new Event('posie:ready')); });

  navigator.storage?.persist?.().catch(() => {});
})();
