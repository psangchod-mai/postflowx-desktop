// scripts/auth/media-coordinator.js — PostFlowX Media Playback Arbitration
// Ensures only one tab plays media at a time.
// Uses BroadcastChannel; keeps playback allowed by default because media play
// is not part of the canonical AccessControl action set.
// Exposed as window.PFX_MEDIA_COORD

window.PFX_MEDIA_COORD = (() => {
  'use strict';

  const CHANNEL_NAME = 'pfx-media-playback';
  const _tabId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let _ch          = null;
  let _isPlaying   = false;
  let _onPause     = null; // (reason: string) => void

  function _canPlay() {
    const perms = window.PFX_PERMISSIONS;
    const actions = perms?.getSession?.()?.permissions?.actions || [];
    if (!actions.length || actions.includes('*') || actions.includes('play_media')) return true;
    // Playback is not part of the canonical AccessControl action set, so keep it
    // allowed unless a future policy explicitly introduces a dedicated control.
    return !actions.includes('block_play_media');
  }

  function _handle(e) {
    const m = e.data;
    if (m?.type !== 'PLAY_CLAIM') return;
    if (m.tabId === _tabId) return;
    // Another tab claimed playback — pause this one
    if (_isPlaying) {
      _isPlaying = false;
      _onPause?.('Another tab started playing');
    }
  }

  /**
   * Initialize with an optional pause callback.
   * @param {(reason: string) => void} onPause
   */
  function init(onPause) {
    _onPause = onPause;
    try {
      _ch = new BroadcastChannel(CHANNEL_NAME);
      _ch.onmessage = _handle;
    } catch (e) {
      console.warn('[PFX Media] BroadcastChannel unavailable:', e.message);
    }
  }

  /**
   * Claim exclusive playback for this tab.
   * @returns {boolean} true if allowed, false if denied
   */
  function claimPlayback() {
    if (!_canPlay()) {
      window.PFX_GUARD?.toast?.('Playback is not allowed for this account', 'deny');
      return false;
    }
    _isPlaying = true;
    try { _ch?.postMessage({ type: 'PLAY_CLAIM', tabId: _tabId, ts: Date.now() }); } catch {}
    return true;
  }

  /** Release playback claim (on pause/stop). */
  function releasePlayback() {
    _isPlaying = false;
  }

  return { init, claimPlayback, releasePlayback };
})();
