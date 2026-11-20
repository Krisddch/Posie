/* Posie — a soft, infinite pin board.
 * Everything is stored locally in the browser (IndexedDB), so it works offline
 * and with no account. No build step: open index.html through any static server.
 */
(() => {
  'use strict';

  const board = document.getElementById('board');
  const world = document.getElementById('world');
  const hint = document.getElementById('hint');
  const picker = document.getElementById('picker');
  const modal = document.getElementById('modal');

  const CARD_W = 220;
  const NOTE_W = 210;
  const NOTE_COLORS = ['#fff1bf', '#fde0d8', '#e2ebd3', '#dce7f1', '#ede0f2'];

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const isHttp = (s) => /^https?:\/\/\S+$/i.test(s || '');
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

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

  /* ---------------- camera ---------------- */
  const cam = (() => {
    try {
      const c = JSON.parse(localStorage.getItem('posie.cam'));
      if (c && [c.x, c.y, c.scale].every(Number.isFinite)) return c;
    } catch {}
    return { x: innerWidth / 2, y: innerHeight / 2, scale: 1 };
  })();

  let camTimer;
  function applyCam() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`;
    // the linen moves with you, so the board feels like one endless piece of fabric
    board.style.backgroundPosition = `${cam.x}px ${cam.y}px, ${cam.x}px ${cam.y}px, ${cam.x}px ${cam.y}px, 0 0`;
    clearTimeout(camTimer);
    camTimer = setTimeout(() => { try { localStorage.setItem('posie.cam', JSON.stringify(cam)); } catch {} }, 300);
  }
  const clampScale = (s) => Math.min(3, Math.max(0.15, s));
  function zoomAt(px, py, factor) {
    const s = clampScale(cam.scale * factor);
    const k = s / cam.scale;
    cam.x = px - (px - cam.x) * k;
    cam.y = py - (py - cam.y) * k;
    cam.scale = s;
    applyCam();
  }
  const toWorld = (px, py) => ({ x: (px - cam.x) / cam.scale, y: (py - cam.y) / cam.scale });

  /* ---------------- pins ---------------- */
  const pins = new Map(); // id -> { item, el, url }
  let topZ = 1;

  const srcFor = (rec) => {
    if (rec.item.blob) return rec.url ??= URL.createObjectURL(rec.item.blob);
    return rec.item.src;
  };

  function place(rec) {
    rec.el.style.translate = `${rec.item.x}px ${rec.item.y}px`;
  }

  function refreshCaption(rec) {
    const { item, el } = rec;
    let cap = el.querySelector('.cap');
    const text = item.title || (item.type === 'note' && item.link && !item.text ? hostOf(item.link) : '');
    if (!text) { cap?.remove(); return; }
    if (!cap) { cap = document.createElement('div'); cap.className = 'cap'; el.append(cap); }
    cap.textContent = text;
  }

  function render(item) {
    const el = document.createElement('div');
    const rec = { item, el, url: null };
    pins.set(item.id, rec);

    el.className = `card ${item.type}${item.tape ? ' taped' : ''}`;
    el.style.width = `${item.w}px`;
    el.style.zIndex = item.z;
    el.style.setProperty('--r', `${item.rot}deg`);
    place(rec);

    if (item.type === 'image') {
      const img = new Image();
      img.draggable = false;
      img.decoding = 'async';
      img.alt = item.title || '';
      if (item.iw && item.ih) img.style.aspectRatio = `${item.iw} / ${item.ih}`;
      img.onerror = () => el.classList.add('broken');
      img.src = srcFor(rec);
      el.append(img);
    } else {
      el.style.background = item.color;
      const t = document.createElement('div');
      t.className = 'note-text';
      t.textContent = item.text || '';
      el.append(t);
    }
    refreshCaption(rec);
    attachDrag(rec);
    world.append(el);
    updateHint();
    return rec;
  }

  function create(data, at) {
    const w = data.type === 'note' ? NOTE_W : CARD_W;
    const h = data.type === 'note' ? 170 : w * ((data.ih || 5) / (data.iw || 4)) + 14;
    const item = {
      id: uid(),
      title: '', note: '', link: '', source: '',
      createdAt: Date.now(),
      w,
      rot: +rand(-4, 4).toFixed(2),
      tape: Math.random() < 0.45,
      z: ++topZ,
      ...data,
      x: Math.round(at.x - w / 2),
      y: Math.round(at.y - h / 2),
    };
    if (item.type === 'note') { item.color ??= pick(NOTE_COLORS); item.tape = false; }
    const rec = render(item);
    rec.el.classList.add('pop');
    setTimeout(() => rec.el.classList.remove('pop'), 450);
    db.put(item);
    return rec;
  }

  function removePin(rec) {
    pins.delete(rec.item.id);
    db.del(rec.item.id);
    rec.el.classList.add('leaving');
    setTimeout(() => {
      rec.el.remove();
      if (rec.url) URL.revokeObjectURL(rec.url);
    }, 240);
    updateHint();
  }

  const updateHint = () => { hint.hidden = pins.size > 0; };

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
    // Best case: the site allows it and we keep our own copy (survives the site going away).
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) { await addImageBlob(blob, at, { source: url, ...extra }); return true; }
      }
    } catch {}
    // Otherwise, pin it by reference.
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

  // Handles drops and pastes alike: files, images dragged from other sites, links, and plain text.
  async function ingest(dt, at) {
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
        await addImageBlob(files[i], offset(at, i), { link: pageUrl, source: imgUrl });
      }
      return;
    }

    const url = imgUrl || (isHttp(uri) ? uri : '') || (isHttp(text) ? text : '');
    if (url) {
      const ok = await addRemoteImage(url, at, { link: pageUrl });
      if (!ok) addNote({ link: url }, at); // a plain web link becomes a little link card
      return;
    }
    if (text) addNote({ text }, at);
  }

  /* drag & drop from desktop / other tabs */
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (modal.hidden) board.classList.add('dropping');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) board.classList.remove('dropping');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    board.classList.remove('dropping');
    if (!modal.hidden || !e.dataTransfer) return;
    ingest(e.dataTransfer, toWorld(e.clientX, e.clientY));
  });

  /* paste (⌘V / Ctrl+V) */
  window.addEventListener('paste', (e) => {
    if (!modal.hidden || e.target.closest?.('input, textarea')) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    ingest(e.clipboardData, toWorld(innerWidth / 2 + rand(-50, 50), innerHeight / 2 + rand(-40, 40)));
  });

  /* double-tap / double-click the linen to choose photos (works on phones too) */
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
  function attachDrag(rec) {
    const { el } = rec;
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      rec.item.z = ++topZ;
      el.style.zIndex = rec.item.z;

      const start = { x: e.clientX, y: e.clientY, ix: rec.item.x, iy: rec.item.y };
      let moved = false;

      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        if (!moved) { moved = true; el.classList.add('lifted'); }
        rec.item.x = Math.round(start.ix + dx / cam.scale);
        rec.item.y = Math.round(start.iy + dy / cam.scale);
        place(rec);
      };
      const end = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        el.classList.remove('lifted');
        db.put(rec.item);
        if (!moved && ev.type === 'pointerup' && pins.has(rec.item.id)) openModal(rec);
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

  function startPan(p) {
    pan = { sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false };
  }
  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { d: dist(a, b) || 1, s: cam.scale, m: mid(a, b), cx: cam.x, cy: cam.y };
    pan = null;
  }

  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.card') || e.button > 0) return;
    board.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) startPan({ x: e.clientX, y: e.clientY });
    else if (pointers.size === 2) startPinch();
  });

  board.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
      const dx = e.clientX - pan.sx;
      const dy = e.clientY - pan.sy;
      if (!pan.moved && Math.hypot(dx, dy) > 4) { pan.moved = true; board.classList.add('panning'); }
      if (pan.moved) {
        cam.x = pan.cx + dx;
        cam.y = pan.cy + dy;
        applyCam();
      }
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
        openPicker(toWorld(e.clientX, e.clientY));
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  }
  board.addEventListener('pointerup', endPointer);
  board.addEventListener('pointercancel', endPointer);

  // trackpad: two-finger scroll pans, pinch (ctrl+wheel) zooms; mouse: ctrl/⌘ + wheel zooms
  board.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      const unit = e.deltaMode === 1 ? 16 : 1;
      cam.x -= e.deltaX * unit;
      cam.y -= e.deltaY * unit;
      applyCam();
    }
  }, { passive: false });

  // Safari desktop trackpad pinch
  let gestureScale = 1;
  board.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
  board.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (pointers.size) return; // touch pinch is already handled by pointer events
    zoomAt(e.clientX, e.clientY, e.scale / gestureScale);
    gestureScale = e.scale;
  });

  /* ---------------- the pop-up ---------------- */
  const $ = (s) => modal.querySelector(s);
  const media = $('.sheet-media');
  const fTitle = $('.f-title');
  const fNote = $('.f-note');
  const fLink = $('.f-link');
  const fVisit = $('.f-visit');
  const fDate = $('.f-date');
  const fRemove = $('.f-remove');
  let current = null;
  let saveTimer = null;
  let hideTimer = null;

  const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  function normalizeUrl(v) {
    v = v.trim();
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && v.includes('.')) v = `https://${v}`;
    try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
  }

  function updateVisit() {
    const it = current.item;
    const target = it.link || it.source;
    if (!target) { fVisit.hidden = true; return; }
    fVisit.hidden = false;
    fVisit.href = target;
    fVisit.textContent = `${it.link ? 'visit' : 'found on'} ${hostOf(target)} ↗`;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    const item = current.item;
    saveTimer = setTimeout(() => { saveTimer = null; db.put(item); }, 400);
  }
  function flushSave() {
    if (saveTimer && current) { clearTimeout(saveTimer); saveTimer = null; db.put(current.item); }
  }

  function resetRemove() {
    delete fRemove.dataset.armed;
    fRemove.textContent = 'remove';
  }

  function openModal(rec) {
    clearTimeout(hideTimer);
    current = rec;
    const it = rec.item;
    media.replaceChildren();
    if (it.type === 'image') {
      const img = new Image();
      img.alt = it.title || '';
      img.src = srcFor(rec);
      media.append(img);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'f-text';
      ta.value = it.text || '';
      ta.placeholder = 'write something…';
      ta.style.background = it.color;
      ta.addEventListener('input', () => {
        it.text = ta.value;
        rec.el.querySelector('.note-text').textContent = it.text;
        refreshCaption(rec);
        scheduleSave();
      });
      media.append(ta);
    }
    fTitle.value = it.title || '';
    fNote.value = it.note || '';
    fLink.value = it.link || '';
    fDate.textContent = `added ${fmtDate(it.createdAt)}`;
    updateVisit();
    resetRemove();
    modal.hidden = false;
    autosize(fNote);
    requestAnimationFrame(() => modal.classList.add('open'));
  }

  function closeModal() {
    if (!current) return;
    flushSave();
    current = null;
    modal.classList.remove('open');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { modal.hidden = true; media.replaceChildren(); }, 200);
  }

  fTitle.addEventListener('input', () => {
    current.item.title = fTitle.value;
    refreshCaption(current);
    scheduleSave();
  });
  fNote.addEventListener('input', () => {
    current.item.note = fNote.value;
    autosize(fNote);
    scheduleSave();
  });
  fLink.addEventListener('input', () => {
    current.item.link = normalizeUrl(fLink.value);
    updateVisit();
    refreshCaption(current);
    scheduleSave();
  });
  fTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fNote.focus(); } });

  function onRemove() {
    if (!fRemove.dataset.armed) {
      fRemove.dataset.armed = '1';
      fRemove.textContent = 'tap again to remove';
      return;
    }
    const rec = current;
    closeModal();
    removePin(rec);
  }
  fRemove.addEventListener('click', onRemove);
  fRemove.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRemove(); } });

  // close by tapping outside the sheet, or Esc
  let downOnBackdrop = false;
  modal.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === modal; });
  modal.addEventListener('click', (e) => { if (downOnBackdrop && e.target === modal) closeModal(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  /* ---------------- start ---------------- */
  applyCam();
  db.all()
    .then((list) => {
      list.sort((a, b) => (a.z || 0) - (b.z || 0));
      for (const item of list) {
        topZ = Math.max(topZ, item.z || 1);
        render(item);
      }
    })
    .catch((e) => console.warn('posie: could not load board', e))
    .finally(updateHint);

  // ask the browser not to clear the board when space runs low
  navigator.storage?.persist?.().catch(() => {});
})();
