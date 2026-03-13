/* ============================================================
   AudioRobloxBY — modules/uploader.js
   File upload handling + audio validation
   ============================================================ */

'use strict';

window.UploaderModule = (function () {

  const ALLOWED_TYPES = [
    'audio/mpeg',       // mp3
    'audio/wav',        // wav
    'audio/ogg',        // ogg
    'audio/flac',       // flac
    'audio/mp4',        // m4a
    'audio/x-m4a',
    'audio/aac',
    'audio/webm',
  ];

  const ALLOWED_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'webm'];
  const MAX_SIZE_MB  = 100;

  // ── Validate file ──────────────────────────────────────
  function validate(file) {
    if (!file) return { ok: false, error: 'Tidak ada file dipilih.' };

    const ext     = file.name.split('.').pop().toLowerCase();
    const sizeMB  = file.size / 1048576;

    if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXT.includes(ext)) {
      return { ok: false, error: `Format "${ext}" tidak didukung. Gunakan: ${ALLOWED_EXT.join(', ').toUpperCase()}` };
    }

    if (sizeMB > MAX_SIZE_MB) {
      return { ok: false, error: `File terlalu besar (${sizeMB.toFixed(1)} MB). Maksimal ${MAX_SIZE_MB} MB.` };
    }

    return { ok: true, ext, sizeMB: sizeMB.toFixed(2) };
  }

  // ── Read file as ArrayBuffer (for Web Audio API) ───────
  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = (e) => resolve(e.target.result);
      reader.onerror = ()  => reject(new Error('Gagal membaca file'));
      reader.readAsArrayBuffer(file);
    });
  }

  // ── Read file as Data URL ──────────────────────────────
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = (e) => resolve(e.target.result);
      reader.onerror = ()  => reject(new Error('Gagal membaca file'));
      reader.readAsDataURL(file);
    });
  }

  // ── Get audio duration from file ───────────────────────
  function getAudioDuration(objectUrl) {
    return new Promise((resolve) => {
      const audio = new Audio();
      audio.src = objectUrl;
      audio.addEventListener('loadedmetadata', () => {
        resolve(audio.duration);
        audio.src = '';
      });
      audio.addEventListener('error', () => resolve(0));
    });
  }

  // ── Format duration to mm:ss ───────────────────────────
  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ── Build metadata summary ─────────────────────────────
  async function getMeta(file, objectUrl) {
    const ext      = file.name.split('.').pop().toLowerCase();
    const sizeMB   = (file.size / 1048576).toFixed(2);
    const duration = await getAudioDuration(objectUrl);
    return {
      name:     file.name,
      ext:      ext.toUpperCase(),
      sizeMB,
      duration,
      durationFmt: formatDuration(duration),
    };
  }

  // ── Public API ─────────────────────────────────────────
  return { validate, readAsArrayBuffer, readAsDataURL, getMeta, formatDuration };

})();

console.log('[Uploader] Module ready');