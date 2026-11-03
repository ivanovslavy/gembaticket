# Venue hub (18б, 2026-11-03)

> **Status:** built and tested end-to-end in a virtual machine against the live cloud
> (`tests/hub/hub-e2e.js`). **Not yet run on a real venue Raspberry Pi** — the Wi-Fi access-point part
> of the installer is written but could not be exercised in the VM (no radio there).

## Why

Without internet, each guest could enter only through *their* gate: the offline entry right
(`offlineLeaseService.js`, 2026-10-21) gives each ticket's seed to exactly one scanner, because two
offline scanners cannot see each other. That rule is what made double entry impossible — and what made
"any door, any ticket" impossible offline.

The hub removes the reason for the rule. It is one small box on the venue's own network that every
door can reach **without internet**, and it is the single deciding authority for all of them: the
"used" flip for a ticket is one local SQLite transaction, whichever door the ticket is shown at.

```
              internet (when there is one)
                     │
            ┌────────┴─────────┐
            │  api.gembaticket │  ← the cloud: snapshot, rights, sync, revoke
            └────────┬─────────┘
                     │  hub = one scanner device (isHub) — holds EVERY right of its event
   ┌─────────────────┴──────────────────┐
   │  venue hub  https://hub.<venue>.gembaticket.com  (Node 22 + SQLite, TLS, dnsmasq, Wi-Fi AP)
   └──────┬──────────────┬──────────────┬───────────┘
        door 1         door 2         door 3            ← scanner app / Pi reader: entries go to
      (phone)        (tablet)      (Pi reader)             the hub first, the cloud second
```

## How it fits the existing protocol (nothing new for the doors to learn)

* **The hub is a scanner device** (`ScannerDevice.isHub = true`), created in the dashboard for ONE
  event (*Scanners → New scanner → "This is a venue hub"*), with its own `gtscan_` key. It is revoked
  exactly like a scanner (dashboard → revoke): its JWT and sessions die, its rights return to the pool,
  and the hub wipes itself the next time it hears from the cloud (`401`).
* **Rights:** while a hub of the event is active, `offlineLeaseService` makes the hub the only
  candidate — new rights go to it, and a door that still holds rights hands them over through the
  usual acknowledged release (heartbeat). The hub therefore receives **every seed of its event** in
  its normal snapshot. Doors that talk to the cloud directly hold no rights meanwhile.
* **Doors** keep their own protocol with the cloud (snapshot, heartbeat, sync, pairing). Only the
  **entry** calls — `scan`, `activate`, `activate-manual` — go to the hub first:
  * scanner app: `scanner/src/config/api.js` — the API base is a run-time setting; the hub's address
    comes from the event's snapshot (`hub: { url, label }`, which the hub registers via
    `POST /api/scanner/hub/register`), or from `?hub=https://…` on the scanner URL once (`?hub=off`
    clears it). A JWT is kept per base; the device's refresh token works at both.
  * Pi reader: `GEMBATICKET_HUB` (or the snapshot's advert) + `GEMBATICKET_API` (the cloud).
  * Fallback order: hub → cloud → the device's own offline engine. A hub that answers `503`
    (`fallback: true` — legacy QR, a ticket it doesn't hold, a revoked hub) sends the door to the cloud;
    an unreachable hub is skipped for 15 s.
* **Door sign-in at the hub, with no internet:** the hub mirrors the event's doors
  (`GET /api/scanner/hub/doors`, hub keys only): bcrypt hash of each door key, zones, revoked/expiry,
  the device the key is bound to, and the sha256 of each live device session's refresh token. A door
  signs in at the hub with its key (Pi) or its refresh token (scanner app, paired by QR) and gets a
  hub-signed door token (HS256, the hub's own secret — worthless anywhere else). A revoked door, an
  expired one, or a key bound to another device is refused at the hub as in the cloud.
* **Sync:** every admit is queued with a `clientId` and replayed to `POST /api/scanner/sync` with the
  `door` it was taken at (every 2 s while online). The cloud applies it idempotently, checks the
  door's own scope again, and writes the scan log **against the door**, with `via hub "<label>"`.
  Conflicts (`also activated elsewhere`, `admitted after the event ended`) are recorded, never dropped.
* **A cloud door can still take a ticket** from the hub while both are online: the cloud asks the hub
  for the right back (heartbeat), the hub syncs, drops the seed, acknowledges — the usual hand-over.

## The decision (hub/src/engine.js)

Same guards as the cloud's `/activate` and the offline engines: format → ticket → **event end**
(`endsAt` from the snapshot; offline the hub closes `clockSlackS` early, like every offline engine) →
status → the door's event and zones → entry window → the hub holds the right (seed) → HMAC → QR age
window (shared/qr-window.json; `+clockSlackS` while offline) → used. Then one transaction:
`UPDATE tickets SET activated = 1 … WHERE id = ? AND activated = 0 AND own = 1` + the decision row.
Answers have the cloud's shape (`success`, `reason`, `activatedAt`, `zoneColor`, `zoneName`) plus
`via: "hub"`, so the apps need no special case.

## Seed custody

* Seeds, mirrored key hashes and the session lookup are sealed with **AES-256-GCM** under a data key
  = HKDF-SHA256(hub API key, per-install salt). The API key exists only in
  `/etc/gembaticket-hub/hub.env` (root, 0600, read by systemd); the database lives in
  `/var/lib/gembaticket-hub` (0700, service user `gthub`). A copy of the state directory alone reveals
  no seed (checked by the e2e: no plaintext seed in the database or its WAL). Whoever has the whole box
  with root has the key too — encrypt the SD card (LUKS) on a production hub.
* **Wiped:** when the event's end passes (the hub's own clock, no network needed — a 15 s sweep),
  when the event leaves the snapshot (ended / canceled), and everything (tickets, door mirror,
  sessions) when the cloud says the hub was revoked. `secure_delete` + checkpoint + `VACUUM` overwrite
  what was deleted. Unsynced decisions stay — they record real entries — and carry no secrets.
* The hub never holds a buyer's e-mail (the snapshot never has it), so **manual entry by ticket ID +
  e-mail** goes to the cloud (`503` from the hub → the app falls back).

## TLS and names (why a real certificate)

The scanner app is a secure-context PWA on `https://scanner.gembaticket.com`; it will not call a bare
IP or a self-signed name. The hub serves **`https://hub.<venue>.gembaticket.com`**:

* **DNS on the venue LAN:** dnsmasq on the hub answers that name with the hub's LAN address (and
  hands out DHCP). The name does not have to exist in public DNS.
* **Certificate:** issued **online, before the event**, by DNS-01 —
  `hub/install/issue-cert-dns01.sh <name> <email>` with a Cloudflare API token scoped to
  *Zone → DNS → Edit* for gembaticket.com, read from a file and shredded afterwards. Let's Encrypt
  certificates last 90 days: issue within the month before the event. *No such token exists on our
  servers today; the e2e uses a locally generated test CA instead (documented, not a shortcut in the
  product).*
* CORS: the hub answers the scanner origin only (`HUB_CORS_ORIGINS`) and sends
  `Access-Control-Allow-Private-Network: true`. ⚠️ Recent Chrome versions ask the user once for
  *local network access* when a public site calls a LAN address — allow it on each door phone during
  setup. (Not testable in the VM — the doors there run the app's modules under node.)

## Install (on the hub, while it still has internet)

```bash
sudo hub/install/install.sh --iface eth0 --hub-ip 10.77.0.1 --name hub.myvenue.gembaticket.com
#   or, with the hub as the door Wi-Fi:
sudo hub/install/install.sh --iface wlan0 --hub-ip 10.77.0.1 --name hub.myvenue.gembaticket.com \
     --ap --ssid "MyVenue Doors" --country BG
sudo nano /etc/gembaticket-hub/hub.env          # HUB_API_KEY = the hub's key from the dashboard
sudo CF_DNS_API_TOKEN_FILE=/root/cf-token hub/install/issue-cert-dns01.sh hub.myvenue.gembaticket.com ops@…
curl --resolve hub.myvenue.gembaticket.com:443:10.77.0.1 https://hub.myvenue.gembaticket.com/hub/health
```

The installer is idempotent: Node 22 (checksum-verified tarball) if missing, user `gthub`, code in
`/opt/gembaticket-hub` (root-owned), the hardened unit `gembaticket-hub` (`ProtectSystem=strict`,
only `CAP_NET_BIND_SERVICE`), a static address (systemd-networkd), dnsmasq (DHCP + the hub's name),
optionally hostapd (WPA2/WPA3, passphrase generated and shown once), and an nftables table that lets
the door network reach only HTTPS/DHCP/DNS on the hub and forwards nothing from it.
Files: `hub/install/{install.sh, gembaticket-hub.service, hub.env.example, dnsmasq-venue.conf,
hostapd-venue.conf, nftables-venue.nft, issue-cert-dns01.sh}`.

## Operating it at an event

1. **Before doors open, online:** dashboard → the event → Scanners: the hub shows the *venue hub*
   badge and its address. `https://hub…/hub/health` must show `rightsHeld` = the number of tickets and
   `doors` = the number of door scanners. Open the scanner app on every door once while online (it
   learns the hub from its snapshot and hands any right it held to the hub).
2. **During:** the internet may come and go; the doors keep admitting through the hub. `health`
   shows `online`, `pendingSync` (entries not yet in the cloud) and `conflicts`.
3. **Hub fails:** doors fall back to the cloud (if the venue has internet) — the hub holds the
   rights, so the cloud asks for them back; if the hub is dead, **revoke it in the dashboard** and the
   rights return to the pool. Keep the hub on a UPS.
4. **After:** at the end the hub wipes its seeds by itself; revoke the hub key when the event is over.

## Limits, stated plainly

* If the hub **and** the internet are down at the same time, a door can admit only tickets whose
  right it still holds — normally none, because the hub holds them all. Power the hub reliably.
* A door that held rights from an earlier session and never came online again before the internet
  dropped keeps those rights; the hub refuses those tickets offline with that door's name (the same
  rule as before). Opening each door once online before the event (step 1) avoids it.
* The hub's clock is the hub's clock: offline it closes `clockSlackS` (40 s) before the event's end;
  a Pi without a real-time clock that boots offline has no correct time at all — give the hub an RTC
  module or let it sync time once online before the event.
* Chrome's local-network-access prompt (above) has not been tried on a real phone yet.

## Tests

`tests/hub/hub-e2e.js` (run from the laptop): VirtualBox VM made by `tests/hub/vm-create.sh`
(Ubuntu 24.04 cloud image, no sudo needed), provisioned by `tests/hub/vm-provision.sh` with the real
installer; the venue network is `tests/hub/vm-lan.sh` (bridge + three door network namespaces, door 1
by DHCP from dnsmasq, each door with its own uplink so the "venue internet" can be cut for everyone).
Doors: `door-pwa.mjs` runs the scanner app's own `api.js`/`offline.js`/`db.js` under node (fake
IndexedDB, bundled with esbuild); `door-pi.py` runs `rpi-reader/reader.py`. Cloud side:
`cloud-fixture.js` on the production box (throw-away organizer, event, scanners, tickets — removed at
the end; the hub is created and revoked through the real dashboard API).
