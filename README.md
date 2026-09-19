# aplexa

A self-hosted custom Alexa skill that lets you control music on your own
**Plex** server by voice — including on an Echo Show 15 — using the
invocation name **Plex**:

> "Alexa, ask Plex to play Thriller"
> "Alexa, tell Plex to play some jazz"
> "Alexa, ask Plex to pause / resume / next / previous / shuffle"

It's a real jukebox skill: Alexa streams audio directly from your Plex
server using the Alexa **AudioPlayer** interface (play/pause/next/previous,
queueing, and resuming where you left off), not just a one-shot command.

No AWS is involved — the skill's backend is a plain Node.js/Express server
you run yourself.

## How it works

- `skill-package/` — the Alexa skill manifest and interaction model
  (invocation name `plex`, a `PlayMusicIntent` with a free-form
  `SearchQuery` slot, plus the standard playback intents). The manifest
  points Alexa at your own HTTPS endpoint instead of a Lambda ARN.
- `server/` — the Node.js server that backs the skill:
  - `plex.js` searches your Plex server (`/hubs/search`) for a track,
    album, artist, or playlist matching what you asked for, and builds a
    streamable URL for each track via Plex's universal transcode endpoint.
  - `skill.js` is the Alexa request handler logic (same as before): it
    resolves a query into an ordered queue, issues `AudioPlayer.Play`
    directives, and responds to `AudioPlayer`/`PlaybackController` events
    (pause, resume, skip, shuffle, loop, "what's playing", auto-advance,
    resuming a saved position).
  - `filePersistenceAdapter.js` stores each user's playback state
    (queue, position, loop/shuffle) as a small JSON file on local disk —
    no database required.
  - `app.js` is the Express entry point. It uses `ask-sdk-express-adapter`,
    which verifies that incoming requests are genuinely signed by Amazon
    (signature-chain + timestamp checks), so it's safe to expose directly.
- `deploy/` — an example Caddy reverse-proxy config and a systemd unit for
  running the server persistently on your own machine.
- `Dockerfile` (`server/Dockerfile`) — run the server as a container
  instead of directly with Node/systemd. `.github/workflows/docker-publish.yml`
  builds it and publishes `ghcr.io/mayberts/aplexa:latest` on every push to
  `main`, so `docker-compose.yml` can just pull and run it — no repo
  checkout needed on the machine running the container (handy for Unraid's
  Compose Manager, Portainer, etc., where only the compose file + `.env`
  are copied over). `docker-compose.build.yml` is an override for building
  from a local checkout instead.

## Requirements

- **A publicly reachable HTTPS endpoint with a valid, trusted certificate**
  for this server. Alexa calls your endpoint directly from Amazon's cloud,
  so it needs a real domain name, port-forwarding/inbound access to your
  network, and a certificate from a trusted CA (Let's Encrypt is fine and
  free). Self-signed certificates are not accepted for anything but very
  limited manual testing.
  - Easiest path: point a domain (or subdomain) at your home/server's
    public IP, forward port 443, and run [Caddy](https://caddyserver.com/)
    as a reverse proxy in front of the Node app — it gets and renews a
    Let's Encrypt certificate automatically. See `deploy/Caddyfile`.
  - For quick local testing without any of that, use a tunnel like
    [ngrok](https://ngrok.com/) (`ngrok http 3000`) to get a temporary
    HTTPS URL — update the skill manifest's endpoint each time it changes.
- A Plex Media Server with a music library, also reachable over HTTPS with
  a valid certificate — your server needs to fetch from it, and more
  importantly Alexa's device streams audio directly from the URLs this
  skill hands it, so they must be Alexa-reachable HTTPS URLs too. Enabling
  Plex's **Remote Access** (Settings → Remote Access) gives you a
  `https://<ip-with-dashes>.<random>.plex.direct:32400` URL with a
  certificate Plex maintains for you — the simplest option.
- A Plex account token (search Plex's support docs for "Finding an
  authentication token" if you don't already have one).
- An Amazon developer account (to create/manage the skill) — no AWS
  account needed.
- Node.js 18+, and optionally the
  [ASK CLI](https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html)
  (`npm install -g ask-cli`, then `ask configure`) to push the skill
  manifest/interaction model from the command line instead of pasting them
  into the developer console by hand.

This is built for **personal, single-account use** — one shared Plex token
configured on the server, no account linking/OAuth. That's enough to
enable it on your own Echo devices, including the Show 15.

## Setup

1. Copy `.env.example` to `.env` and fill in your Plex details:
   ```
   cp .env.example .env
   ```
   ```
   PLEX_BASE_URL=https://your-server.plex.direct:32400
   PLEX_TOKEN=your-plex-token
   PORT=3000
   ```
2. Run the server, either with Docker or directly with Node:

   **Option A — Docker (pull prebuilt image)**

   All you need on the target machine is `docker-compose.yml` and `.env`
   (no repo checkout required — this is the setup for Unraid's Compose
   Manager, Portainer, etc.):
   ```
   docker compose up -d
   ```
   This pulls `ghcr.io/mayberts/aplexa:latest` (built by
   `.github/workflows/docker-publish.yml` on every push to `main`), reads
   `PLEX_BASE_URL`/`PLEX_TOKEN` from `.env`, exposes port 3000, and
   persists playback state in a named Docker volume. Check it came up
   healthy with `docker compose ps` or `curl http://localhost:3000/healthz`.

   > The GitHub Container Registry package is private by default if the
   > repo is private. Either make the package public (its GitHub page →
   > Package settings → Change visibility), or `docker login ghcr.io` with
   > a personal access token that has `read:packages` scope before pulling.

   **Option B — Docker (build from a local checkout)**

   If you've cloned the repo and want to build from source instead of
   pulling:
   ```
   docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
   ```
   This builds `server/Dockerfile` locally and bind-mounts
   `./server/data` on the host instead of using a named volume.

   **Option C — Node**
   ```
   cd server && npm install && npm start
   ```
   For a persistent deployment, use the provided `deploy/aplexa.service`
   systemd unit (adjust the paths/user) so it survives reboots.

   Whichever option you use, put a reverse proxy in front for HTTPS — see
   `deploy/Caddyfile` (adjust the domain) — since Alexa needs to reach it
   over HTTPS with a trusted certificate, not the bare HTTP port.
3. Edit `skill-package/skill.json` and replace
   `https://your-domain.example.com/alexa` with your actual public HTTPS
   URL (e.g. `https://plex-alexa.yourdomain.com/alexa`).
4. Create/update the skill in the
   [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask),
   either by pasting in the manifest/interaction model from
   `skill-package/` manually, or by running `ask deploy` from the repo
   root (after `ask configure`) to push `skill-package/` for you.
5. In the console's **Test** tab, enable testing in **Development**.
   Skills enabled for development on your Amazon account are automatically
   available on all Echo devices registered to that account, including
   your Show 15 — no separate "enable skill" step needed on the device.
6. Try it: "Alexa, ask Plex to play Thriller."

## Voice commands

- "play `<song / artist / album / playlist>`" — searches in that order
  (exact track, then album, then artist's whole discography, then
  playlist) and starts playing.
- "pause" / "resume"
- "next" / "previous"
- "shuffle on" / "shuffle off"
- "loop on" / "loop off"
- "what's playing"

The Echo Show 15's on-screen playback controls (via `PlaybackController`
events) also work for pause/resume/next/previous.

## Notes and limitations

- Every track is routed through Plex's universal transcode endpoint so
  format compatibility isn't a concern, at the cost of some CPU load on
  the Plex server for transcoding. If your library is already all AAC/MP3
  you can swap `server/plex.js`'s `buildStreamUrl` for a direct-play URL
  (`/library/parts/<id>/file.mp3?X-Plex-Token=...`) to avoid that.
- `/hubs/search` searches your whole server; if you have multiple music
  libraries and want to scope the search, pass a `sectionId` to the Plex
  search call in `server/plex.js`.
- The file-based persistence store keeps one JSON file per Alexa user
  under `/app/data` in the container (a named volume by default, or
  `server/data/` on the host if you use `docker-compose.build.yml`, or
  `server/data/` directly when running with plain Node). Fine for a
  single-instance personal server; if you ever scale to multiple server
  processes behind a load balancer, swap
  `filePersistenceAdapter.js` for a shared store (e.g. SQLite, Redis,
  Postgres) implementing the same `getAttributes`/`saveAttributes`/
  `deleteAttributes` interface.
- This skill is for personal/development use as configured. Public
  distribution on the Alexa skill store would need account linking (so
  each user supplies their own Plex server/token) and would go through
  Amazon's certification process.
