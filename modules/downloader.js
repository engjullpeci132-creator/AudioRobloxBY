/* ============================================================
   AudioRobloxBY — modules/downloader.js
   YouTube / TikTok / SoundCloud link handler
   Opens third-party converters in new tab (browser limitation)
   ============================================================ */

'use strict';

window.DownloaderModule = (function () {

  // ── Supported platforms ────────────────────────────────
  const PLATFORMS = {
    youtube: {
      name:    'YouTube',
      color:   '#c62828',
      pattern: /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      converters: [
        { name: 'ytmp3.cc',      url: (u) => `https://ytmp3.cc/en13/?url=${enc(u)}` },
        { name: 'y2mate.guru',   url: (u) => `https://www.y2mate.guru/en1/?url=${enc(u)}` },
        { name: 'yt1s.com',      url: (u) => `https://www.yt1s.com/en/youtube-to-mp3?url=${enc(u)}` },
      ],
    },
    tiktok: {
      name:    'TikTok',
      color:   '#00e5cc',
      pattern: /tiktok\.com\/@[\w.]+\/video\/(\d+)/,
      converters: [
        { name: 'ttdownloader', url: (u) => `https://ttdownloader.com/?url=${enc(u)}` },
        { name: 'snaptik',      url: (u) => `https://snaptik.app/en?url=${enc(u)}` },
      ],
    },
    soundcloud: {
      name:    'SoundCloud',
      color:   '#e65100',
      pattern: /soundcloud\.com\/[\w-]+\/[\w-]+/,
      converters: [
        { name: 'soundcloudmp3', url: (u) => `https://soundcloudmp3.org/?url=${enc(u)}` },
        { name: 'klokbox',       url: (u) => `https://www.klokbox.com/soundcloud/?url=${enc(u)}` },
      ],
    },
  };

  function enc(u) { return encodeURIComponent(u); }

  // ── Detect platform from URL ───────────────────────────
  function detectPlatform(url) {
    if (!url) return null;
    const lower = url.toLowerCase();
    if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
    if (lower.includes('tiktok.com'))    return 'tiktok';
    if (lower.includes('soundcloud.com')) return 'soundcloud';
    return null;
  }

  // ── Validate URL format ────────────────────────────────
  function isValidUrl(str) {
    try { new URL(str); return true; }
    catch (_) { return false; }
  }

  // ── Open converter ─────────────────────────────────────
  function open(url, platformKey, converterIndex = 0) {
    const platform = PLATFORMS[platformKey];
    if (!platform) return { ok: false, error: 'Platform tidak dikenal' };

    if (!isValidUrl(url)) return { ok: false, error: 'URL tidak valid' };

    const converter = platform.converters[converterIndex] || platform.converters[0];
    const target    = converter.url(url);

    window.open(target, '_blank', 'noopener,noreferrer');

    return {
      ok:        true,
      platform:  platform.name,
      converter: converter.name,
      tip:       `🔗 Membuka ${converter.name} — download MP3 lalu upload di bawah`,
    };
  }

  // ── Auto-detect and open ───────────────────────────────
  function autoOpen(url) {
    const platform = detectPlatform(url);
    if (!platform) {
      return {
        ok:    false,
        error: 'Link tidak dikenali. Paste link dari YouTube, TikTok, atau SoundCloud.',
      };
    }
    return open(url, platform);
  }

  // ── Get all converters for a platform (for fallback UI) ─
  function getConverters(platformKey) {
    return PLATFORMS[platformKey]?.converters || [];
  }

  // ── Public API ─────────────────────────────────────────
  return { open, autoOpen, detectPlatform, isValidUrl, getConverters, PLATFORMS };

})();

console.log('[Downloader] Module ready');