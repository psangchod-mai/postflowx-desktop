// conform/timelineFormats.js — canonical timeline-format registry.
//
// Single source of truth for which editorial-timeline containers PostFlowX
// accepts, so the drop zone, the file-picker `accept` attribute, and the
// parse router all agree (they had drifted: some lists lacked .prproj/.drp).
// Pure + no DOM → unit-testable.
'use strict';

// Returned by the router for a DaVinci Resolve native project: there is no
// stable public .drp schema, so we guide the user to export an interchange
// format PostFlowX parses today rather than emit wrong timecodes.
export const DRP_HINT = 'DRP_EXPORT_OTIO';

// Every timeline container accepted as a drop/import (lowercase, dot-prefixed).
export const TIMELINE_EXTS = Object.freeze([
  '.edl', '.otio', '.otioz', '.fcpxml', '.fcpxmld', '.xml', '.aaf', '.ale', '.prproj', '.drp',
]);

// Comma-joined for an <input accept="…"> attribute.
export const TIMELINE_ACCEPT = TIMELINE_EXTS.join(',');

export function extOf(nameOrFile) {
  const name = typeof nameOrFile === 'string' ? nameOrFile : (nameOrFile && nameOrFile.name) || '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function isTimelineFile(nameOrFile) {
  return TIMELINE_EXTS.includes(extOf(nameOrFile));
}

// Resolve a file to a routing decision: which parser family handles it, or the
// DRP export hint. parseFromFiles delegates DRP handling to this; the parser
// families stay where they are. `kind: null` means "not a timeline file".
export function routeTimelineFile(nameOrFile) {
  switch (extOf(nameOrFile)) {
    case '.edl':                 return { kind: 'edl' };
    case '.ale':                 return { kind: 'ale' };
    case '.otio':  case '.otioz': return { kind: 'otio' };
    case '.fcpxml': case '.fcpxmld': return { kind: 'fcpxml' };
    case '.xml':                 return { kind: 'xml' };       // FCPXML or XMEML — sniffed by content
    case '.aaf':                 return { kind: 'aaf' };
    case '.prproj':              return { kind: 'prproj' };
    case '.drp':                 return { kind: 'drp', hint: DRP_HINT, events: [] };
    default:                     return { kind: null };
  }
}

// Typed result parseFromFiles returns for a dropped .drp — no crash, no silent
// empty; the UI renders the hint as a "export OTIO/AAF/FCPXML" tip.
export function drpHintResult() {
  return { events: [], _hint: DRP_HINT };
}
