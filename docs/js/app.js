/* ============================================================
   musicVer · bootstrap
   ============================================================ */

(function (MV) {
  'use strict';

  function seedDemoHistory() {
    if (MV.store.state.demoSeeded || MV.store.state.recentlyPlayed.length) return;
    ['s1', 'a4', 's3', 'a2', 's12'].forEach((id) => {
      const song = MV.data.getSong(id);
      const album = MV.data.getAlbum(id);
      if (song) {
        MV.store.addRecentlyPlayed({ id: song.id, type: 'song', title: song.title, subtitle: song.artist, cover: song.cover });
      } else if (album) {
        MV.store.addRecentlyPlayed({ id: album.id, type: 'album', title: album.title, subtitle: album.artist, cover: album.cover });
      }
    });
    MV.store.setPreference('demoSeeded', true);
  }

  async function loadCatalogue() {
    if (!MV.api.isLive()) return;

    try {
      MV.discoverData = await MV.api.discover();
    } catch (error) {
      console.info('musicVer: catalogue load skipped', error.message);
    }

    try {
      const response = await MV.api.call('get_saved_songs');
      if (response && response.success && Array.isArray(response.songs)) {
        MV.localSongs = response.songs.map(MV.data.normalizeTrack).filter(Boolean);
      }
    } catch (error) {
      console.info('musicVer: local library load skipped', error.message);
    }
  }

  let backendLoaded = false;

  async function loadBackendState() {
    if (!MV.api.isLive()) return;

    try {
      const library = await MV.api.syncLibrary();
      if (library) MV.store.replaceLibrary(library);
    } catch (error) {
      console.info('musicVer: library sync skipped', error.message);
    }

    try {
      MV.ui.applyTheme(await MV.api.getTheme());
    } catch (error) {
      console.info('musicVer: theme load skipped', error.message);
    }

    try {
      const picture = await MV.api.getProfilePicture();
      if (picture) MV.store.setProfile('picture', picture);
    } catch (error) {
      console.info('musicVer: profile picture load skipped', error.message);
    }
  }

  async function syncBackend() {
    if (!MV.api.isLive() || backendLoaded) return;
    backendLoaded = true;
    await loadCatalogue();
    await loadBackendState();
    MV.ui.renderAll();
  }

  async function boot() {
    // Apply the saved choice before the first paint to avoid a light flash.
    MV.ui.applyTheme(MV.store.state.theme);
    seedDemoHistory();
    MV.ui.init();
    MV.player.applyAccent(MV.data.heroes[0].cover, 'musicVer');
    MV.player.notify();

    // The bridge is usually present before DOMContentLoaded in pywebview.
    // If it is not, the interface stays usable in preview mode until the
    // `pywebviewready` event below upgrades it.
    if (await MV.api.waitForBridge(900)) {
      await syncBackend();
    }

    window.addEventListener('pywebviewready', async () => {
      MV.ui.renderAccount();
      await syncBackend();
      MV.ui.renderAll();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) MV.player.notify();
    });

    const canRegisterWorker = 'serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
      !/Electron|MusicVer/i.test(navigator.userAgent || '');
    if (canRegisterWorker) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { scope: './' })
          .catch((error) => console.info('musicVer: offline shell not registered', error.message));
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.MV = window.MV || {});
