/* ============================================================
   AudioRobloxBY — modules/playlist.js
   Playlist management + remix history (localStorage)
   ============================================================ */

'use strict';

window.PlaylistModule = (function () {

  const STORAGE_KEY_HISTORY   = 'arb_remix_history';
  const STORAGE_KEY_PLAYLISTS = 'arb_playlists';
  const STORAGE_KEY_FAVS      = 'arb_favorites';
  const MAX_HISTORY           = 50;

  // ── Load from localStorage ─────────────────────────────
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || '[]');
    } catch (_) { return []; }
  }

  function saveHistory(items) {
    try { localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(items.slice(0, MAX_HISTORY))); }
    catch (_) {}
  }

  function loadPlaylists() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_PLAYLISTS) || '[]');
    } catch (_) { return []; }
  }

  function savePlaylists(lists) {
    try { localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(lists)); }
    catch (_) {}
  }

  function loadFavorites() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_FAVS) || '[]');
    } catch (_) { return []; }
  }

  function saveFavorites(favs) {
    try { localStorage.setItem(STORAGE_KEY_FAVS, JSON.stringify(favs)); }
    catch (_) {}
  }

  // ── Add remix to history ───────────────────────────────
  function addToHistory({ name, preset, url }) {
    const history = loadHistory();
    const entry   = {
      id:        Date.now(),
      name:      name || 'Untitled',
      preset:    preset || 'custom',
      url:       url || null,
      timestamp: new Date().toISOString(),
    };
    history.unshift(entry);
    saveHistory(history);
    renderHistory();
    return entry;
  }

  // ── Save result to a named playlist ───────────────────
  function saveToPlaylist(url, name) {
    const playlists = loadPlaylists();
    if (playlists.length === 0) {
      const pName = prompt('Buat playlist baru — nama playlist:');
      if (!pName?.trim()) return;
      playlists.push({ id: Date.now(), name: pName.trim(), items: [] });
    }

    // If multiple playlists, ask which one
    let targetIdx = 0;
    if (playlists.length > 1) {
      const names = playlists.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
      const choice = prompt(`Pilih playlist (masukkan nomor):\n${names}`);
      targetIdx = Math.max(0, parseInt(choice || '1') - 1);
    }

    playlists[targetIdx].items.push({
      id:        Date.now(),
      name:      name || 'Remix',
      url:       url || null,
      addedAt:   new Date().toISOString(),
    });

    savePlaylists(playlists);
    renderSidebarPlaylists();

    const pName = playlists[targetIdx].name;
    if (window.showToast) window.showToast(`♪ Disimpan ke "${pName}"`, 'success');
  }

  // ── Add to favorites ───────────────────────────────────
  function addToFavorites({ name, url, preset }) {
    const favs  = loadFavorites();
    const entry = { id: Date.now(), name, url, preset, savedAt: new Date().toISOString() };
    favs.unshift(entry);
    saveFavorites(favs);

    // Update badge
    const badge = document.getElementById('fav-count');
    if (badge) badge.textContent = favs.length;

    if (window.showToast) window.showToast('⭐ Ditambahkan ke Favorit!', 'success');
    return entry;
  }

  // ── Format relative time ───────────────────────────────
  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const min  = Math.floor(diff / 60000);
    if (min < 1)  return 'baru saja';
    if (min < 60) return `${min} menit lalu`;
    const hr = Math.floor(min / 60);
    if (hr < 24)  return `${hr} jam lalu`;
    return `${Math.floor(hr / 24)} hari lalu`;
  }

  // ── Render remix history (right panel) ────────────────
  function renderHistory() {
    const container = document.getElementById('remix-history');
    const emptyEl   = document.getElementById('rp-empty');
    if (!container) return;

    const history = loadHistory();

    if (history.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      container.innerHTML = '';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    container.innerHTML = history.slice(0, 20).map(item => `
      <div class="history-item" data-id="${item.id}">
        <div class="hi-thumb">♪</div>
        <div class="hi-info">
          <div class="hi-name">Remix – ${escHtml(truncate(item.name, 26))}</div>
          <div class="hi-meta">${escHtml(item.preset)} · ${relTime(item.timestamp)}</div>
        </div>
        <div class="hi-dur">${new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `).join('');
  }

  // ── Render sidebar playlists ───────────────────────────
  function renderSidebarPlaylists() {
    const container = document.getElementById('sidebar-playlists');
    if (!container) return;
    const playlists = loadPlaylists();
    container.innerHTML = playlists.map(p => `
      <div class="playlist-item" data-id="${p.id}">♪ ${escHtml(p.name)} (${p.items.length})</div>
    `).join('');
  }

  // ── Utils ──────────────────────────────────────────────
  function truncate(str, max) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Init on load ───────────────────────────────────────
  function init() {
    renderHistory();
    renderSidebarPlaylists();

    // Update fav badge
    const badge = document.getElementById('fav-count');
    if (badge) badge.textContent = loadFavorites().length;
  }

  // Run init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }

  // ── Public API ─────────────────────────────────────────
  return {
    addToHistory,
    saveToPlaylist,
    addToFavorites,
    loadHistory,
    loadPlaylists,
    loadFavorites,
    renderHistory,
    renderSidebarPlaylists,
  };

})();

console.log('[Playlist] Module ready');