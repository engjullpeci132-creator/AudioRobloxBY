/* ============================================================
   AudioRobloxBY — modules/waveform.js
   WaveSurfer.js waveform display + playback controls
   ============================================================ */

'use strict';

window.WaveformModule = (function () {

  let ws         = null;   // WaveSurfer instance
  let _duration  = 0;
  let _ready     = false;

  const waveEl        = document.getElementById('waveform');
  const placeholder   = document.getElementById('waveform-placeholder');
  const controlsEl    = document.getElementById('waveform-controls');
  const wcPlay        = document.getElementById('wc-play');

  // ── Init / re-init WaveSurfer ──────────────────────────
  function init() {
    if (ws) {
      try { ws.destroy(); } catch (_) {}
      ws = null;
    }
    _ready = false;

    if (!window.WaveSurfer) {
      console.warn('[Waveform] WaveSurfer.js not loaded');
      return null;
    }

    ws = WaveSurfer.create({
      container:       '#waveform',
      waveColor:       '#3d3860',
      progressColor:   '#7c3aed',
      cursorColor:     '#00e5cc',
      cursorWidth:     2,
      barWidth:        2,
      barGap:          1,
      barRadius:       2,
      height:          72,
      normalize:       true,
      interact:        true,
      backend:         'WebAudio',
    });

    // ── Events ───────────────────────────────────────────
    ws.on('ready', () => {
      _ready    = true;
      _duration = ws.getDuration();
      waveEl.style.display      = 'block';
      placeholder.style.display = 'none';
      controlsEl.style.display  = 'flex';
      if (window.onWaveformTimeUpdate) {
        window.onWaveformTimeUpdate(0, _duration);
      }
    });

    ws.on('audioprocess', () => {
      if (window.onWaveformTimeUpdate) {
        window.onWaveformTimeUpdate(ws.getCurrentTime(), _duration);
      }
    });

    ws.on('seek', () => {
      if (window.onWaveformTimeUpdate) {
        window.onWaveformTimeUpdate(ws.getCurrentTime(), _duration);
      }
    });

    ws.on('finish', () => {
      if (window.onWaveformFinish) window.onWaveformFinish();
      if (wcPlay) wcPlay.textContent = '▶';
    });

    ws.on('error', (err) => {
      console.error('[Waveform] Error:', err);
      if (window.showToast) window.showToast('⚠️ Gagal load waveform', 'error');
    });

    return ws;
  }

  // ── Load audio URL ─────────────────────────────────────
  function load(url) {
    if (!init()) return;
    waveEl.style.display      = 'none';
    placeholder.style.display = 'flex';
    placeholder.querySelector('span').textContent = 'Memuat waveform...';
    controlsEl.style.display  = 'none';
    try {
      ws.load(url);
    } catch (e) {
      console.error('[Waveform] Load error:', e);
    }
  }

  // ── Playback ───────────────────────────────────────────
  function play()  { if (ws && _ready) ws.play();  }
  function pause() { if (ws && _ready) ws.pause(); }
  function stop()  {
    if (ws && _ready) {
      ws.stop();
      ws.seekTo(0);
      if (window.onWaveformTimeUpdate) window.onWaveformTimeUpdate(0, _duration);
    }
  }

  function seekTo(progress) {
    if (ws && _ready) ws.seekTo(Math.max(0, Math.min(1, progress)));
  }

  function setVolume(v) {
    if (ws) ws.setVolume(Math.max(0, Math.min(1, v)));
  }

  function isPlaying() {
    return ws ? ws.isPlaying() : false;
  }

  // ── Destroy ────────────────────────────────────────────
  function destroy() {
    if (ws) {
      try { ws.destroy(); } catch (_) {}
      ws     = null;
      _ready = false;
    }
    waveEl.style.display      = 'none';
    controlsEl.style.display  = 'none';
    placeholder.style.display = 'flex';
    placeholder.querySelector('span').textContent = 'Upload audio untuk melihat waveform';
  }

  // ── Public API ─────────────────────────────────────────
  return { load, play, pause, stop, seekTo, setVolume, isPlaying, destroy };

})();

console.log('[Waveform] Module ready');