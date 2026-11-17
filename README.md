# aplexa

A self-hosted custom Alexa skill that lets you control music on your own
**Plex** server by voice — including on an Echo Show 15 — using the
invocation name **plex player** (Alexa requires invocation names to be at
least two words):

> "Alexa, ask plex player to play Thriller"
> "Alexa, tell plex player to play some jazz"
> "Alexa, ask plex player to shuffle Kate's Favourites"
> "Alexa, ask plex player to pause / resume / next / previous / shuffle"

It's a real jukebox skill: Alexa streams audio directly from your Plex
server using the Alexa **AudioPlayer** interface (play/pause/next/previous,
queueing, and resuming where you left off), not just a one-shot command.

No AWS is involved — the skill's backend is a plain Node.js/Express server
you run yourself.

## How it works

- `skill-package/` — the Alexa skill manifest and interaction model
  (invocation name `plex player`, `PlayMusicIntent` and
  `ShuffleMusicIntent` with a free-form `SearchQuery` slot, plus the
  standard playback intents). The manifest
  points Alexa at your own HTTPS endpoint instead of a Lambda ARN.
- `server/` — the Node.js server that backs the skill:
  - `plex.js` matches what you asked for against your playlist names,
    then searches your Plex server (`/hubs/search`) for a track, album,
    artist, or playlist, and builds a
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
  - **If your domain is proxied through Cloudflare (orange cloud)**, Alexa
    and every other outside client see Cloudflare's edge certificate, not
    your origin's (e.g. Nginx Proxy Manager's Let's Encrypt cert) —
    Cloudflare terminates TLS at its edge. Cloudflare's free Universal SSL
    issues a **wildcard** certificate covering `*.yourdomain.com`, so the
    Alexa console's "SSL certificate type" on the Endpoint page must be set
    to the **wildcard** option (`sslCertificateType: "Wildcard"` in
    `skill-package/skill.json`), not "trusted certificate authority" —
    picking the wrong one makes Alexa unable to reach the endpoint at all,
    with nothing showing up in your server's logs or Cloudflare's Security
    Events (the request fails validation before it's ever sent). Check via
    your browser's padlock → certificate details → Subject Alternative
    Name to confirm what your setup actually serves.
- A Plex Media Server with a music library, also reachable over HTTPS with
  a valid certificate — your server needs to fetch from it, and more
  importantly Alexa's device streams audio directly from the URLs this
  skill hands it, so they must be Alexa-reachable HTTPS URLs too. The
  recommended setup is a fixed hostname on your own domain — see
  [Giving Plex a fixed hostname](#giving-plex-a-fixed-hostname).
  Plex's **Remote Access** (Settings → Remote Access) also gives you a
  `https://<ip-with-dashes>.<random>.plex.direct:32400` URL with a
  certificate Plex maintains for you, but that hostname contains your WAN
  IP, so it changes (and the skill stops working) whenever your ISP gives
  you a new IP.
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
   PLEX_BASE_URL=https://plex.yourdomain.com
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
6. Try it: "Alexa, ask plex player to play Thriller."

## Giving Plex a fixed hostname

`PLEX_BASE_URL` is used both by the server (to search Plex) and by your
Echo (which streams audio straight from it), so it needs a hostname that
stays the same when your WAN IP changes and has a trusted certificate.
If you already run a reverse proxy for this skill's endpoint (e.g. Nginx
Proxy Manager behind Cloudflare), add Plex to it:

1. **DNS:** add a record for a subdomain such as `plex.yourdomain.com`
   pointing at your WAN IP. In Cloudflare set it to **DNS only (grey
   cloud)**, not proxied: Cloudflare's terms restrict streaming media
   through its proxy, and with DNS only your proxy's own Let's Encrypt
   certificate is what clients see.
2. **Keep the record up to date:** run a dynamic DNS updater (e.g. a
   Cloudflare DDNS container) that updates the `plex` record as well as
   the skill's own record whenever your WAN IP changes.
3. **Reverse proxy:** add a proxy host for `plex.yourdomain.com` that
   forwards to your Plex server on port `32400`, with a Let's Encrypt
   certificate and websockets support enabled. If Plex's **Secure
   connections** setting (Settings → Network) is **Required**, forward
   using the `https` scheme; with **Preferred**, `http` also works.
   Port 443 must be forwarded to the proxy on your router (it already is
   if the skill's endpoint goes through the same proxy).
4. **Optional:** in Plex, Settings → Network → **Custom server access
   URLs**, add `https://plex.yourdomain.com:443` so Plex's own apps can
   use the same address.
5. Set it in `.env` and restart the server:
   ```
   PLEX_BASE_URL=https://plex.yourdomain.com
   ```

To check it, from outside your network (e.g. a phone on mobile data) open
`https://plex.yourdomain.com/identity?X-Plex-Token=<your token>`. You
should get a short XML/JSON reply with no certificate warning.

## Voice commands

- "play `<song / artist / album / playlist>`" — plays it in order. A
  playlist whose name matches what you said is used first (small
  spelling differences are fine, e.g. "kate's favorites" finds "Kate's
  Favourites", and "my playlist …" / "… playlist" are ignored). Otherwise
  it searches for a matching track, then album, then artist's whole
  discography, then playlist.
- "shuffle `<song / artist / album / playlist>`" — finds it the same way
  and plays it in random order. These phrasings also work:
  - "shuffle play `<…>`"
  - "shuffle the playlist `<…>`" / "shuffle the album `<…>`"
  - "shuffle songs by `<artist>`"
  - "play `<…>` on shuffle" / "play `<…>` shuffled"
- "pause" / "resume"
- "next" / "previous"
- "shuffle on" — keeps the current song playing and shuffles the rest of
  the queue after it. Saying it again while already shuffled doesn't
  reshuffle.
- "shuffle off" — puts the queue back in its original order (the order
  the playlist, album or artist was in when you asked for it, including
  when you started with "shuffle `<…>`") and carries on from the current
  song, with the song that follows it in the original order. Songs you've
  already heard may come round again, and ones that came before the
  current song in the original order are skipped. It does nothing if the
  queue isn't shuffled.
- Starting something new with "play `<…>`" turns shuffle off; "shuffle
  `<…>`" turns it on.
- Alexa queues up the next song early, while the current one is playing,
  so after "shuffle on" or "shuffle off" the next song may still be the
  one from the old order. After that, playback continues in the new order
  from wherever that song sits in it.
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
