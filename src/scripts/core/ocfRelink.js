// OCF Relink — Phase 1.
// Scores OCF index entries against ShotWorkItems and auto-links high-confidence matches.
(function () {
  'use strict';

  // ── Scoring constants ────────────────────────────────────────────────────
  const S = {
    CLIP_EXACT:       50,
    REEL_MATCH:       20,
    TC_OVERLAP:       20,
    DURATION_MATCH:   10,
    FPS_MATCH:        10,
    CAMERA_MATCH:      5,
    EXT_MATCH:         5,
    FPS_MISMATCH:    -50,
    NO_TC_OVERLAP:   -50,
    REEL_MISMATCH:   -20,
    DURATION_MISMATCH: -20,
  };

  const AUTO_LINK_THRESHOLD  = 90;
  const CANDIDATE_THRESHOLD  = 70;

  // ── TC helpers ────────────────────────────────────────────────────────────
  function _tcToFrames(tc, fps) {
    if (typeof window.tcToFrames === 'function') return window.tcToFrames(tc, fps) || 0;
    if (!tc || !fps) return 0;
    const parts = tc.split(':').map(Number);
    if (parts.length !== 4) return 0;
    const [h, m, s, f] = parts;
    return ((h * 3600 + m * 60 + s) * fps + f) | 0;
  }

  function _tcOverlap(aIn, aOut, bIn, bOut, fps) {
    const a0 = _tcToFrames(aIn, fps);
    const a1 = _tcToFrames(aOut, fps);
    const b0 = _tcToFrames(bIn, fps);
    const b1 = _tcToFrames(bOut, fps);
    if (!a0 && !a1) return null; // no TC data
    if (!b0 && !b1) return null;
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  // ── Score one SWI against one OCF entry ──────────────────────────────────
  function scoreCandidate(swi, entry) {
    let score = 0;
    const reasons = [];
    const warnings = [];
    const fps = swi.fps || 24;

    // Clip/file stem match
    const swiStem = (swi.sourceClipName || swi.editorialClipName || swi.shotName || '')
      .split('.')[0].toLowerCase().trim();
    const ocfStem = (entry.fileStem || '').toLowerCase().trim();

    if (swiStem && ocfStem && swiStem === ocfStem) {
      score += S.CLIP_EXACT;
      reasons.push('exact clip match');
    } else if (swiStem && ocfStem && (ocfStem.includes(swiStem) || swiStem.includes(ocfStem))) {
      score += Math.floor(S.CLIP_EXACT * 0.6);
      reasons.push('partial clip match');
    }

    // Reel match
    if (swi.reel && entry.reel) {
      if (swi.reel === entry.reel) {
        score += S.REEL_MATCH;
        reasons.push('reel match');
      } else {
        score += S.REEL_MISMATCH;
        warnings.push(`reel mismatch: ${swi.reel} vs ${entry.reel}`);
      }
    }

    // TC overlap
    if (entry.startTc && entry.endTc && swi.srcTcIn && swi.srcTcOut) {
      const overlap = _tcOverlap(swi.srcTcIn, swi.srcTcOut, entry.startTc, entry.endTc, fps);
      if (overlap === null) {
        // No TC data on one side — can't score
      } else if (overlap > 0) {
        score += S.TC_OVERLAP;
        reasons.push(`TC overlap: ${overlap} frames`);
      } else {
        score += S.NO_TC_OVERLAP;
        warnings.push('no TC overlap');
      }
    }

    // Duration match (within 5% tolerance)
    if (swi.durationFrames && entry.durationFrames) {
      const diff = Math.abs(swi.durationFrames - entry.durationFrames);
      const tol  = Math.ceil(swi.durationFrames * 0.05);
      if (diff <= tol) {
        score += S.DURATION_MATCH;
        reasons.push('duration match');
      } else {
        score += S.DURATION_MISMATCH;
        warnings.push(`duration mismatch: ${swi.durationFrames} vs ${entry.durationFrames}`);
      }
    }

    // FPS match
    if (swi.fps && entry.fps) {
      const fpsDiff = Math.abs(swi.fps - entry.fps);
      if (fpsDiff < 0.1) {
        score += S.FPS_MATCH;
        reasons.push('fps match');
      } else {
        // Softer penalty for 23.976 ↔ 24.0 near-miss; steep for genuine mismatches (24 vs 30)
        score += fpsDiff < 0.1 ? -10 : S.FPS_MISMATCH;
        warnings.push(`fps mismatch: ${swi.fps} vs ${entry.fps}`);
      }
    }

    // Camera family match
    if (swi.camera && entry.camera && swi.camera !== 'UNKNOWN' && entry.camera !== 'UNKNOWN') {
      if (swi.camera === entry.camera) {
        score += S.CAMERA_MATCH;
        reasons.push('camera match');
      }
    }

    // Extension / folder pattern
    const expectedExts = _expectedExts(swi.camera);
    if (entry.extension && expectedExts.has(entry.extension)) {
      score += S.EXT_MATCH;
      reasons.push('expected extension');
    }

    return { ocfId: entry.ocfId, path: entry.path, score, reasons, warnings };
  }

  function _expectedExts(camera) {
    if (camera === 'RED')  return new Set(['.r3d']);
    if (camera === 'ARRI') return new Set(['.ari', '.arx', '.mxf']);
    if (camera === 'SONY') return new Set(['.mxf', '.mov']);
    return new Set(['.mxf', '.mov', '.ari', '.arx', '.r3d']);
  }

  // ── Relink one SWI ────────────────────────────────────────────────────────
  async function relinkOne(swi) {
    if (!swi?.shotWorkId) return null;
    if (swi.ocf?.ocfLinkLocked) return null; // respect manual lock

    if (!window.PFX_OCF_INDEX) {
      return { ocfStatus: 'missing', state: 'ocf_index_required' };
    }

    const count = await window.PFX_OCF_INDEX.getCount();
    if (count === 0) {
      return { ocfStatus: 'missing', state: 'ocf_index_required' };
    }

    const entries = await window.PFX_OCF_INDEX.getAll();
    let candidates = entries
      .map(e => scoreCandidate(swi, e))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    // Apply relink memory boosts (reel aliases)
    if (window.PFX_RELINK_MEMORY && candidates.length) {
      candidates = window.PFX_RELINK_MEMORY.boostCandidates(swi, candidates, entries);
    }

    if (!candidates.length) {
      return {
        ocfStatus: 'missing',
        state:     'ocf_missing',
        ocf: { status: 'missing', candidates: [] },
      };
    }

    const best = candidates[0];

    if (best.score >= AUTO_LINK_THRESHOLD) {
      const entry = entries.find(e => e.ocfId === best.ocfId);
      return {
        ocfStatus: 'linked',
        state:     'ocf_linked',
        ocf: {
          status:     'linked',
          path:       best.path,
          ocfId:      best.ocfId,
          score:      best.score,
          method:     'auto',
          candidates: candidates.slice(0, 5),
          linkedAt:   new Date().toISOString(),
          linkedBy:   'auto_relink',
        },
        camera: entry?.camera || swi.camera,
      };
    }

    if (best.score >= CANDIDATE_THRESHOLD) {
      return {
        ocfStatus: 'candidate',
        state:     'ocf_candidate',
        ocf: {
          status:     'candidate',
          score:      best.score,
          candidates: candidates.slice(0, 5),
        },
      };
    }

    return {
      ocfStatus: 'missing',
      state:     'ocf_missing',
      ocf: { status: 'missing', score: best.score, candidates: candidates.slice(0, 3) },
    };
  }

  // ── Relink all SWIs for current project ───────────────────────────────────
  async function relinkMarkers(filter) {
    if (!window.PFX_SWI) return { ok: false, error: 'SWI module not loaded' };
    const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
    const all = await window.PFX_SWI.getAll(projectId);
    const items = (filter === 'vfx' ? all.filter(s => s.markerType === 'VFX') : all)
      .filter(s => s.enabled !== false);

    let linked = 0, candidate = 0, missing = 0;
    for (const swi of items) {
      const patch = await relinkOne(swi);
      if (patch) {
        await window.PFX_SWI.update(swi.shotWorkId, patch);
        if (patch.ocfStatus === 'linked')    linked++;
        else if (patch.ocfStatus === 'candidate') candidate++;
        else missing++;
      }
    }

    try { if (typeof window._pmRenderEventTable === 'function') window._pmRenderEventTable(); } catch { }

    return { ok: true, total: items.length, linked, candidate, missing };
  }

  // ── Manual link ───────────────────────────────────────────────────────────
  async function manualLink(shotWorkId, ocfEntry) {
    if (!window.PFX_SWI) return { ok: false };
    const patch = {
      ocfStatus: 'linked',
      state:     'ocf_linked',
      ocf: {
        status:        'linked',
        path:          ocfEntry.path,
        ocfId:         ocfEntry.ocfId,
        score:         100,
        method:        'manual',
        ocfLinkLocked: true,
        linkedAt:      new Date().toISOString(),
        linkedBy:      'user',
        candidates:    [],
      },
    };
    await window.PFX_SWI.update(shotWorkId, patch);

    // Record in relink memory for future scoring boosts
    try {
      const swi = await window.PFX_SWI.getById(shotWorkId);
      if (swi?.markerId && window.PFX_RELINK_MEMORY) {
        window.PFX_RELINK_MEMORY.recordManualLink(swi.markerId, ocfEntry);
        if (swi.reel && ocfEntry.reel && swi.reel !== ocfEntry.reel) {
          window.PFX_RELINK_MEMORY.recordReelAlias(swi.reel, ocfEntry.reel);
        }
      }
    } catch {}

    return { ok: true };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_OCF_RELINK = {
    scoreCandidate,
    relinkOne,
    relinkMarkers,
    manualLink,
    AUTO_LINK_THRESHOLD,
    CANDIDATE_THRESHOLD,
  };

  console.info('[OCF_RELINK] OCF Relink module ready');
})();
