# GembaTicket Scanner

A staff-facing Progressive Web App for validating GembaTicket NFT tickets at the gate. Reads the QR code on each ticket, calls the activation API, and gives instant audible/visual feedback with distinct colours per ticket state.

**Live instance:** [scanner.gembaticket.com](https://scanner.gembaticket.com)

> Source lives in a private repository — this document is the public README for the scanner application.

## Overview

The scanner is installed as a PWA on gate-staff phones. It opens the back camera, continuously decodes QR codes from GembaTicket NFT tickets, and posts each decoded payload to the `/activate` endpoint on the ticket backend. Each scan produces a full-screen colour flash, a beep, and a result card so staff can work quickly in noisy, bright gate conditions without reading text.

The app is designed for the realities of event gates: flaky mobile data, cheap phones with slow autofocus, and staff who cannot stop to tap the screen between every scan. It scans continuously without pausing, auto-dismisses result cards on a kind-specific timeout, and **keeps admitting with no network**: it validates the rotating QR against a local snapshot of the event's valid tickets and replays its door decisions when connectivity returns.

## Architecture

```
Staff phone (PWA)
  |
  |-- QRReader (html5-qrcode + native BarcodeDetector when available)
  |-- Scan page (activation logic, feedback)
  |-- offline engine (src/offline/offline.js)
  |-- IndexedDB (Dexie) — history, offline snapshot, queued decisions
  v
scanner.gembaticket.com (Apache proxy → 127.0.0.1:3107, static Vite build)

On decode (online):
  payload --> POST /api/scanner/activate --> ok | already | refused (reason)
On decode (offline):
  payload --> verify the v2 QR against the local snapshot (per-ticket seed, zone, entry window)
          --> ok / already locally --> decision queued --> POST /api/scanner/sync on reconnect
While online: GET /api/scanner/snapshot every 60 s (ETag, 304 when unchanged)
```

## Features

- **Continuous scanning:** camera never pauses; decode loop runs at 25 fps with native `BarcodeDetector` when supported (Chrome on Android)
- **Four distinct ticket states:** `ok` (green), `already` (amber), `queued` (blue, offline), `error` (red) — each with its own flash colour, card colour, icon, and beep pitch
- **Auto-dismiss result card:** 1.5s for `ok`, 2s for `already`, 2.5s for `queued`, 3.5s for `error` — no tap required between scans
- **Deduplication:** same payload is ignored for 5s after a decode — this guards against html5-qrcode firing its callback multiple times for a single physical scan. Replay of the QR itself is stopped by the ticket side: the QR is HMAC-signed and rotates every 30 s, so a screenshot expires within about a minute
- **Offline mode:** a local snapshot of the event's valid tickets (active events only — canceled, refunded and ended are left out) lets the scanner validate and admit with no network; each admission is queued as a decision and replayed idempotently via `/api/scanner/sync`. **One offline entry right per ticket** (2026-10-21): offline, a scanner admits only the tickets whose right it holds, so two offline gates can never both admit the same ticket — see *Offline entry right* below
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
| Serve     | `serve` (static) on port 3107               |
| Proxy     | Apache + Cloudflare DNS/SSL                 |

## Ticket States

Each decoded QR resolves to one of four states. The flash overlay, card background, icon, and beep pitch are all driven by this kind so staff can identify the outcome without reading the label.

| Kind      | Colour | Meaning                                                          | Auto-dismiss |
|-----------|--------|------------------------------------------------------------------|--------------|
| `ok`      | green  | Valid activation; ticket consumed                                | 1.5s         |
| `already` | amber  | Backend returned 409 — ticket was activated earlier              | 2.0s         |
| `queued`  | blue   | Admitted OFFLINE from the local snapshot; the decision syncs online | 2.5s       |
| `error`   | red    | Refused — wrong event/zone, outside the entry window, event canceled or ended, ticket canceled/refunded — or a camera failure | 3.5s |

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
7. On a network error the scan is decided OFFLINE against the snapshot (`offlineActivate`): a valid v2 QR of a ticket **this scanner holds the offline right for** is admitted locally (a second offline scan of it → `already`) and the decision is queued; the kind is `queued`. A ticket held by another gate is refused with that gate's name. A `423` online means the ticket's right sits with a gate that cannot be reached.
8. While online, the app refreshes the snapshot and flushes queued decisions (`/api/scanner/sync`, idempotent per `clientId`; `conflict` = admitted elsewhere first).

## Configuration

Environment variables (`.env`):

```
VITE_API_BASE=https://api.gembaticket.com
```

Additional runtime config lives in `src/config/api.js` (endpoint paths, auth header construction).

Apache proxy (`scanner.gembaticket.com-ssl.conf`) forwards 443 to local port 3107 and sets:
- `Permissions-Policy: camera=(self)` — required for back-camera access on mobile
- `Cache-Control: no-cache, no-store, must-revalidate` on `sw.js` / `registerSW.js` / `workbox-*.js` so service worker updates propagate immediately

## Installation

```bash
cd scanner/
npm install
cp .env.example .env   # set VITE_API_BASE
npm run build
npm run serve          # serves dist/ on port 3107
```

For local development:

```bash
npm run dev            # Vite dev server with HMR
```

The production deploy path is `serve -s dist -l tcp://127.0.0.1:3107`; Apache fronts it on 443.

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
      Scan.jsx                  # Main scan flow, activation, offline decisions
      Manual.jsx                # Keyboard fallback
      History.jsx               # Local scan history
    config/
      api.js                    # Base URL, endpoints, fetch wrapper (throws {status,body})
    db/
      db.js                     # Dexie schema: history, offline snapshot, queued decisions (+ the legacy outbox, drained once)
    store/
      useScannerStore.js        # Zustand: token, event, scanner, online
```

## Known Constraints

- Native `BarcodeDetector` is only available on Chromium (Chrome / Edge / Samsung Internet). Safari / Firefox fall back to the pure-JS decoder, which is slower but still functional at 25 fps.
- `camera=(self)` in `Permissions-Policy` is load-bearing — without it, iOS Safari will silently deny `getUserMedia` inside the PWA.
- Service worker precaches the build assets. After a new deploy, clients get the updated bundle on next navigation because `sw.js` is served `no-cache`; a hard refresh is never required.
- QR payloads rotate (HMAC over a 30 s time slot, per-ticket seed), so a screenshot stops working within about a minute; a second scan of the same ticket returns 409 (`already`).
- ~~Two offline scanners could both admit one ticket~~ — closed on 2026-10-21 by the offline entry right (below). A ticket whose right is held by a gate that is offline can be admitted only at that gate until it reconnects (or is revoked).
- The 5-second dedup window is purely to suppress duplicate callbacks from html5-qrcode for a single physical scan. Staff rescanning the same ticket intentionally within 5s will not produce a second API call — they'll see the cached result card instead.

## See also

- [`FRONTEND.md`](./FRONTEND.md) — how the scanner fits alongside the storefront / dashboard / admin frontends.
- [`API.md`](./API.md#scanner-apiscanner) — the `/api/scanner/*` endpoints the PWA calls.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — scanner's place in the wider system (Apache, JWT, zone enforcement).
- [`DASHBOARD.md`](./DASHBOARD.md#9-scanners-tab) — how organizers create and revoke scanner devices.

## License

Proprietary. Copyright 2024-2026 GEMBA EOOD. All rights reserved.


---

## Offline entry right (2026-10-21)

Two scanners that are both offline cannot see each other. The only way one ticket can never pass twice is that, at any moment, **at most one scanner is able to admit it offline**.

- **Split.** Each ticket's right (`Ticket.offlineHolderId`) belongs to one of the event's *active* scanners (synced in the last 10 min, not revoked or expired, zone allowed), by rendezvous hashing; later joins even out to a fair share.
- **Only the holder gets the seed.** `GET /api/scanner/snapshot` (with `X-Offline-Protocol: 2`) carries `qrSeed` only for the tickets the scanner holds (`own: true`); for the others it says which gate holds them (`holder`). An old client without the header gets **no seeds** — it cannot admit anything offline. This is enforced by the server, not trusted to the app.
- **Hand-over only with the holder's acknowledgement.** `POST /api/scanner/offline/heartbeat { released }` every 3 s while online returns `{ seq, release, stale }`: the rights the server wants back. The scanner drops them locally, **syncs any offline admit of them first**, then acknowledges in the next heartbeat; only then does the right move. `stale` = a right was handed to you, refetch the snapshot. A holder that is offline cannot acknowledge, so its tickets stay with it.
- **Online at another gate.** `/activate` (and `/activate-manual`) of a ticket held by another scanner asks for it back and waits up to 6 s; if the holder is not reachable (no contact for 20 s) the answer is **423** with `heldBy` — *"Offline entry for this ticket is held by "Gate A" … Admit it there, wait until that scanner is back online, or — if the device is lost — revoke it in the dashboard."*
- **A ticket used online is used locally at once** (fix 22.10, found in a real test: admitted online, then the same door offline admitted it again). After an online admit (or a `409`) the scanner marks the ticket used in its local copy; the heartbeat's `used` list covers an admit whose response was lost when the network dropped.
- **Revoke frees the rights** (dashboard and admin master scanners): a revoked device is treated as gone.
- **Stale snapshots.** `ScannerDevice.offlineSeq` goes up with every acknowledged release and each snapshot carries the `leaseSeq` it was cut at; the scanner refuses a snapshot older than its last release and keeps released tickets dropped until a newer snapshot covers them.
- **Logging in another scanner key** on the same browser clears the old snapshot, rights and seq (pending offline decisions are kept — they record real entries).
- The offline pill shows *"this gate can admit N of M tickets"*. The Raspberry Pi reader (`rpi-reader/reader.py`) speaks the same protocol.

E2E: `tests/e2e/offline-right-e2e.js` — 45 checks, incl. a real browser in offline mode and the Pi engine.
