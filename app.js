/* ============================================================
   AudioRobloxBY — app.js
   Main application controller — wires all modules together
   ============================================================ */

'use strict';

// ── App State ──────────────────────────────────────────────
const AppState = {
  audioFile:    null,      // File object from uploader
  audioBuffer:  null,      // Decoded AudioBuffer
  audioUrl:     null,      // Object URL for current file
  isPlaying:    false,
  isProcessing: false,
  resultBlob:   null,      // Final processed audio blob
  resultUrl:    null,      // Object URL for result
  currentPreset: 'nocopyright',

  remixParams: {
    pitch:    0,
    tempo:    100,
    reverb:   0,
    bass:     0,
    treble:   0,
    noise:    0,
    stereo:   true,
    normalize:true,
    fade:     false,
    reverse:  false,
    format:   'mp3',
  },
};

// ── DOM refs ───────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const DOM = {
  // topbar
  btnUploadTop:    $('btn-upload-top'),
  btnPreviewTop:   $('btn-preview-top'),

  // downloader
  urlInput:        $('url-input'),
  btnYt:           $('btn-yt'),
  btnTt:           $('btn-tt'),
  btnSc:           $('btn-sc'),
  downloaderTip:   $('downloader-tip'),
  tipText:         $('tip-text'),

  // upload
  dropzone:        $('dropzone'),
  fileInput:       $('file-input'),
  audioInfo:       $('audio-info'),
  audioInfoName:   $('audio-info-name'),
  audioInfoMeta:   $('audio-info-meta'),
  btnClearAudio:   $('btn-clear-audio'),

  // waveform
  waveformPlaceholder: $('waveform-placeholder'),
  waveformEl:          $('waveform'),
  waveformControls:    $('waveform-controls'),
  wcPlay:              $('wc-play'),
  wcStop:              $('wc-stop'),
  wcTime:              $('wc-time'),
  wcSeek:              $('wc-seek'),
  wcVol:               $('wc-vol'),

  // tabs
  rtabs:            document.querySelectorAll('.rtab'),
  rtabContents:     document.querySelectorAll('.rtab-content'),

  // presets
  chips:            document.querySelectorAll('.chip'),

  // controls
  ctrlPitch:        $('ctrl-pitch'),
  ctrlTempo:        $('ctrl-tempo'),
  ctrlReverb:       $('ctrl-reverb'),
  ctrlBass:         $('ctrl-bass'),
  ctrlTreble:       $('ctrl-treble'),
  ctrlNoise:        $('ctrl-noise'),
  valPitch:         $('val-pitch'),
  valTempo:         $('val-tempo'),
  valReverb:        $('val-reverb'),
  valBass:          $('val-bass'),
  valTreble:        $('val-treble'),
  valNoise:         $('val-noise'),

  // options
  optStereo:        $('opt-stereo'),
  optNormalize:     $('opt-normalize'),
  optFade:          $('opt-fade'),
  optReverse:       $('opt-reverse'),
  optFormat:        $('opt-format'),

  // actions
  btnPreviewMain:   $('btn-preview-main'),
  btnProcess:       $('btn-process'),
  processLabel:     $('process-label'),

  // progress
  progressWrap:     $('progress-wrap'),
  progressFill:     $('progress-fill'),
  progressLabel:    $('progress-label'),

  // result
  resultPanel:      $('result-panel'),
  resultMeta:       $('result-meta'),
  btnDownload:      $('btn-download'),
  btnSavePlaylist:  $('btn-save-playlist'),
  btnFav:           $('btn-fav'),

  // sidebar nav
  navItems:         document.querySelectorAll('.nav-item'),
  favCount:         $('fav-count'),
  btnNewPlaylist:   $('btn-new-playlist'),
  sidebarPlaylists: $('sidebar-playlists'),

  // right panel
  rpNew:            $('rp-new'),
  rpEmpty:          $('rp-empty'),
  remixHistory:     $('remix-history'),

  // toast
  toast:            $('toast'),
};

// ── Toast ──────────────────────────────────────────────────
let _toastTimer = null;

function showToast(msg, type = 'info', duration = 2800) {
  const t = DOM.toast;
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = 'toast'; }, duration);
}

// ── Tab switching ──────────────────────────────────────────
DOM.rtabs.forEach(tab => {
  tab.addEventListener('click', () => {
    DOM.rtabs.forEach(t => t.classList.remove('active'));
    DOM.rtabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const target = $('tab-' + tab.dataset.tab);
    if (target) target.classList.add('active');
  });
});

// ── Sidebar nav ────────────────────────────────────────────
DOM.navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    DOM.navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    // In a multi-page setup this would route; for now show toast
    const page = item.dataset.page;
    if (page === 'favorites') showToast('⭐ Favorit kamu ada di sini', 'info');
    if (page === 'playlist')  showToast('♪ Playlist tersimpan di sini', 'info');
  });
});

// ── Control sliders ────────────────────────────────────────
function bindSlider(inputEl, valEl, formatter, stateKey) {
  inputEl.addEventListener('input', () => {
    const v = parseFloat(inputEl.value);
    valEl.textContent = formatter(v);
    AppState.remixParams[stateKey] = v;
    // When user moves a slider manually, deactivate preset chips
    DOM.chips.forEach(c => c.classList.remove('active'));
    AppState.currentPreset = null;
  });
}

bindSlider(DOM.ctrlPitch,  DOM.valPitch,  v => (v >= 0 ? '+' : '') + v + ' st',  'pitch');
bindSlider(DOM.ctrlTempo,  DOM.valTempo,  v => v + '%',                           'tempo');
bindSlider(DOM.ctrlReverb, DOM.valReverb, v => v + '%',                           'reverb');
bindSlider(DOM.ctrlBass,   DOM.valBass,   v => (v >= 0 ? '+' : '') + v + ' dB',  'bass');
bindSlider(DOM.ctrlTreble, DOM.valTreble, v => (v >= 0 ? '+' : '') + v + ' dB',  'treble');
bindSlider(DOM.ctrlNoise,  DOM.valNoise,  v => v + '%',                           'noise');

// Options checkboxes
DOM.optStereo.addEventListener('change',   () => { AppState.remixParams.stereo    = DOM.optStereo.checked; });
DOM.optNormalize.addEventListener('change',() => { AppState.remixParams.normalize = DOM.optNormalize.checked; });
DOM.optFade.addEventListener('change',     () => { AppState.remixParams.fade      = DOM.optFade.checked; });
DOM.optReverse.addEventListener('change',  () => { AppState.remixParams.reverse   = DOM.optReverse.checked; });
DOM.optFormat.addEventListener('change',   () => { AppState.remixParams.format    = DOM.optFormat.value; });

// ── Apply params to UI sliders ─────────────────────────────
function applyParamsToUI(params) {
  DOM.ctrlPitch.value  = params.pitch;
  DOM.ctrlTempo.value  = params.tempo;
  DOM.ctrlReverb.value = params.reverb;
  DOM.ctrlBass.value   = params.bass;
  DOM.ctrlTreble.value = params.treble;
  DOM.ctrlNoise.value  = params.noise;

  DOM.valPitch.textContent  = (params.pitch  >= 0 ? '+' : '') + params.pitch  + ' st';
  DOM.valTempo.textContent  = params.tempo   + '%';
  DOM.valReverb.textContent = params.reverb  + '%';
  DOM.valBass.textContent   = (params.bass   >= 0 ? '+' : '') + params.bass   + ' dB';
  DOM.valTreble.textContent = (params.treble >= 0 ? '+' : '') + params.treble + ' dB';
  DOM.valNoise.textContent  = params.noise   + '%';

  DOM.optStereo.checked   = params.stereo;
  DOM.optNormalize.checked = params.normalize;
  DOM.optFade.checked     = params.fade;
  DOM.optReverse.checked  = params.reverse;

  Object.assign(AppState.remixParams, params);
}

// ── Preset chips ───────────────────────────────────────────
DOM.chips.forEach(chip => {
  chip.addEventListener('click', () => {
    DOM.chips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const preset = chip.dataset.preset;
    AppState.currentPreset = preset;
    const params = window.PRESETS ? window.PRESETS[preset] : null;
    if (params) {
      applyParamsToUI(params);
      showToast(`✅ Preset "${chip.textContent.trim()}" aktif`, 'success');
    }
  });
});

// ── File upload ────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;

  const allowed = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/x-m4a'];
  const ext = file.name.split('.').pop().toLowerCase();
  const allowedExt = ['mp3','wav','ogg','flac','m4a'];

  if (!allowed.includes(file.type) && !allowedExt.includes(ext)) {
    showToast('❌ Format tidak didukung. Gunakan MP3/WAV/OGG/FLAC/M4A', 'error');
    return;
  }

  // Clean up old URL
  if (AppState.audioUrl) URL.revokeObjectURL(AppState.audioUrl);
  if (AppState.resultUrl) URL.revokeObjectURL(AppState.resultUrl);

  AppState.audioFile  = file;
  AppState.audioUrl   = URL.createObjectURL(file);
  AppState.resultBlob = null;
  AppState.resultUrl  = null;

  // Show audio info
  const sizeMB = (file.size / 1048576).toFixed(2);
  DOM.audioInfoName.textContent = file.name;
  DOM.audioInfoMeta.textContent = `${sizeMB} MB · ${ext.toUpperCase()}`;
  DOM.audioInfo.style.display = 'flex';

  // Hide result if visible
  DOM.resultPanel.style.display = 'none';

  // Init waveform
  if (window.WaveformModule) {
    window.WaveformModule.load(AppState.audioUrl);
  }

  showToast(`🎵 "${file.name}" siap di-remix!`, 'success');
}

// Dropzone drag events
DOM.dropzone.addEventListener('click', () => DOM.fileInput.click());

DOM.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  DOM.dropzone.classList.add('drag-over');
});

DOM.dropzone.addEventListener('dragleave', () => {
  DOM.dropzone.classList.remove('drag-over');
});

DOM.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  DOM.dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

DOM.fileInput.addEventListener('change', () => {
  if (DOM.fileInput.files[0]) handleFile(DOM.fileInput.files[0]);
});

// Top upload button
DOM.btnUploadTop.addEventListener('click', () => DOM.fileInput.click());

// Clear audio
DOM.btnClearAudio.addEventListener('click', () => {
  AppState.audioFile   = null;
  AppState.audioBuffer = null;
  if (AppState.audioUrl) URL.revokeObjectURL(AppState.audioUrl);
  AppState.audioUrl = null;
  DOM.audioInfo.style.display = 'none';
  DOM.fileInput.value = '';
  DOM.resultPanel.style.display = 'none';
  if (window.WaveformModule) window.WaveformModule.destroy();
  showToast('🗑 Audio dihapus', 'info');
});

// ── Downloader ─────────────────────────────────────────────
const PLATFORM_URLS = {
  yt: (url) => `https://ytmp3.cc/en13/?url=${encodeURIComponent(url)}`,
  tt: (url) => `https://ttdownloader.com/?url=${encodeURIComponent(url)}`,
  sc: (url) => `https://soundcloudmp3.org/?url=${encodeURIComponent(url)}`,
};

const PLATFORM_TIPS = {
  yt: '🔗 Membuka ytmp3.cc — download MP3 lalu upload di bawah.',
  tt: '🔗 Membuka TTDownloader — download audio lalu upload di bawah.',
  sc: '🔗 Membuka SoundCloudMP3 — download lalu upload di bawah.',
};

function openDownloader(platform) {
  const url = DOM.urlInput.value.trim();
  if (!url) {
    showToast('⚠️ Paste link URL dulu!', 'error');
    DOM.urlInput.focus();
    return;
  }
  const target = PLATFORM_URLS[platform](url);
  DOM.tipText.textContent = PLATFORM_TIPS[platform];
  DOM.downloaderTip.style.display = 'flex';
  window.open(target, '_blank');
}

DOM.btnYt.addEventListener('click', () => openDownloader('yt'));
DOM.btnTt.addEventListener('click', () => openDownloader('tt'));
DOM.btnSc.addEventListener('click', () => openDownloader('sc'));

DOM.urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') openDownloader('yt');
});

// ── Waveform playback controls ─────────────────────────────
DOM.wcPlay.addEventListener('click', () => {
  if (!window.WaveformModule) return;
  if (AppState.isPlaying) {
    window.WaveformModule.pause();
    DOM.wcPlay.textContent = '▶';
    AppState.isPlaying = false;
  } else {
    window.WaveformModule.play();
    DOM.wcPlay.textContent = '⏸';
    AppState.isPlaying = true;
  }
});

DOM.wcStop.addEventListener('click', () => {
  if (!window.WaveformModule) return;
  window.WaveformModule.stop();
  DOM.wcPlay.textContent = '▶';
  AppState.isPlaying = false;
});

DOM.wcVol.addEventListener('input', () => {
  if (window.WaveformModule) {
    window.WaveformModule.setVolume(parseFloat(DOM.wcVol.value));
  }
});

// Called by waveform.js to update seek + time display
window.onWaveformTimeUpdate = function(current, total) {
  DOM.wcTime.textContent = `${fmtTime(current)} / ${fmtTime(total)}`;
  if (total > 0) DOM.wcSeek.value = (current / total) * 100;
};

window.onWaveformFinish = function() {
  DOM.wcPlay.textContent = '▶';
  AppState.isPlaying = false;
};

DOM.wcSeek.addEventListener('input', () => {
  if (window.WaveformModule) {
    window.WaveformModule.seekTo(parseFloat(DOM.wcSeek.value) / 100);
  }
});

// ── Preview ────────────────────────────────────────────────
function doPreview() {
  if (!AppState.audioFile) {
    showToast('⚠️ Upload audio dulu!', 'error');
    return;
  }
  if (window.WaveformModule) {
    window.WaveformModule.play();
    DOM.wcPlay.textContent = '⏸';
    AppState.isPlaying = true;
  }
}

DOM.btnPreviewTop.addEventListener('click', doPreview);
DOM.btnPreviewMain.addEventListener('click', doPreview);

// ── Progress helpers ───────────────────────────────────────
function showProgress(pct, label) {
  DOM.progressWrap.style.display = 'flex';
  DOM.progressFill.style.width   = pct + '%';
  DOM.progressLabel.textContent  = label;
}

function hideProgress() {
  DOM.progressWrap.style.display = 'none';
  DOM.progressFill.style.width   = '0%';
}

// ── Main Process ────────────────────────────────────────────
DOM.btnProcess.addEventListener('click', async () => {
  if (AppState.isProcessing) return;

  if (!AppState.audioFile) {
    showToast('⚠️ Upload audio dulu sebelum remix!', 'error');
    return;
  }

  AppState.isProcessing = true;
  DOM.btnProcess.disabled = true;
  DOM.processLabel.textContent = 'MEMPROSES...';
  DOM.resultPanel.style.display = 'none';

  try {
    showProgress(10, 'Membaca file audio...');
    await sleep(200);

    showProgress(20, 'Ghost Mode — warping frequency axis...');
    await sleep(200);

    showProgress(35, 'Pitch shift + spectral smear...');
    await sleep(200);

    showProgress(50, 'Stereo decorrelation + EQ...');
    await sleep(200);

    showProgress(65, 'OLA transient smear + sub-bass reshape...');
    // Inject current preset key so remixer picks the right bypass profile
    const paramsWithPreset = {
      ...AppState.remixParams,
      _preset: AppState.currentPreset || 'nocopyright',
    };
    // Call remixer
    let resultBlob = null;
    if (window.RemixerModule) {
      resultBlob = await window.RemixerModule.process(AppState.audioFile, paramsWithPreset);
    } else {
      // Fallback: just return the original (modules not loaded yet)
      resultBlob = AppState.audioFile;
    }

    showProgress(80, 'Window misalignment + encoding MP3...');
    await sleep(300);

    showProgress(95, 'Menyiapkan file output...');
    await sleep(300);

    showProgress(100, 'Selesai!');
    await sleep(400);

    // Store result
    AppState.resultBlob = resultBlob;
    if (AppState.resultUrl) URL.revokeObjectURL(AppState.resultUrl);
    AppState.resultUrl = URL.createObjectURL(resultBlob);

    hideProgress();

    // Show result panel
    const preset  = AppState.currentPreset || 'custom';
    const fmt     = window.lamejs ? 'MP3 128kbps' : 'WAV';
    const origMB  = (AppState.audioFile.size / 1048576).toFixed(1);
    const estMB   = window.lamejs
      ? (AppState.audioFile.size / 1048576 * 1.05).toFixed(1)  // ~same size as input
      : (AppState.audioFile.size / 1048576 * 10).toFixed(1);   // WAV is ~10x bigger warning
    DOM.resultMeta.textContent =
      `Preset: ${preset} · Format: ${fmt} · Input: ${origMB}MB → Output: ~${estMB}MB`;
    DOM.resultPanel.style.display = 'block';

    // Add to history
    if (window.PlaylistModule) {
      window.PlaylistModule.addToHistory({
        name:   AppState.audioFile.name,
        preset: preset,
        url:    AppState.resultUrl,
      });
    } else {
      addHistoryItemFallback(AppState.audioFile.name, preset);
    }

    showToast('✅ Remix berhasil! Siap didownload.', 'success');

  } catch (err) {
    hideProgress();
    showToast('❌ Error: ' + (err.message || 'Proses gagal'), 'error');
    console.error('[AudioRobloxBY] Process error:', err);
  } finally {
    AppState.isProcessing = false;
    DOM.btnProcess.disabled = false;
    DOM.processLabel.textContent = 'PROSES REMIX';
  }
});

// ── Download result ────────────────────────────────────────
DOM.btnDownload.addEventListener('click', () => {
  if (!AppState.resultUrl) return;
  // Randomized filename — strips metadata hint, helps avoid Roblox name-matching
  const randomName = window.RemixerModule?.randomFilename() || ('arb_' + Math.random().toString(36).slice(2,8));
  const ext  = window.lamejs ? 'mp3' : 'wav'; // MP3 if lamejs loaded, WAV fallback
  const a    = document.createElement('a');
  a.href     = AppState.resultUrl;
  a.download = `${randomName}.${ext}`;
  a.click();
  showToast('⬇ Mendownload...', 'success');
});

// ── Save to playlist ───────────────────────────────────────
DOM.btnSavePlaylist.addEventListener('click', () => {
  if (window.PlaylistModule) {
    window.PlaylistModule.saveToPlaylist(AppState.resultUrl, AppState.audioFile?.name);
  } else {
    showToast('♪ Disimpan ke playlist!', 'success');
  }
});

// ── Favorite ───────────────────────────────────────────────
let favCount = parseInt(localStorage.getItem('arb_fav_count') || '0');
DOM.favCount.textContent = favCount;

DOM.btnFav.addEventListener('click', () => {
  favCount++;
  DOM.favCount.textContent = favCount;
  localStorage.setItem('arb_fav_count', favCount);
  DOM.btnFav.textContent = '★ Difavoritkan!';
  showToast('⭐ Ditambahkan ke Favorit!', 'success');
});

// ── New playlist (sidebar + right panel) ───────────────────
function createPlaylist() {
  const name = prompt('Nama playlist baru:');
  if (!name || !name.trim()) return;
  const item = document.createElement('div');
  item.className = 'playlist-item';
  item.textContent = '♪ ' + name.trim();
  DOM.sidebarPlaylists.appendChild(item);
  DOM.rpEmpty.style.display = 'none';
  showToast(`♪ Playlist "${name.trim()}" dibuat!`, 'success');
}

DOM.btnNewPlaylist.addEventListener('click', createPlaylist);
DOM.rpNew.addEventListener('click', createPlaylist);

// ── Remix history fallback ─────────────────────────────────
function addHistoryItemFallback(name, preset) {
  DOM.rpEmpty.style.display = 'none';
  const item = document.createElement('div');
  item.className = 'history-item';
  const shortName = name.length > 28 ? name.slice(0, 26) + '…' : name;
  item.innerHTML = `
    <div class="hi-thumb">♪</div>
    <div class="hi-info">
      <div class="hi-name">Remix – ${shortName}</div>
      <div class="hi-meta">${preset}</div>
    </div>
    <div class="hi-dur">${new Date().toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit'})}</div>
  `;
  DOM.remixHistory.prepend(item);
}

// ── Utils ──────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Expose state for modules ───────────────────────────────
window.AppState = AppState;
window.showToast = showToast;
window.applyParamsToUI = applyParamsToUI;

// ── Init ───────────────────────────────────────────────────
(function init() {
  // Apply default preset (Auto No Copyright) on load
  const defaultChip = document.querySelector('.chip[data-preset="nocopyright"]');
  if (defaultChip && window.PRESETS) {
    applyParamsToUI(window.PRESETS['nocopyright']);
  }

  console.log('%c AudioRobloxBY v1.0.0 ', 'background:#7c3aed;color:#fff;font-weight:bold;border-radius:4px;padding:2px 8px;');
  console.log('%c Anti Copyright Remix Studio — Ready! ', 'color:#00e5cc;');
})();
