/* Posie sync: Sign in with Apple (via Supabase Auth) + cloud copy of every pin and album.
 *
 * Model: the browser stays the source of truth while you use it (fast, offline). After sign-in,
 * a full merge runs (newest edit wins per pin), then every local change is pushed shortly after
 * it happens, and the board re-merges whenever you come back to the tab.
 *
 * Cloud layout (see supabase/schema.sql):
 *   table   pins(user_id, id, data jsonb, image_path, deleted, updated_at)
 *   bucket  pins/<user_id>/<pin id>   ← the picture itself
 */
(() => {
  'use strict';

  const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
  const cfg = window.POSIE_CONFIG || {};
  const app = window.posie;
  if (!app) return;

  const state = {
    enabled: Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey),
    apple: Boolean(cfg.appleSignIn),
    user: null,
    status: 'idle',   // idle | syncing | synced | error
    lastSync: 0,
  };
  const notify = () => app.accountChanged();
  const setStatus = (s) => { state.status = s; if (s === 'synced') state.lastSync = Date.now(); notify(); };

  let sb = null;
  let sdkReady = null;
  const appReady = new Promise((r) => document.addEventListener('posie:ready', r, { once: true }));

  app.account = {
    state,
    async signIn() {
      if (!sb) return;
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'apple',
        options: { redirectTo: location.origin + location.pathname },
      });
      if (error) { console.warn('posie: sign-in failed', error); setStatus('error'); }
    },
    // free alternative to Apple: a one-tap sign-in link sent by email
    async signInWithEmail(email) {
      if (!sb) return { error: 'sync is not connected yet' };
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: location.origin + location.pathname },
      });
      return { error: error ? error.message : null };
    },
    // the same email also carries a 6-digit code (once the template shows it): typing it works on any device
    async verifyCode(email, token) {
      if (!sb) return { error: 'sync is not connected yet' };
      const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
      return { error: error ? error.message : null };
    },
    async signOut() {
      if (!sb) return;
      await sb.auth.signOut();
      // the board stays on this device; it just stops syncing
    },
  };

  // a sign-in link that failed comes back as #error=…: explain it and tidy the address bar
  const hashInfo = new URLSearchParams(location.hash.slice(1));
  if (hashInfo.get('error')) {
    const code = hashInfo.get('error_code') || '';
    const msg = code === 'otp_expired'
      ? 'that sign-in link expired or was already used. Ask for a new one and open it once'
      : (hashInfo.get('error_description') || 'sign-in didn’t work').replace(/\+/g, ' ');
    history.replaceState(null, '', location.pathname + location.search);
    document.addEventListener('posie:ready', () => setTimeout(() => app.toast?.(msg), 300), { once: true });
  }

  if (!state.enabled) return;

  // link previews for shared links (a Pinterest pin → its picture, title and page), via supabase/functions/unfurl
  app.unfurl = async (url) => {
    await sdkReady;
    if (!sb) return null;
    const { data, error } = await sb.functions.invoke('unfurl', { body: { url } });
    if (error) throw error;
    return data;
  };

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });

  /* ---------------- cloud helpers ---------------- */
  let remoteImages = new Set();   // pin ids whose picture is already in storage
  const imagePath = (id) => `${state.user.id}/${id}`;
  const stamp = (item) => new Date(item.updatedAt || item.createdAt || Date.now()).toISOString();

  // upload the picture's actual bytes; an unreadable or empty picture is never uploaded
  async function uploadImage(item) {
    const bytes = await item.blob.arrayBuffer().catch(() => null);
    if (!bytes || !bytes.byteLength) return false;
    const type = item.blob.type || 'image/jpeg';
    const { error } = await sb.storage.from('pins').upload(imagePath(item.id), new Blob([bytes], { type }), { upsert: true, contentType: type });
    if (error) throw error;
    remoteImages.add(item.id);
    return true;
  }

  async function pushItem(item) {
    let image_path = remoteImages.has(item.id) ? imagePath(item.id) : null;
    if (item.blob?.size && !remoteImages.has(item.id) && await uploadImage(item)) image_path = imagePath(item.id);
    const { blob, ...data } = item;
    const { error } = await sb.from('pins').upsert({
      user_id: state.user.id,
      id: item.id,
      data,
      image_path,
      deleted: false,
      updated_at: stamp(item),
    });
    if (error) throw error;
  }

  async function pushDelete(id) {
    const { error } = await sb.from('pins').upsert({
      user_id: state.user.id,
      id,
      data: {},
      image_path: null,
      deleted: true,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    await sb.storage.from('pins').remove([imagePath(id)]);
    remoteImages.delete(id);
    app.clearTombstone(id);
  }

  async function download(path) {
    const { data, error } = await sb.storage.from('pins').download(path);
    if (error || !data || !data.size) return null;   // missing or empty: keep whatever we have
    return new Blob([await data.arrayBuffer()], { type: data.type || 'image/jpeg' });
  }

  // one time after the empty-picture fix: every device re-uploads the pictures it still has
  const REPAIR = 'posie.pictures-repaired.v1';
  const needsRepair = () => { try { return !localStorage.getItem(REPAIR); } catch { return false; } };

  /* ---------------- full merge ---------------- */
  let syncing = false;
  let again = false;

  async function fullSync() {
    if (!state.user) return;
    if (syncing) { again = true; return; }
    syncing = true;
    setStatus('syncing');
    try {
      await appReady;
      const { data: rows, error } = await sb.from('pins').select('id, data, image_path, deleted, updated_at');
      if (error) throw error;

      const local = new Map(app.all().map((i) => [i.id, i]));
      const tombs = app.tombstones();
      remoteImages = new Set(rows.filter((r) => r.image_path).map((r) => r.id));
      const seen = new Set();

      // albums first, so their contents land inside them
      rows.sort((a, b) => (a.data?.type === 'album' ? -1 : 0) - (b.data?.type === 'album' ? -1 : 0));

      for (const r of rows) {
        seen.add(r.id);
        const mine = local.get(r.id);
        const theirs = Date.parse(r.updated_at) || 0;
        const ours = mine?.updatedAt || 0;

        if (r.deleted) {
          if (mine && ours > theirs) await pushItem(mine);       // edited here after it was deleted elsewhere
          else if (mine) app.applyRemoteDelete(r.id);
          app.clearTombstone(r.id);
          continue;
        }
        if (tombs.has(r.id)) { await pushDelete(r.id); continue; }

        if (!mine || theirs > ours) {
          const item = { ...r.data, updatedAt: theirs };
          if (r.image_path) {
            const pic = mine?.blob?.size ? mine.blob : await download(r.image_path);
            if (pic) item.blob = pic;
          }
          app.applyRemote(item);
        } else if (ours > theirs) {
          await pushItem(mine);
        } else if (r.image_path && !mine.blob?.size) {
          // this device lost the picture: fetch it again
          const pic = await download(r.image_path);
          if (pic) app.applyRemote({ ...mine, blob: pic });
        }
      }

      if (needsRepair()) {
        for (const item of app.all()) {
          if (item.blob?.size && seen.has(item.id) && await uploadImage(item)) {
            await sb.from('pins').update({ image_path: imagePath(item.id) }).eq('user_id', state.user.id).eq('id', item.id);
          }
        }
        try { localStorage.setItem(REPAIR, '1'); } catch {}
      }
      for (const item of local.values()) if (!seen.has(item.id)) await pushItem(item);
      for (const id of tombs) if (!seen.has(id)) app.clearTombstone(id);

      setStatus('synced');
    } catch (e) {
      console.warn('posie: sync failed', e);
      setStatus('error');
    } finally {
      syncing = false;
      if (again) { again = false; fullSync(); }
    }
  }

  /* ---------------- live pushes ---------------- */
  const queue = new Map();
  let flushTimer = null;

  app.onChange((kind, id) => {
    if (!state.user) return;
    queue.set(id, kind);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1200);
  });

  async function flush() {
    if (!state.user || !queue.size) return;
    const batch = [...queue];
    queue.clear();
    setStatus('syncing');
    try {
      for (const [id, kind] of batch) {
        if (kind === 'del') await pushDelete(id);
        else { const item = app.get(id); if (item) await pushItem(item); }
      }
      setStatus('synced');
    } catch (e) {
      console.warn('posie: push failed', e);
      batch.forEach(([id, kind]) => { if (!queue.has(id)) queue.set(id, kind); });
      setStatus('error');
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 15000);
    }
  }

  let lastFocusSync = 0;
  const syncOnReturn = () => {
    if (document.visibilityState !== 'visible' || !state.user) return;
    if (Date.now() - lastFocusSync < 30000) return;
    lastFocusSync = Date.now();
    fullSync();
  };
  document.addEventListener('visibilitychange', syncOnReturn);
  window.addEventListener('focus', syncOnReturn);

  /* ---------------- start ---------------- */
  sdkReady = loadScript(SDK)
    .then(() => {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        // implicit flow: a link from the email signs you in on whichever device you open it
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
      });
      sb.auth.onAuthStateChange((_event, session) => {
        const user = session?.user ?? null;
        const changed = user?.id !== state.user?.id;
        state.user = user;
        notify();
        // run outside the auth callback (calling Supabase inside it can deadlock)
        if (user && changed) setTimeout(fullSync, 0);
      });
    })
    .catch((e) => {
      console.warn('posie: sync unavailable', e);
      state.enabled = false;
      notify();
    });
})();
