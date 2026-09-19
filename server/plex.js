'use strict';

const PLEX_BASE_URL = (process.env.PLEX_BASE_URL || '').replace(/\/+$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const MAX_ARTIST_ALBUMS = 15;

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
    streamUrl: buildStreamUrl(item.ratingKey),
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

/**
 * Resolves a free-form voice query into an ordered queue of playable tracks,
 * preferring an exact track match, then album, then artist (all albums), then playlist.
 */
async function resolveQueue(query) {
  const hubs = await search(query);

  const trackHub = hubs.find((h) => h.type === 'track' && h.Metadata && h.Metadata.length);
  if (trackHub) return trackHub.Metadata.map(trackFromMetadata);

  const albumHub = hubs.find((h) => h.type === 'album' && h.Metadata && h.Metadata.length);
  if (albumHub) return getTracksForAlbum(albumHub.Metadata[0].ratingKey);

  const artistHub = hubs.find((h) => h.type === 'artist' && h.Metadata && h.Metadata.length);
  if (artistHub) return getTracksForArtist(artistHub.Metadata[0].ratingKey);

  const playlistHub = hubs.find((h) => h.type === 'playlist' && h.Metadata && h.Metadata.length);
  if (playlistHub) return getTracksForPlaylist(playlistHub.Metadata[0].ratingKey);

  return [];
}

module.exports = {
  resolveQueue,
  buildStreamUrl,
  trackFromMetadata
};
