// Relink Memory — learns from manual links, reel aliases, and camera path patterns.
// Persists to localStorage; applied as score boosts in ocfRelink.js relinkOne().
(function () {
  'use strict';

  const LS_REEL_ALIASES = 'pfx.relink.reel_aliases';
  const LS_CAM_PATTERNS = 'pfx.relink.cam_patterns';
  const LS_MANUAL_LINKS = 'pfx.relink.manual_links';

  function _load(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || {}; } catch { return {}; }
  }
  function _loadArr(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  function _save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
  }

  // ── Manual link memory ────────────────────────────────────────────────────
  function recordManualLink(markerId, ocfEntry) {
    if (!markerId || !ocfEntry?.ocfId) return;
    const links = _load(LS_MANUAL_LINKS);
    links[markerId] = {
      ocfId:    ocfEntry.ocfId,
      path:     ocfEntry.path || '',
      lockedAt: new Date().toISOString(),
    };
    _save(LS_MANUAL_LINKS, links);
  }

  function getManualLink(markerId) {
    if (!markerId) return null;
    return _load(LS_MANUAL_LINKS)[markerId] || null;
  }

  // ── Reel alias memory ─────────────────────────────────────────────────────
  function recordReelAlias(reelA, reelB) {
    if (!reelA || !reelB || reelA === reelB) return;
    const aliases = _load(LS_REEL_ALIASES);
    if (!aliases[reelA]) aliases[reelA] = [];
    if (!aliases[reelA].includes(reelB)) aliases[reelA].push(reelB);
    if (!aliases[reelB]) aliases[reelB] = [];
    if (!aliases[reelB].includes(reelA)) aliases[reelB].push(reelA);
    _save(LS_REEL_ALIASES, aliases);
  }

  function getAliasedReels(reel) {
    if (!reel) return [];
    const aliases = _load(LS_REEL_ALIASES);
    return [reel, ...(aliases[reel] || [])];
  }

  // ── Camera pattern memory ─────────────────────────────────────────────────
  function recordCamPattern(pathSubstring, camera) {
    if (!pathSubstring || !camera) return;
    const patterns = _loadArr(LS_CAM_PATTERNS);
    if (!patterns.find(p => p.pattern === pathSubstring)) {
      patterns.push({ pattern: pathSubstring, camera });
      _save(LS_CAM_PATTERNS, patterns);
    }
  }

  function applyCamPatterns(path) {
    if (!path) return null;
    const patterns = _loadArr(LS_CAM_PATTERNS);
    for (const p of patterns) {
      if (path.includes(p.pattern)) return p.camera;
    }
    return null;
  }

  // ── Apply alias boosts to a candidate list ────────────────────────────────
  function boostCandidates(swi, candidates, entries) {
    if (!swi || !candidates?.length) return candidates;
    const aliasedReels = getAliasedReels(swi.reel || '');
    return candidates.map(c => {
      const entry = (entries || []).find(e => e.ocfId === c.ocfId);
      if (entry?.reel && aliasedReels.includes(entry.reel) && entry.reel !== swi.reel) {
        return { ...c, score: c.score + 10, reasons: [...(c.reasons || []), 'reel alias'] };
      }
      return c;
    }).sort((a, b) => b.score - a.score);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_RELINK_MEMORY = {
    recordManualLink,
    getManualLink,
    recordReelAlias,
    getAliasedReels,
    recordCamPattern,
    applyCamPatterns,
    boostCandidates,
  };

  console.info('[RELINK_MEMORY] Relink Memory module ready');
})();
