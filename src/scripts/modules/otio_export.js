// scripts/modules/otio_export.js
// Builds a valid OpenTimelineIO JSON object from PostFlowX Prep & Mark data.
//
// Four export modes (caller pre-filters events for all/conform/vfxrename;
// vfxmarker mode is handled inside using linkMap + all markers):
//   'all'        — every event, every linked marker
//   'conform'    — camera-original events (caller strips _pmConformSkip)
//   'vfxrename'  — OCF events with _pmShot applied as clip name
//   'vfxmarker'  — one Clip.2 per linked VFX marker (uses opts._allEvents)

// ── Helpers ───────────────────────────────────────────────────────────────────

function _tcToF(tc, fps) {
  if (!tc) return 0;
  const parts = String(tc).split(':');
  if (parts.length !== 4) return 0;
  const [hh, mm, ss, ff] = parts.map(Number);
  return ((hh * 3600 + mm * 60 + ss) * Math.round(fps || 24)) + ff;
}

function _rt(value, rate) {
  return { 'OTIO_SCHEMA': 'RationalTime.1', rate: Math.round(rate || 24), value: Math.max(0, Math.round(value || 0)) };
}

function _range(startF, durF, fps) {
  const r = Math.round(fps || 24);
  return {
    'OTIO_SCHEMA': 'TimeRange.1',
    start_time: _rt(startF, r),
    duration:   _rt(Math.max(1, durF), r),
  };
}

const _COLOR_MAP = {
  red: 'RED', green: 'GREEN', blue: 'BLUE', cyan: 'CYAN',
  yellow: 'YELLOW', magenta: 'MAGENTA', black: 'BLACK', white: 'WHITE',
};
function _otioColor(pfxColor) {
  return _COLOR_MAP[(pfxColor || 'green').toLowerCase()] || 'GREEN';
}

function _stemNoExt(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(0, i) : s;
}

// ── Marker builder ────────────────────────────────────────────────────────────

function _buildMarker(mk, clipSrcInF, fps) {
  const mkAbsF   = typeof mk.frame === 'number' ? mk.frame : _tcToF(mk.tc, fps);
  // Store marker position relative to the clip's source in-point
  const offsetF  = Math.max(0, mkAbsF - clipSrcInF);
  return {
    'OTIO_SCHEMA': 'Marker.1',
    name:          mk.shotName || mk.note || 'MARKER',
    color:         _otioColor(mk.color),
    marked_range:  _range(offsetF, 1, fps),
    metadata: {
      PostFlowX: {
        note:        mk.note        || '',
        noteType:    mk.noteType    || '',
        scopeOfWork: mk.scopeOfWork || '',
        vendor:      mk.vendor      || '',
      },
    },
  };
}

// ── Clip builder ──────────────────────────────────────────────────────────────

function _buildClip(ev, fps, embeddedMarkers, mode, aleMap, statusMap) {
  const clipName = (mode === 'vfxrename' || mode === 'vfxmarker') && ev._pmShot
    ? ev._pmShot
    : (ev.clipName || ev.reel || 'CLIP');

  const srcFile  = ev.srcFile || (ev.reel ? ev.reel + '.mxf' : '');
  const reel     = ev.reel || _stemNoExt(srcFile) || 'REEL';
  const aleKey   = aleMap?.get?.(`${reel}|${ev.srcIn || ''}`) || null;
  const tapeName = aleKey?.Tape || reel;

  const srcInF  = _tcToF(ev.srcIn  || '00:00:00:00', fps);
  const srcOutF = _tcToF(ev.srcOut || '00:00:00:00', fps);
  const recInF  = _tcToF(ev.recIn  || '00:00:00:00', fps);
  const recOutF = _tcToF(ev.recOut || '00:00:00:00', fps);

  const srcDurF = Math.max(1, srcOutF - srcInF);
  const recDurF = Math.max(1, recOutF - recInF);

  const statusKey  = `${reel}|${ev.srcIn || ''}`;
  const shotStatus = statusMap?.get?.(statusKey) || 'none';

  const markers = (embeddedMarkers || []).map(mk => _buildMarker(mk, srcInF, fps));

  return {
    'OTIO_SCHEMA':   'Clip.2',
    name:            clipName,
    source_range:    _range(srcInF, srcDurF, fps),
    range_in_parent: _range(recInF, recDurF, fps),
    media_reference: {
      'OTIO_SCHEMA':   'ExternalReference.1',
      target_url:      srcFile ? `file:///${srcFile}` : '',
      available_range: _range(srcInF, srcDurF, fps),
      metadata: { PostFlowX: { reel: tapeName, srcFile } },
    },
    markers,
    metadata: {
      PostFlowX: {
        reel:     tapeName,
        srcFile,
        status:   shotStatus,
        shotName: ev._pmShot || '',
      },
    },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a valid OTIO JSON object from Prep & Mark data.
 *
 * @param {Array}  events    — filtered _pmEvents (caller applies mode filter)
 * @param {Array}  markers   — _pmClipMarkers (all markers)
 * @param {Map}    linkMap   — markerId → index into _allEvents (or events in non-vfxmarker mode)
 * @param {object} opts      — { mode, fps, projectName, aleMap, statusMap, _allEvents }
 * @returns {object} OTIO-schema-compliant plain JS object — JSON.stringify directly
 */
export function buildOTIOJSON(events, markers, linkMap, opts) {
  const {
    mode        = 'all',
    fps         = 24,
    projectName = 'PostFlowX',
    aleMap,
    statusMap,
    _allEvents,   // full unfiltered _pmEvents — needed for vfxmarker index lookups
  } = opts || {};

  const fps_         = Math.round(fps || 24);
  const globalStartF = fps_ * 3600; // 01:00:00:00

  let clips = [];

  if (mode === 'vfxmarker') {
    // ── VFX Marker: one clip per linked marker ────────────────────────────────
    const srcEvents = _allEvents || events; // need the full array for index lookup

    const pairs = [];
    for (const mk of (markers || [])) {
      const evIdx = linkMap?.get?.(mk.id);
      if (evIdx === undefined) continue;
      const ev = srcEvents[evIdx];
      if (!ev) continue;
      pairs.push({ mk, ev });
    }

    // Sort chronologically by marker absolute frame / TC
    pairs.sort((a, b) => {
      const aF = typeof a.mk.frame === 'number' ? a.mk.frame : _tcToF(a.mk.tc, fps_);
      const bF = typeof b.mk.frame === 'number' ? b.mk.frame : _tcToF(b.mk.tc, fps_);
      return aF - bF;
    });

    for (const { mk, ev } of pairs) {
      const evOverride = { ...ev, _pmShot: mk.shotName || ev._pmShot || ev.clipName };
      clips.push(_buildClip(evOverride, fps_, [mk], mode, aleMap, statusMap));
    }

  } else {
    // ── All / Conform / VFX Rename: one clip per event ────────────────────────
    const srcEvents = _allEvents || events;

    // Build map: event object → linked markers
    const mksByEv = new Map();
    for (const mk of (markers || [])) {
      const evIdx = linkMap?.get?.(mk.id);
      if (evIdx === undefined) continue;
      const ev = srcEvents[evIdx];
      if (!ev) continue;
      if (!mksByEv.has(ev)) mksByEv.set(ev, []);
      mksByEv.get(ev).push(mk);
    }

    for (const ev of (events || [])) {
      const embedded = mksByEv.get(ev) || [];
      clips.push(_buildClip(ev, fps_, embedded, mode, aleMap, statusMap));
    }
  }

  return {
    'OTIO_SCHEMA':     'Timeline.1',
    name:              projectName,
    global_start_time: _rt(globalStartF, fps_),
    tracks: {
      'OTIO_SCHEMA': 'Stack.1',
      name:          '',
      markers:       [],
      children: [
        {
          'OTIO_SCHEMA': 'Track.1',
          kind:          'Video',
          name:          'V1',
          markers:       [],
          children:      clips,
        },
      ],
    },
  };
}
