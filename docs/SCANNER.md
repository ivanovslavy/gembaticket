# GembaTicket Scanner

A staff-facing Progressive Web App for validating GembaTicket NFT tickets at the gate. Reads the QR code on each ticket, calls the activation API, and gives instant audible/visual feedback with distinct colours per ticket state.

**Live instance:** [scanner.gembaticket.com](https://scanner.gembaticket.com)

> Source lives in a private repository — this document is the public README for the scanner application.

## Overview

The scanner is installed as a PWA on gate-staff phones. It opens the back camera, continuously decodes QR codes from GembaTicket NFT tickets, and posts each decoded payload to the `/activate` endpoint on the ticket backend. Each scan produces a full-screen colour flash, a beep, and a result card so staff can work quickly in noisy, bright gate conditions without reading text.

The app is designed for the realities of event gates: flaky mobile data, cheap phones with slow autofocus, and staff who cannot stop to tap the screen between every scan. It scans continuously without pausing, auto-dismisses result cards on a kind-specific timeout, and queues scans offline when the backend is unreachable — replaying them automatically when connectivity returns.

## Architecture

```
Staff phone (PWA)
  |
  |-- QRReader (html5-qrcode + native BarcodeDetector when available)
  |-- Scan page (activation logic, offline outbox, feedback)
  |-- IndexedDB (Dexie) — history + offline outbox
  v
scanner.gembaticket.com (Apache proxy, port 3087)
  |
  v
`serve -s dist -l 3087`  (static Vite build)

On decode:
  payload --> POST /activate --> ticket backend --> ok | already | denied
                     |
                     `-- network failure --> IndexedDB outbox --> replay on reconnect
```

## Features

- **Continuous scanning:** camera never pauses; decode loop runs at 25 fps with native `BarcodeDetector` when supported (Chrome on Android)
- **Four distinct ticket states:** `ok` (green), `already` (amber), `queued` (blue, offline), `error` (red) — each with its own flash colour, card colour, icon, and beep pitch
- **Auto-dismiss result card:** 1.5s for `ok`, 2s for `already`, 2.5s for `queued`, 3.5s for `error` — no tap required between scans
- **Deduplication:** same payload is ignored for 5s after a decode — this guards against html5-qrcode firing its callback multiple times for a single physical scan, not against replay of the QR itself (GembaTicket QR payloads are static, baked into the ticket PNG at mint time)
- **Offline queue:** failed activations are stored in IndexedDB via Dexie and replayed automatically when the browser reports `online`
- **Scan history:** local history page with outcomes for post-event audit
- **Manual entry:** fallback page for typing a ticket code when the camera cannot read it
- **Hardware-aware camera:** requests 1920×1080 @ 30 fps, applies continuous autofocus / exposure / white-balance when the device exposes those capabilities
- **Installable PWA:** service worker precaches shell, icons, and manifest — opens like a native app once added to home screen
- **Audio + haptic feedback:** 880 Hz tone for success, 220 Hz buzz for failure, `navigator.vibrate` patterns per state

## Tech Stack

| Layer     | Technology                                  |
|-----------|---------------------------------------------|
| Frontend  | React 19, Vite 6, Tailwind 4                |
| QR decode | html5-qrcode 2.3 (native BarcodeDetector)   |
| Router    | react-router-dom 7                          |
| State     | Zustand 5                                   |
| Storage   | Dexie 4 (IndexedDB wrapper)                 |
| PWA       | vite-plugin-pwa 0.21 (Workbox generateSW)   |
| Icons     | lucide-react                                |
| Serve     | `serve` (static) on port 3087               |
| Proxy     | Apache + Cloudflare DNS/SSL                 |

## Ticket States

Each decoded QR resolves to one of four states. The flash overlay, card background, icon, and beep pitch are all driven by this kind so staff can identify the outcome without reading the label.

| Kind      | Colour | Meaning                                                          | Auto-dismiss |
|-----------|--------|------------------------------------------------------------------|--------------|
| `ok`      | green  | Valid activation; ticket consumed                                | 1.5s         |
| `already` | amber  | Backend returned 409 — ticket was activated earlier              | 2.0s         |
| `queued`  | blue   | Network error — payload saved to IndexedDB, will retry online    | 2.5s         |
| `error`   | red    | 400/401/403/404, explicit `success: false`, or camera failure    | 3.5s         |

## Routes

| Path        | Component      | Purpose                                                    |
|-------------|----------------|------------------------------------------------------------|
| `/login`    | `Login.jsx`    | Operator login — stores JWT + event/scanner context        |
| `/`         | `Scan.jsx`     | Main scan page — camera view, result card, flash overlay   |
| `/manual`   | `Manual.jsx`   | Manual ticket code entry (keyboard fallback)               |
| `/history`  | `History.jsx`  | Local scan history from IndexedDB                          |

Auth is gated in `App.jsx` via the Zustand store's `token`; unauthenticated navigation redirects to `/login`.

## Components

### `QRReader`
Thin wrapper around `html5-qrcode`. Starts the back camera, streams decoded payloads to `onDecoded`, and deduplicates repeats within `dedupMs` (default 5s).

Key settings:
- `facingMode: "environment"` with ideal 1920×1080 @ 30 fps
- `fps: 25` decode loop
- `disableFlip: true` — cuts per-frame work in half; GembaTicket QRs are never mirrored
- `experimentalFeatures.useBarCodeDetectorIfSupported: true` — uses the browser's native decoder on Chromium
- Applies `focusMode: continuous`, `exposureMode: continuous`, `whiteBalanceMode: continuous` via `MediaStreamTrack.applyConstraints` when the device supports them
- Guards against `html5-qrcode`'s synchronous string-throw on teardown (scanner that never reached `SCANNING` state)

The camera is intentionally never paused. The previous pause/resume dance hit a library state bug that left the camera frozen until a page refresh; keeping it running + dedup + an in-flight flag gives the same UX without the freeze.

### `ScanResultCard`
Renders the result of the most recent scan. Background, border, icon, and "Next scan" button colour are all driven by `kind` via a `STYLES` lookup.

### `FlashOverlay`
Brief full-screen tinted overlay (0.9s) used for unambiguous feedback in bright environments. Colour palette matches `ScanResultCard`.

### `StatusBar`
Fixed header with event name, scanner label, online/offline indicator, and links to Scan / Manual / History / Logout.

## Data Flow

1. User opens the PWA and signs in at `/login` — backend returns a JWT plus event + scanner metadata, stored in Zustand + localStorage.
2. `/` mounts `Scan.jsx` which mounts `QRReader`.
3. `QRReader` starts the back camera, registers a decode callback, and starts emitting payloads.
4. `Scan.jsx` guards with `inflightRef` — at most one activation call is in flight at a time.
5. On successful HTTP response, `showResult` sets card state + flash + beep + vibration; an effect schedules auto-dismiss.
6. On HTTP error with `status ∈ {400,401,403,404}` or `409`, the kind is `error` or `already`.
7. On any other error (typically network), the payload is appended to the Dexie outbox and the kind is `queued`.
8. When `navigator.onLine` flips to true, an effect walks the outbox and re-posts each item, removing entries that succeed.

## Configuration

Environment variables (`.env`):

```
VITE_API_BASE=https://api.gembaticket.com
```

Additional runtime config lives in `src/config/api.js` (endpoint paths, auth header construction).

Apache proxy (`scanner.gembaticket.com-ssl.conf`) forwards 443 to local port 3087 and sets:
- `Permissions-Policy: camera=(self)` — required for back-camera access on mobile
- `Cache-Control: no-cache, no-store, must-revalidate` on `sw.js` / `registerSW.js` / `workbox-*.js` so service worker updates propagate immediately

## Installation

```bash
cd scanner/
npm install
cp .env.example .env   # set VITE_API_BASE
npm run build
npm run serve          # serves dist/ on port 3087
```

For local development:

```bash
npm run dev            # Vite dev server with HMR
```

The production deploy path is `serve -s dist -l 3087`; Apache fronts it on 443.

## Project Structure

```
scanner/
  index.html                    # Vite entry; shows a boot-error pane while the bundle loads
  vite.config.js                # Vite + PWA plugin + Tailwind
  public/
    icon-192.png, icon-512.png  # PWA icons
    manifest.webmanifest        # PWA manifest (generated by vite-plugin-pwa)
  src/
    main.jsx                    # React bootstrap + router
    App.jsx                     # Auth gate, top-level routes, StatusBar
    index.css                   # Tailwind entry
    components/
      QRReader.jsx              # Camera wrapper, html5-qrcode + BarcodeDetector
      ScanResultCard.jsx        # Coloured result card, kind-driven styling
      FlashOverlay.jsx          # Full-screen flash on scan
      StatusBar.jsx             # Header: event, online state, nav links
    pages/
      Login.jsx                 # Operator login
      Scan.jsx                  # Main scan flow, activation, offline outbox
      Manual.jsx                # Keyboard fallback
      History.jsx               # Local scan history
    config/
      api.js                    # Base URL, endpoints, fetch wrapper (throws {status,body})
    db/
      db.js                     # Dexie schema: history + outbox tables
    store/
      useScannerStore.js        # Zustand: token, event, scanner, online
```

## Known Constraints

- Native `BarcodeDetector` is only available on Chromium (Chrome / Edge / Samsung Internet). Safari / Firefox fall back to the pure-JS decoder, which is slower but still functional at 25 fps.
- `camera=(self)` in `Permissions-Policy` is load-bearing — without it, iOS Safari will silently deny `getUserMedia` inside the PWA.
- Service worker precaches the build assets. After a new deploy, clients get the updated bundle on next navigation because `sw.js` is served `no-cache`; a hard refresh is never required.
- QR payloads are static — a screenshot of a valid ticket will activate successfully if it reaches the gate before the legitimate holder. Defence against double-use relies entirely on the backend's `is_used` flag, which returns 409 (`already`) on any second scan of the same serial. If screenshot sharing becomes a real problem, the mitigation is rotating payloads (HMAC over a time slot) on the ticket side, not anything in this scanner.
- The 5-second dedup window is purely to suppress duplicate callbacks from html5-qrcode for a single physical scan. Staff rescanning the same ticket intentionally within 5s will not produce a second API call — they'll see the cached result card instead.

## See also

- [`FRONTEND.md`](./FRONTEND.md) — how the scanner fits alongside the storefront / dashboard / admin frontends.
- [`API.md`](./API.md#scanner-apiscanner) — the `/api/scanner/*` endpoints the PWA calls.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — scanner's place in the wider system (Apache, JWT, zone enforcement).
- [`DASHBOARD.md`](./DASHBOARD.md#9-scanners-tab) — how organizers create and revoke scanner devices.

## License

Proprietary. Copyright 2024-2026 GEMBA EOOD. All rights reserved.
