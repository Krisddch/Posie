# Posie 🌸

A soft, infinite pin board for the things you love, want to buy, and want to achieve —
a digital moodboard so ideas don't slip away.

## How it works

- **Infinite linen board** — drag the background (mouse or finger) to move around; pinch or ⌘/Ctrl + scroll to zoom.
- **No buttons** — drop a picture anywhere, paste one (⌘V / Ctrl+V), or **double-tap** the board to pick photos from your device.
- **Move pins** by dragging them.
- **Tap a pin** to open it in the middle of the screen: give it a name, a note, and a link to the website it came from.
  Images dragged in from another website remember where they were found.
- Paste plain text to make a sticky note; paste a link to make a link card.
- Everything is saved in your browser (IndexedDB) — no account, works offline.

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
| `app.js` | board camera, drag & drop, paste, storage, pop-up |
| `manifest.webmanifest`, `icon.svg` | installable web-app basics |

## Roadmap

1. **Sync** — accounts + cloud storage so the board follows you between devices.
2. **Installable PWA + Web Share Target** — on Android, Posie appears in the system share sheet.
3. **iOS / Android app** (e.g. Capacitor or native) with a share extension: share a picture from Safari,
   Instagram or Photos straight onto your board.
4. Multiple boards, link previews (page title/price), search.
