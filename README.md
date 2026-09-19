# aplexa

A custom Alexa skill that lets you control music on your own **Plex** server
by voice — including on an Echo Show 15 — using the invocation name **Plex**:

> "Alexa, ask Plex to play Thriller"
> "Alexa, tell Plex to play some jazz"
> "Alexa, ask Plex to pause / resume / next / previous / shuffle"

It's a real jukebox skill: Alexa streams audio directly from your Plex
server using the Alexa **AudioPlayer** interface (play/pause/next/previous,
queueing, and resuming where you left off), not just a one-shot command.

## How it works

- `skill-package/` — the Alexa skill manifest and interaction model
  (invocation name `plex`, a `PlayMusicIntent` with a free-form
  `SearchQuery` slot, plus the standard playback intents).
- `lambda/` — the Node.js 18 Lambda function that backs the skill:
  - `plex.js` searches your Plex server (`/hubs/search`) for a track, album,
    artist, or playlist matching what you asked for, and builds a
    streamable URL for each track via Plex's universal transcode endpoint.
  - `index.js` is the Alexa request handler. It resolves a query into an
    ordered queue, issues `AudioPlayer.Play` directives, and responds to
    `AudioPlayer`/`PlaybackController` events (pause, resume, skip,
    shuffle, loop, "what's playing", auto-advance, resuming a saved
    position) by reading/writing per-user state in DynamoDB.

## Requirements

- A Plex Media Server with a music library, reachable over **HTTPS with a
  valid certificate** — Alexa will not fetch audio from a self-signed or
  plain-HTTP URL. Enabling Plex's **Remote Access** (Settings → Remote
  Access) gives you a `https://<ip-with-dashes>.<random>.plex.direct:32400`
  URL with a certificate Plex maintains for you; that's the easiest option.
  A reverse proxy with your own certificate also works.
- A Plex account token (Settings → Network → "Show Advanced", or via your
  account's authentication token — search "Finding an authentication
  token" in Plex's support docs if you don't already have one handy).
- An Amazon developer account and an AWS account (same region for both is
  simplest).
- Node.js 18+ and the [ASK CLI](https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html)
  (`npm install -g ask-cli`, then `ask configure` to link both accounts).

This is built for **personal, single-account use** — one shared Plex token
configured on the Lambda function, no account linking/OAuth. That's enough
to enable it on your own Echo devices, including the Show 15.

## Setup

1. Install Lambda dependencies:
   ```
   cd lambda && npm install && cd ..
   ```
2. Deploy the skill and Lambda function:
   ```
   ask deploy
   ```
   This creates the skill from `skill-package/` and a Lambda function from
   `lambda/`, and wires the endpoint automatically. Note the Lambda
   function name it prints (something like `ask-aplexa-default-<region>`).
3. Create the DynamoDB table used to persist playback state per user:
   ```
   aws dynamodb create-table \
     --table-name PlexAlexaSkillState \
     --attribute-definitions AttributeName=id,AttributeType=S \
     --key-schema AttributeName=id,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST
   ```
   Make sure the Lambda function's execution role has
   `dynamodb:GetItem`/`PutItem` on this table (attach the
   `AmazonDynamoDBFullAccess` managed policy for a quick personal setup, or
   scope it down to the table ARN).
4. Set the Lambda's environment variables (Lambda console → Configuration →
   Environment variables, or via the CLI):
   ```
   aws lambda update-function-configuration \
     --function-name <your-function-name> \
     --environment "Variables={PLEX_BASE_URL=https://your-server.plex.direct:32400,PLEX_TOKEN=your-plex-token,DYNAMODB_TABLE=PlexAlexaSkillState}"
   ```
5. In the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask),
   open the skill, go to the **Test** tab, and enable testing in
   **Development**. Skills enabled for development on your Amazon account
   are automatically available on all Echo devices registered to that
   account, including your Show 15 — no separate "enable skill" step
   needed on the device.
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
  you can swap `plex.js`'s `buildStreamUrl` for a direct-play URL
  (`/library/parts/<id>/file.mp3?X-Plex-Token=...`) to avoid that.
- `/hubs/search` searches your whole server; if you have multiple music
  libraries and want to scope the search, pass a `sectionId` to the Plex
  search call in `plex.js`.
- This skill is for personal/development use as configured. Public
  distribution on the Alexa skill store would need account linking (so
  each user supplies their own Plex server/token) and would go through
  Amazon's certification process.
