# NexCore

A self-hosted, single-user\* Google Drive alternative. Run it on your PC,
homelab box, or server; access it from any device on your LAN at
`http://<that machine's IP>:8080`.

\* Multiple people *can* sign up and each gets their own isolated 2GB
drive, but there's no sharing between accounts yet.

## Features

- Sign up / sign in, isolated 2GB drive per account
- Folders, drag-and-drop or button upload, rename, delete
- Archive-bomb-resistant uploads (see security notes below)
- Drive-wide search by name, with each result showing its folder path
- Image preview: click a PNG/JPEG/GIF/WebP/BMP and it opens inline in a
  lightbox instead of downloading, with a real thumbnail shown in the
  grid too. SVGs are deliberately excluded from inline preview (see
  security notes) and still just download.

## Running it

Requires only Node.js (18+; built and tested on 22). No `npm install`,
no external dependencies — the backend is written entirely with Node's
built-in modules on purpose, so there's nothing to fetch from the
internet to get it running.

```
node backend/server.js
```

By default it listens on `0.0.0.0:8080`. Override with environment
variables:

```
PORT=9000 HOST=127.0.0.1 node backend/server.js
```

On startup it prints every LAN address it's actually reachable at right
now (detected fresh each run, since reconnecting to wifi can hand your
machine a different local IP). If port 8080 is already taken and you
didn't set `PORT` explicitly, it automatically tries 8081, 8082, etc.
(up to 5 attempts) rather than crashing — the banner tells you which
port it actually landed on. If you *did* set `PORT` explicitly, it
fails loudly instead of silently picking a different one, since you
presumably chose that port for a reason (e.g. a reverse proxy config
expects it).

Then visit `http://localhost:8080` (or `http://<your-LAN-IP>:8080` from
another device on the same network).

Data is stored under `backend/data/` (accounts, sessions, file/folder
metadata as JSON) and `storage/files/` (the actual uploaded file bytes,
one subfolder per user). Both are created automatically on first run.
Back up those two folders if you care about the data.

## Project layout

```
frontend/
  login/        sign in / create account page
  dashboard/    the drive itself — folders, upload, browse
  settings/     account info, storage usage, cookie preferences
  legal/        cookie policy
  shared/       CSS, the wave background, the API client, cookie consent
backend/
  auth/         session cookie handling
  users/        account storage + password hashing
  api/          file/folder logic + the archive-bomb guard
  server.js     the actual HTTP server and router
storage/files/  where uploaded file bytes actually live on disk
test/           an archive-guard unit test and a full API integration test
```

## Running the tests

```
node test/archiveGuard.test.js   # builds a real zip bomb and confirms it's blocked
node test/integration.test.js    # spins up the real server and exercises the full API
```

## Security notes (read this before exposing it beyond your LAN)

- **Archive-bomb protection is real but layered, not magic.** Uploads are
  streamed to disk with a hard byte cap enforced *while receiving them*
  (never buffered fully in memory), and zip/gzip files are checked
  against their own declared uncompressed size *without ever being
  decompressed*. Anything ambiguous (Zip64, corrupt directories) is
  blocked rather than guessed at. See the comments at the top of
  `backend/api/archiveGuard.js` for the full reasoning and the known
  edge cases (e.g. gzip's 4GB ISIZE wraparound).
- **Image preview only allows raster formats, never SVG.** The
  `/api/files/view/:id` endpoint serves files with
  `Content-Disposition: inline` so the browser renders them instead of
  downloading — but an uploaded SVG (or any HTML-ish content) can embed
  `<script>`, and rendering that inline would execute it in this app's
  origin with the signed-in user's session. The server enforces a strict
  whitelist (PNG/JPEG/GIF/WebP/BMP/ICO only) independent of whatever the
  client claims, so this can't be bypassed by editing the frontend. SVGs
  and everything else still work fine as a normal download.
- **This has no TLS.** It's plain HTTP, meant for a trusted LAN. If you
  want to reach it from outside your network, put it behind a reverse
  proxy (Caddy, nginx, Tailscale, etc.) that terminates HTTPS — don't
  port-forward it directly to the internet as-is.
- **Auth is intentionally simple.** Passwords are hashed with scrypt and
  a per-user random salt (no plaintext, no reused salt), and sessions
  are random 256-bit tokens in an HttpOnly cookie. There's no rate
  limiting on login attempts and no email verification — fine for a
  homelab tool used by people you trust, not hardened for a public
  internet-facing service.
- **The JSON "database" is not built for heavy concurrent write load.**
  It's fine for personal/small-group use; if this grows into something
  with many simultaneous users, swap `backend/users/users.js` and
  `backend/api/files.js` for a real database.
