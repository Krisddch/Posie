# Posie 🌸

A soft, infinite pin board for the things you love, want to buy, and want to achieve —
a digital moodboard so ideas don't slip away.

## How it works

- **Infinite linen board.** Drag the background to move around. Pinch, or ⌘/Ctrl + scroll, to zoom; the fabric grows and shrinks with you.
- **No buttons.** Drop a picture anywhere or paste one. **Double-tap** (or right-click) the board for a tiny menu: **add a picture** or **new album**.
- **Albums** look like folders with their pictures peeking out. Each has a name, a short description and a color
  (sky `#75A1EE`, butter `#FDE575`, blossom `#F890C5`, cocoa `#733D20`). Drag a pin onto a folder to file it, or drop pictures straight onto it.
  Tap a folder to see what's inside; tap a pin inside to open it, or take it back out.
- **Tap a pin** to open it in the middle: a name, a note and a link to the website it came from.
- **The little aluminium circle** next to the name turns the board into brushed aluminium in a dark wooden frame, with colorful ceramic magnets.
  Tap it again to go back to linen.
- **Sign in with Apple** (tap **posie**) syncs your board between devices. It needs a one-time setup: see [SETUP.md](SETUP.md).
- Without an account everything is saved in your browser and works offline.

## Run it locally

No build step. Serve the folder with any static server:

```bash
python3 -m http.server 5173
```

then open http://localhost:5173.

## Project layout

| file | what |
| --- | --- |
| `index.html` | page shell + pop-up markup |
| `styles.css` | linen board, pins, pop-up |
| `app.js` | board camera, drag & drop, paste, albums, themes, storage, pop-up |
| `sync.js`, `config.js` | Sign in with Apple + cloud sync (Supabase) |
| `supabase/schema.sql` | database + storage setup for sync |
| `assets/` | linen, aluminium and wood textures |
| `manifest.webmanifest`, `icon.svg` | installable web-app basics |

## Roadmap

1. ~~Sync~~ ✓ (needs the one-time setup in SETUP.md)
2. **Installable PWA + Web Share Target** — on Android, Posie appears in the system share sheet.
3. **iOS / Android app** (e.g. Capacitor or native) with a share extension: share a picture from Safari,
   Instagram or Photos straight onto your board.
4. Multiple boards, link previews (page title/price), search.
