// packagePaths.js — PostFlowX VFX Pull
// Pure utility: compute on-disk subdir paths for a given shot/plate.
//
// Kept standalone so pullJobModel.js and smartExrPullPlanner.js can both
// import it without creating a circular dependency.
//
// Structure:
//   <outputBase>/<shotName>/
//     plates/<plateName>/ — EXR sequence
//     amf/                — ACES Metadata File sidecar
//     nuke/               — Nuke read setup
//     ae/                 — After Effects ExtendScript handoff (.jsx)
//     ref/                — optional review proxy/contact sheet
//     metadata/           — manifest, frame map (CSV + JSON), resize, color, QC
//
// Metadata files are named after the plateName (not shotName) so each plate
// version has its own sidecar set. review/ref files use shotName as the base
// since they are shared across all plates for that shot.

export function deriveShotNameFromPlate(plateName = '') {
  const safe = String(plateName || '').replace(/\s+/g, '_');
  // Strip trailing _<plateId>_v<version> — supports standard (BG01, PL01) and
  // advanced (smoke01, muzzleFlash01) plate IDs, plus 3-or-4-digit versions.
  return safe.replace(/_[A-Za-z]{2,}\d{2,}_v\d{3,}$/i, '') || safe || 'SHOT';
}

export function buildPackagePaths(outputBase, plateName, shotName = '') {
  const shot = shotName || deriveShotNameFromPlate(plateName);
  const root = [outputBase, shot].filter(Boolean).join('/');
  return {
    root,
    shotRoot: root,
    plates:   `${root}/plates`,
    exr:      `${root}/plates/${plateName}`,
    amf:      `${root}/amf`,
    metadata: `${root}/metadata`,
    review:   `${root}/ref`,
    ref:      `${root}/ref`,
    nuke:     `${root}/nuke`,
    ae:       `${root}/ae`,
    // Sidecar files keyed by plateName — each plate version gets its own set
    amfFile:        `${root}/amf/${plateName}.amf`,
    fdlFile:        `${root}/metadata/${plateName}.fdl.json`,
    manifestFile:   `${root}/metadata/${plateName}_manifest.json`,
    frameMapFile:   `${root}/metadata/${plateName}_frame_map.csv`,
    frameMapJsonFile: `${root}/metadata/${plateName}_frame_map.json`,
    geometryFile:   `${root}/metadata/${plateName}_resize.json`,
    resizeFile:     `${root}/metadata/${plateName}_resize.json`,
    colorFile:      `${root}/metadata/${plateName}_color_manifest.json`,
    pullReportFile: `${root}/metadata/${plateName}_manifest.json`,
    qcFile:         `${root}/metadata/${plateName}_qc.txt`,
    qcJsonFile:     `${root}/metadata/${plateName}_qc.json`,
    // Review files shared across plate versions for the same shot
    reviewMov:      `${root}/ref/${shot}_ref.mov`,
    contactSheet:   `${root}/ref/${shot}_contactsheet.jpg`,
    // Nuke script keyed by plateName
    nukeScript:     `${root}/nuke/${plateName}.nk`,
    nukeReadme:     `${root}/nuke/README.txt`,
    // After Effects ExtendScript (.jsx) handoff keyed by plateName.
    // Run in AE to build the per-shot comp (.aep) with framing/retime/color.
    aeScript:       `${root}/ae/${plateName}.jsx`,
    aeReadme:       `${root}/ae/README.txt`,
  };
}
