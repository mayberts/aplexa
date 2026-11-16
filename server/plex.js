'use strict';

const crypto = require('crypto');

const PLEX_BASE_URL = (process.env.PLEX_BASE_URL || '').replace(/\/+$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const MAX_ARTIST_ALBUMS = 15;

// Stable identifier for this app, required by Plex's Universal Transcode
// endpoint to track transcode sessions — requests without it are rejected
// with a bare 400 Bad Request.
const PLEX_CLIENT_IDENTIFIER = 'aplexa-c6f22b1d-8f2e-4c3a-9e2d-3f6b9a7e1a02';

function assertConfigured() {
  if (!PLEX_BASE_URL || !PLEX_TOKEN) {
    throw new Error('PLEX_BASE_URL and PLEX_TOKEN must be set as Lambda environment variables.');
  }
}

async function plexFetch(path, params = {}) {
  assertConfigured();
  const url = new URL(PLEX_BASE_URL + path);
  url.searchParams.set('X-Plex-Token', PLEX_TOKEN);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Plex request to ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

function buildStreamUrl(ratingKey) {
  const params = new URLSearchParams({
    path: `/library/metadata/${ratingKey}`,
    protocol: 'http',
    mediaIndex: '0',
    partIndex: '0',
    audioCodec: 'mp3',
    directPlay: '0',
    directStream: '1',
    fastSeek: '1',
    session: crypto.randomUUID(),
    'X-Plex-Client-Identifier': PLEX_CLIENT_IDENTIFIER,
    'X-Plex-Product': 'aplexa',
    'X-Plex-Version': '1.0',
    // Plex's Universal Transcode endpoint matches requests against its
    // built-in per-platform codec/container profiles; an unrecognized
    // platform name (e.g. "Alexa") has no profile to match and is
    // rejected with "unable to find a matching profile". "Chrome" is one
    // of Plex's broadly-supported built-in web profiles (same one Plex
    // Web itself uses), so it reliably produces a compatible MP3 stream.
    'X-Plex-Platform': 'Chrome',
    'X-Plex-Token': PLEX_TOKEN
  });
  return `${PLEX_BASE_URL}/music/:/transcode/universal/start.mp3?${params.toString()}`;
}

function buildThumbUrl(thumb) {
  if (!thumb) return undefined;
  return `${PLEX_BASE_URL}${thumb}?X-Plex-Token=${PLEX_TOKEN}`;
}

function trackFromMetadata(item) {
  return {
    ratingKey: item.ratingKey,
    title: item.title,
    artist: item.grandparentTitle || item.originalTitle || 'Unknown Artist',
    album: item.parentTitle || '',
    durationMs: item.duration || 0,
    thumb: buildThumbUrl(item.thumb || item.parentThumb || item.grandparentThumb)
  };
}

async function getTracksForAlbum(ratingKey) {
  const data = await plexFetch(`/library/metadata/${ratingKey}/children`);
  return (data.MediaContainer.Metadata || []).map(trackFromMetadata);
}

async function getTracksForArtist(ratingKey) {
  const albums = await plexFetch(`/library/metadata/${ratingKey}/children`);
  const albumItems = (albums.MediaContainer.Metadata || []).slice(0, MAX_ARTIST_ALBUMS);
  let tracks = [];
  for (const album of albumItems) {
    const albumTracks = await getTracksForAlbum(album.ratingKey);
    tracks = tracks.concat(albumTracks);
  }
  return tracks;
}

async function getTracksForPlaylist(ratingKey) {
  const data = await plexFetch(`/playlists/${ratingKey}/items`);
  return (data.MediaContainer.Metadata || []).map(trackFromMetadata);
}

async function search(query) {
  const data = await plexFetch('/hubs/search', { query, limit: 30 });
  return data.MediaContainer.Hub || [];
}

function normalize(s) {
  return s.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function fuzzyThreshold(a, b) {
  return Math.max(2, Math.round(Math.max(a.length, b.length) * 0.25));
}

/**
 * Plex's /hubs/search frequently omits playlists, and voice transcripts
 * drop punctuation and can shift spelling (e.g. Alexa's US-English NLU
 * transcribes "Kate's Favourites" as "kates favorites"), so playlists are
 * matched separately against the full playlist list.
 *
 * With `strict`, only an exact or close fuzzy (edit distance) match of the
 * whole title counts — this is used before the general search so a named
 * playlist wins over the loosely related tracks /hubs/search returns.
 * Without it, substring matches are also accepted.
 */
async function findPlaylistByName(query, { strict = false } = {}) {
  const q = normalize(query);
  if (!q) return undefined;
  const data = await plexFetch('/playlists', { playlistType: 'audio' });
  const playlists = data.MediaContainer.Metadata || [];

  const exact = playlists.find((p) => normalize(p.title) === q);
  if (exact) return exact;

  let best;
  let bestDistance = Infinity;
  for (const p of playlists) {
    const title = normalize(p.title);
    const distance = levenshtein(title, q);
    if (distance <= fuzzyThreshold(title, q) && distance < bestDistance) {
      best = p;
      bestDistance = distance;
    }
  }
  if (best || strict) return best;

  return playlists.find((p) => {
    const title = normalize(p.title);
    return title.includes(q) || q.includes(title);
  });
}

// Words people say around a playlist name ("my playlist kate's favorites",
// "kate's favorites playlist") that aren't part of the title.
function stripPlaylistWords(query) {
  return query
    .replace(/^\s*(my|the)\s+/i, '')
    .replace(/^\s*playlist\s+(called\s+|named\s+)?/i, '')
    .replace(/\s+playlist\s*$/i, '')
    .trim();
}

// True when a search result's title is (close to) what was asked for, as
// opposed to one of the loosely related results Plex's search also returns.
function titleMatches(item, query) {
  const q = normalize(query);
  const title = normalize(item.title || '');
  if (!q || !title) return false;
  return title === q || levenshtein(title, q) <= fuzzyThreshold(title, q);
}

/**
 * Resolves a free-form voice query into an ordered queue of playable tracks.
 *
 * A playlist whose name matches the query is used first. Then any search
 * result whose title matches the query (track, album, artist, playlist, in
 * that order), and only then the best loose search result.
 */
async function resolveQueue(query) {
  const playlistQuery = stripPlaylistWords(query);
  const namedPlaylist = await findPlaylistByName(playlistQuery, { strict: true });
  if (namedPlaylist) return getTracksForPlaylist(namedPlaylist.ratingKey);

  const hubs = await search(query);
  const hubOf = (type) => hubs.find((h) => h.type === type && h.Metadata && h.Metadata.length);
  const loaders = {
    track: (item, hub) => {
      const matching = hub.Metadata.filter((m) => titleMatches(m, query));
      return (matching.length ? matching : [item]).map(trackFromMetadata);
    },
    album: (item) => getTracksForAlbum(item.ratingKey),
    artist: (item) => getTracksForArtist(item.ratingKey),
    playlist: (item) => getTracksForPlaylist(item.ratingKey)
  };
  const order = ['track', 'album', 'artist', 'playlist'];

  for (const type of order) {
    const hub = hubOf(type);
    const item = hub && hub.Metadata.find((m) => titleMatches(m, query));
    if (item) return loaders[type](item, hub);
  }

  const loosePlaylist = await findPlaylistByName(playlistQuery);
  if (loosePlaylist) return getTracksForPlaylist(loosePlaylist.ratingKey);

  for (const type of order) {
    const hub = hubOf(type);
    if (!hub) continue;
    if (type === 'track') return hub.Metadata.map(trackFromMetadata);
    return loaders[type](hub.Metadata[0], hub);
  }

  return [];
}

module.exports = {
  resolveQueue,
  buildStreamUrl,
  trackFromMetadata
};
