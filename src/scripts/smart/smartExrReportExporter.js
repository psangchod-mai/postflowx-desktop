// smartExrReportExporter.js — PostFlowX EXR pull report/package exporter

// Build the standard package folder structure manifest.
export function buildPackageManifest(jobs = [], qcResults = [], projectMeta = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const root = `PostFlowX_EXR_Pull_${ts}`;
  return {
    root,
    dirs: [
      `${root}/01_reports`,
      `${root}/02_timeline`,
      `${root}/03_metadata`,
      `${root}/04_thumbnails`,
      `${root}/05_reference/burnin_ref`,
      `${root}/06_exr`,
      `${root}/07_color/amf`,
      `${root}/07_color/ocio`,
      `${root}/07_color/lut`,
      `${root}/08_logs`,
      ...jobs.map(j => `${root}/06_exr/${j.plateName}`),
    ],
    files: _buildFileList(root, jobs, qcResults, projectMeta),
  };
}

function _buildFileList(root, jobs, qcResults, meta) {
  return [
    { path: `${root}/01_reports/pull_list.xlsx`, generator: 'xlsx' },
    { path: `${root}/01_reports/qc_report.pdf`,  generator: 'qc_pdf' },
    { path: `${root}/01_reports/contact_sheet.pdf`, generator: 'contact_pdf' },
    { path: `${root}/03_metadata/shots.csv`, generator: 'shots_csv' },
    { path: `${root}/03_metadata/markers.csv`, generator: 'markers_csv' },
    { path: `${root}/03_metadata/exr_jobs.json`, generator: 'jobs_json', data: jobs },
    { path: `${root}/03_metadata/match_report.json`, generator: 'match_json', data: jobs.map(j => ({
        shotId: j.shotId, plateName: j.plateName,
        matchConfidence: j.metadata?.matchConfidence,
        matchStatus: j.metadata?.matchStatus,
        sourcePath: j.sourcePath,
      }))
    },
    { path: `${root}/08_logs/export_log.txt`, generator: 'log' },
  ];
}

// Build CSV pull list content.
export function buildShotsCSV(jobs = []) {
  const header = [
    'Shot ID', 'Plate Name', 'Event #', 'Source File',
    'Source In', 'Source Out', 'Export In', 'Export Out',
    'FPS', 'Handles', 'Frame Start', 'Expected Frames',
    'Match Status', 'Match Confidence', 'Status', 'Notes',
  ].map(h => `"${h}"`).join(',');
  const rows = jobs.map(j => [
    j.shotId, j.plateName, j.eventNumber,
    (j.sourcePath || '').split('/').pop(),
    j.sourceIn, j.sourceOut, j.exportIn, j.exportOut,
    j.fps, j.handleFrames, j.frameStart, j.expectedFrameCount,
    j.metadata?.matchStatus || '', j.metadata?.matchConfidence || '',
    j.status || '', (j.metadata?.notes || '').replace(/,/g, ';'),
  ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  return [header, ...rows].join('\n');
}

// Build JSON job manifest.
export function buildJobsJSON(jobs = [], qcResults = []) {
  const qcMap = {};
  for (const r of qcResults) qcMap[r.plateName] = r;
  return JSON.stringify({
    version: '1.0',
    generated: new Date().toISOString(),
    jobCount: jobs.length,
    jobs: jobs.map(j => ({
      ...j,
      qc: qcMap[j.plateName] || null,
    })),
  }, null, 2);
}

// Build text QC report.
export function buildQCTextReport(qcResults = []) {
  const lines = [
    'PostFlowX EXR Pull — QC Report',
    `Generated: ${new Date().toLocaleString()}`,
    '─'.repeat(60),
    '',
  ];
  for (const r of qcResults) {
    lines.push(`Shot: ${r.shotId}  Plate: ${r.plateName}  [${r.qcStatus}]`);
    for (const iss of (r.issues || [])) {
      const icon = iss.severity === 'ERROR' ? '✗' : iss.severity === 'WARNING' ? '⚠' : '•';
      lines.push(`  ${icon} [${iss.code}] ${iss.message}${iss.detail ? ' — ' + iss.detail : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Build a CMX3600 EDL pull list from OCF jobs.
// Event line format matches reference: 001  REEL  V     C   srcIn srcOut recIn recOut
export function buildOcfPullEDL(jobs = [], projectName = 'OCF_PULL') {
  const stemNoExt = p => { const i = String(p||'').lastIndexOf('.'); return i > 0 ? p.slice(0, i) : p; };
  const lines = [
    `TITLE: ${projectName}`,
    'FCM: NON-DROP FRAME',
    '',
  ];
  jobs.forEach((j, idx) => {
    const ev   = String(idx + 1).padStart(3, '0');
    // Full stem, no truncation — matches conform pull EDL standard
    const reel = stemNoExt(j.metadata?.sourceReel || j.sourcePath?.split('/').pop() || j.plateName || 'REEL')
                   .replace(/[^\x20-\x7E]/g, '');
    const srcIn  = j.sourceIn  || '00:00:00:00';
    const srcOut = j.sourceOut || '00:00:00:00';
    const recIn  = j.exportIn  || '00:00:00:00';
    const recOut = j.exportOut || '00:00:00:00';
    lines.push(`${ev}  ${reel}  V     C   ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    const srcFile = j.sourcePath?.split('/').pop() || j.plateName || '';
    if (srcFile)    lines.push(`* SOURCE FILE: ${srcFile}`);
    if (j.plateName) lines.push(`* FROM CLIP NAME: ${j.plateName}`);
    lines.push('');
  });
  return lines.join('\n');
}

// Build a minimal XLSX (Office Open XML) for the OCF pull list.
// Uses raw XML — no external dependency.
export function buildOcfPullXlsx(jobs = [], qcResults = []) {
  const qcMap = {};
  for (const r of qcResults) qcMap[r.plateName] = r;

  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const cell = (v, type = 'str', idx) => {
    if (type === 'num') return `<c r="${idx}" t="n"><v>${Number(v) || 0}</v></c>`;
    const si = `<si><t>${esc(String(v ?? ''))}</t></si>`;
    return { cell: `<c r="${idx}" t="s"><v>PLACEHOLDER_${idx}</v></c>`, shared: si };
  };

  const headers = ['Shot ID','Plate','Event','Source File','Src In','Src Out','Exp In','Exp Out','FPS','Handles','Frame Start','Frames','Match %','Match Status','Job Status','QC Status','QC Issues','Notes'];
  const rows = jobs.map(j => {
    const qc = qcMap[j.plateName] || {};
    const qcIssues = (qc.issues || []).filter(i => i.severity !== 'INFO').map(i => i.message).join('; ');
    return [
      j.shotId, j.plateName, j.eventNumber,
      (j.sourcePath || '').split('/').pop(),
      j.sourceIn, j.sourceOut, j.exportIn, j.exportOut,
      j.fps, j.handleFrames, j.frameStart, j.expectedFrameCount,
      j.metadata?.matchConfidence ?? '', j.metadata?.matchStatus || '',
      j.status || '', qc.qcStatus || '', qcIssues,
      j.metadata?.notes || '',
    ];
  });

  // Shared strings
  const allStrings = [];
  const addStr = s => { const i = allStrings.length; allStrings.push(esc(String(s ?? ''))); return i; };

  const colLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const colLetter = i => i < 26 ? colLetters[i] : colLetters[Math.floor(i/26)-1] + colLetters[i%26];

  let rowsXml = '';
  // Header row
  rowsXml += `<row r="1">${headers.map((h,ci) => `<c r="${colLetter(ci)}1" t="s"><v>${addStr(h)}</v></c>`).join('')}</row>`;
  rows.forEach((r, ri) => {
    rowsXml += `<row r="${ri+2}">${r.map((v, ci) => {
      if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)) && ci >= 8 && ci <= 11)) {
        return `<c r="${colLetter(ci)}${ri+2}" t="n"><v>${Number(v)||0}</v></c>`;
      }
      return `<c r="${colLetter(ci)}${ri+2}" t="s"><v>${addStr(v)}</v></c>`;
    }).join('')}</row>`;
  });

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${allStrings.length}" uniqueCount="${allStrings.length}">
${allStrings.map(s => `<si><t xml:space="preserve">${s}</t></si>`).join('')}
</sst>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowsXml}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="OCF Pull List" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml"  ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // Return file map for ZIP creation
  return {
    '[Content_Types].xml':            contentTypes,
    '_rels/.rels':                    rootRels,
    'xl/workbook.xml':                workbookXml,
    'xl/_rels/workbook.xml.rels':     relsXml,
    'xl/worksheets/sheet1.xml':       sheetXml,
    'xl/sharedStrings.xml':           sharedStringsXml,
  };
}

// Build Resolve 21 handoff Python script for conform relink + EXR pull.
// Resolve 21 features referenced:
//   - "Automatically link to existing media pool clips" on DRT import (p.76)
//   - Automatic Smart Bin for Offline Clips (p.86)
//   - Custom ACES AMF folder in project settings (p.95)
export function buildResolveHandoffScript(jobs = [], opts = {}) {
  const { projectName = 'PostFlowX_Pull', amfFolder = '' } = opts;
  const validJobs = jobs.filter(j => j.sourcePath);

  const jobLines = validJobs.map(j =>
    `  {"shotId": "${j.shotId || ''}", "source": "${j.sourcePath || ''}", ` +
    `"srcIn": "${j.sourceIn || '00:00:00:00'}", "srcOut": "${j.sourceOut || '00:00:00:00'}", ` +
    `"expIn": "${j.exportIn || '00:00:00:00'}", "expOut": "${j.exportOut || '00:00:00:00'}", ` +
    `"outputDir": "${j.outputDir || ''}", "pattern": "${j.outputPattern || ''}", ` +
    `"fps": ${j.fps || 24}, "frameStart": ${j.frameStart || 1001}},`
  );

  const lines = [
    '#!/usr/bin/env python3',
    '# PostFlowX → DaVinci Resolve 21  |  Conform Relink + EXR Pull Handoff',
    '# Generated by PostFlowX',
    '#',
    '# HOW TO RUN:',
    '#   Workspace > Scripts > (place this script in your scripts folder)',
    '# OR: python3 this_script.py  (with Resolve open)',
    '#',
    '# RESOLVE 21 TIPS:',
    '#   1. When importing a .drt timeline use the "Import Timeline" dialog and',
    '#      check "Automatically link to existing media pool clips" (Resolve 21)',
    '#      to auto-relink without running this script.',
    '#   2. Enable "Automatic Smart Bin for Offline Clips" in:',
    '#      Resolve > Preferences > User > Editing > Automatic Smart Bins',
    '#      This bins all unlinked clips for easy inspection after EDL import.',
    '#   3. Set custom ACES AMF folder in Project Settings > Color Management',
    '#      > ACES AMF option menu to point to the 07_color/amf/ export folder.',
    '',
    'import DaVinciResolveScript as dvr',
    'import os',
    '',
    'resolve   = dvr.scriptapp("Resolve")',
    'pm        = resolve.GetProjectManager()',
    'project   = pm.GetCurrentProject()',
    'mediaPool = project.GetMediaPool()',
    'rootBin   = mediaPool.GetRootFolder()',
    '',
    '# ── 1. Create a working bin ────────────────────────────────────────────────',
    `PULL_BIN_NAME = "${projectName}_OCF_Pull"`,
    'existing_bins = {b.GetName(): b for b in rootBin.GetSubFolderList()}',
    'pull_bin = existing_bins.get(PULL_BIN_NAME) or mediaPool.AddSubFolder(rootBin, PULL_BIN_NAME)',
    'mediaPool.SetCurrentFolder(pull_bin)',
    '',
    '# ── 2. Job definitions ─────────────────────────────────────────────────────',
    'jobs = [',
    ...jobLines,
    ']',
    '',
    '# ── 3. Import OCF sources ──────────────────────────────────────────────────',
    'print(f"Importing {len(jobs)} source clips into {PULL_BIN_NAME}...")',
    'imported = []',
    'for job in jobs:',
    '    src = job["source"]',
    '    if not os.path.exists(src):',
    '        print(f"  MISSING: {src}")',
    '        continue',
    '    clips = mediaPool.ImportMedia([src])',
    '    if clips:',
    '        clip = clips[0]',
    '        clip.SetClipProperty("Start TC", job["srcIn"])',
    '        imported.append((job, clip))',
    '        print(f"  Imported: {job[\'shotId\']} — {os.path.basename(src)}")',
    '    else:',
    '        print(f"  FAILED:   {src}")',
    '',
    '# ── 4. Relink offline clips via Smart Bin (Resolve 21) ─────────────────────',
    '# Enable: Resolve > Preferences > User > Editing > Automatic Smart Bins',
    'all_bins = rootBin.GetSubFolderList()',
    'offline_bin = next((b for b in all_bins if "offline" in b.GetName().lower()), None)',
    'if offline_bin:',
    '    offline_clips = offline_bin.GetClipList()',
    '    print(f"\\nOffline clips in Smart Bin: {len(offline_clips)}")',
    '    for clip in offline_clips:',
    '        name = clip.GetName()',
    '        for job, imp_clip in imported:',
    '            if os.path.basename(job["source"]).startswith(name.split(".")[0]):',
    '                clip.ReplaceClip(job["source"])',
    '                print(f"  Relinked: {name}")',
    '                break',
    '',
    '# ── 5. Build render jobs ────────────────────────────────────────────────────',
    'print("\\nCreating render jobs...")',
    'timeline = project.GetCurrentTimeline()',
    'if not timeline:',
    '    print("WARNING: No active timeline. Open the conform timeline first.")',
    'else:',
    '    for job, clip in imported:',
    '        out_dir = job.get("outputDir", "")',
    '        pattern = job.get("pattern", "")',
    '        if not out_dir:',
    '            print(f"  SKIP (no outputDir): {job[\'shotId\']}")',
    '            continue',
    '        os.makedirs(out_dir, exist_ok=True)',
    '        project.SetRenderSettings({',
    '            "SelectAllFrames": False, "MarkIn": 0, "MarkOut": 0,',
    '            "TargetDir": out_dir,',
    '            "CustomName": os.path.splitext(os.path.basename(pattern))[0] if pattern else job["shotId"],',
    '            "FrameRate": str(job["fps"]),',
    '        })',
    '        if project.AddRenderJob():',
    '            print(f"  Queued: {job[\'shotId\']} → {out_dir}")',
    '',
  ];

  if (amfFolder) {
    lines.push(
      '# ── 6. ACES AMF folder (Resolve 21 custom folder) ─────────────────────────',
      '# Set in: Project Settings > Color Management > ACES AMF option menu',
      `AMF_FOLDER = r"${amfFolder}"`,
      '# project.SetSetting("acesCCTInputTransformDirectory", AMF_FOLDER)',
      'print(f"\\nACES AMF folder: {AMF_FOLDER}")',
      'print("  → Set this path in Project Settings > Color Management > ACES AMF")',
      '',
    );
  }

  lines.push(
    'print("\\nDone. Review the render queue before rendering.")',
    '',
  );

  return lines.join('\n');
}

// Build Nuke handoff script for unsupported OCF.
// Escape a Python single-quoted string. Nuke runs CPython; we use single
// quotes throughout so embedded apostrophes in shot names don't break the script.
function _pyStr(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build a Nuke handoff Python script for an EXR pull package.
 *
 * The script consumes the EXR sequence that PFX just exported (or will export)
 * to <outputDir>/<outputPattern> rather than the camera original — the artist
 * drops this into Nuke and gets a working tree with:
 *
 *   • Read colorspace = ACES2065-1 (matches the EXR plate the companion writes).
 *   • Optional OCIOCDLTransform for preview only (when colorMatch.cdl exists,
 *     applied="false" intent — same as the AMF lookTransform; never bakes
 *     the CDL into the plate).
 *   • Reformat to UHD 3840x2160 if the exported sequence isn't already there
 *     (job.reframe.targetWidth/Height).
 *   • Viewer transform Rec709 so the artist's match-to-reference workflow
 *     mirrors the QT reference grade.
 *   • Per-Read label with source OCF, TC range, speed, reframe, AMF, FDL.
 *
 * Signature kept back-compat: extra args are optional, but supplying
 * normalisedRows + projectMeta yields the rich labels.
 */
export function buildNukeHandoffScript(jobs = [], normalisedRows = [], projectMeta = {}) {
  const out = [];
  out.push('# PostFlowX → Nuke EXR Pull Handoff Script');
  out.push('# Generated by PostFlowX smartExrReportExporter');
  out.push(`# Project: ${_pyStr(projectMeta.projectName || '')}`);
  out.push('# Workflow: ACES 2065-1 plate, Rec709 viewer for QT reference match.');
  out.push('# Run in Nuke Script Editor or via command line: nuke -x this_script.nk');
  out.push('');
  out.push('import nuke');
  out.push('');
  out.push('# ── Viewer: Rec709 so plate previews match the QT reference grade ──');
  out.push('try:');
  out.push('    for v in nuke.allNodes("Viewer"):');
  out.push('        v["viewerProcess"].setValue("Rec.709 (ACES)")');
  out.push('except Exception:');
  out.push('    pass');
  out.push('');

  const plates = jobs.map((job, i) => {
    const row    = normalisedRows[i] || {};
    const exrDir = job.outputDir || '';
    const exrPat = job.outputPattern || `${job.plateName || row.shotName || `plate_${i+1}`}.%04d.exr`;
    const exrFile = exrDir ? `${exrDir.replace(/\/+$/, '')}/${exrPat}` : exrPat;
    const first  = job.frameStart ?? 1001;
    const count  = job.frameCount || job.expectedFrameCount || 0;
    const last   = count > 0 ? first + count - 1 : first;

    // Reframe: insert Nuke Reformat only when the companion has NOT already
    // baked geometry into the exported sequence. job.reframe is null when no
    // bake was applied (camera-native resolution on disk — Nuke must reformat);
    // it is { crop, scale } when the companion baked the reframe, meaning the
    // sequence is already the target resolution and no Nuke Reformat is needed.
    const reframeBaked = !!(job?.reframe && (job.reframe.crop || job.reframe.scale));
    const needsReformat = !reframeBaked;
    const reframeLabel  = reframeBaked ? 'baked' : 'none';

    // CDL: only emit the OCIOCDLTransform when colorMatch has CDL values.
    // We mark it "preview only" via a node label — the artist can disable
    // it; we never bake-applied it.
    const cdl = job?.color?.match?.cdl || null;

    // Show look / LMT — emit an OCIOFileTransform only when the colour plan
    // resolved that a look should apply AND a show LUT path exists.
    const showLut = (job?.colorPlan?.luts || []).find(l => l && l.type === 'show_lut' && l.path);
    const showLutPath = job?.colorPlan?.applyLook && showLut ? showLut.path : '';

    // Retime — wire the resolved frame map into a real node (FrameHold for
    // freeze, TimeWarp lookup for dynamic) instead of leaving a "review" label.
    // Source frames are plate-local (first map entry → the plate's first frame)
    // so the curve is valid against the renumbered EXR sequence.
    const retime = job?.retime || {};
    const fmap = Array.isArray(retime.sourceFrameMap) && retime.sourceFrameMap.length
      ? retime.sourceFrameMap : null;
    const srcBase = fmap ? Math.round(Number(fmap[0].sourceFrame) || 0) : 0;
    const localSrc = sf => first + (Math.round(Number(sf) || 0) - srcBase);
    const retimeKeys = (retime.isDynamic && fmap)
      ? fmap.map((e, idx) => [first + idx, localSrc(e.sourceFrame)])
      : null;
    const freezeFrame = (retime.freeze && fmap) ? localSrc(fmap[0].sourceFrame) : null;

    const speedLabel = retime.hasSpeedChange
      ? (retimeKeys ? 'DYNAMIC (frame map)'
        : retime.freeze ? 'FREEZE'
        : retime.isDynamic ? 'DYNAMIC (review)'
        : `${Math.round((retime.speed || 1) * 100)}%`)
      : '100%';

    return {
      exrFile,
      first,
      last,
      cdl,
      showLutPath,
      retimeKeys,
      freezeFrame,
      needsReformat,
      labelLines: [
        `Plate ${i + 1}: ${row.shotName || job.plateName || job.shotId || ''}`,
        `Source OCF: ${row.clipName || job.sourcePath || ''}`,
        `TC ${row.tcIn || ''} → ${row.tcOut || ''}`,
        `Speed: ${speedLabel}`,
        `Reframe: ${reframeLabel}`,
        row.match?._manualLink ? 'Manual link: yes' : '',
        `AMF: ${job.plateName || ''}.amf`,
        `FDL: ${job.plateName || ''}.fdl.json`,
      ].filter(Boolean).join('\\n'),
    };
  });

  out.push('# ── Per-plate Read → (CDL) → (Reformat) tree ────────────────────────');
  plates.forEach((p, i) => {
    out.push(`# Plate ${i + 1}`);
    out.push('r = nuke.createNode("Read")');
    out.push(`r["file"].setValue('${_pyStr(p.exrFile)}')`);
    out.push(`r["first"].setValue(${p.first})`);
    out.push(`r["last"].setValue(${p.last})`);
    out.push(`r["origfirst"].setValue(${p.first})`);
    out.push(`r["origlast"].setValue(${p.last})`);
    // ACES 2065-1 plate intent. Nuke's colorspace knob accepts "ACES - ACES2065-1"
    // in OCIO ACES configs and "ACES2065-1" in many custom configs — set both
    // attempts via try/except so the script doesn't error on either layout.
    out.push('try: r["colorspace"].setValue("ACES - ACES2065-1")');
    out.push('except: r["colorspace"].setValue("ACES2065-1")');
    out.push(`r["label"].setValue('${_pyStr(p.labelLines)}')`);
    out.push('');

    if (p.cdl) {
      // Emit OCIOCDLTransform with applied="false" intent — same semantics
      // as the AMF lookTransform. Working space ACEScct (industry default
      // for grading transforms applied to ACES plates).
      const s = p.cdl.slope    || [1, 1, 1];
      const o = p.cdl.offset   || [0, 0, 0];
      const pw = p.cdl.power   || [1, 1, 1];
      const sat = (p.cdl.saturation ?? 1);
      out.push('cdl = nuke.createNode("OCIOCDLTransform")');
      out.push(`cdl["slope"].setValue([${s[0]}, ${s[1]}, ${s[2]}])`);
      out.push(`cdl["offset"].setValue([${o[0]}, ${o[1]}, ${o[2]}])`);
      out.push(`cdl["power"].setValue([${pw[0]}, ${pw[1]}, ${pw[2]}])`);
      out.push(`cdl["saturation"].setValue(${sat})`);
      out.push('cdl["working_space"].setValue("ACES - ACEScct")');
      out.push('cdl["disable"].setValue(True)  # preview only — never bake into the plate');
      out.push('cdl["label"].setValue("Preview CDL (from QT-ref match) — disabled by default")');
      out.push('');
    }

    if (p.showLutPath) {
      // Show look / LMT from the AMF. colorPlanEngine already suppresses
      // applyLook when the AMF marks the look baked, so this won't double-apply.
      out.push('lut = nuke.createNode("OCIOFileTransform")');
      out.push(`lut["file"].setValue('${_pyStr(p.showLutPath)}')`);
      out.push('lut["direction"].setValue("forward")');
      out.push('lut["interpolation"].setValue("linear")');
      out.push(`lut["label"].setValue("Show look / LMT (from AMF)")`);
      out.push('');
    }

    if (p.freezeFrame != null) {
      // Freeze frame → hold a single source frame (plate-local).
      out.push('fh = nuke.createNode("FrameHold")');
      out.push(`fh["first_frame"].setValue(${p.freezeFrame})`);
      out.push('fh["label"].setValue("FREEZE — held source frame (from frame map)")');
      out.push('');
    } else if (p.retimeKeys) {
      // Dynamic ramp → TimeWarp whose lookup curve maps output frame → source
      // frame. Every source frame is present in the plate, so no flow needed.
      out.push('tw = nuke.createNode("TimeWarp")');
      out.push('tw["lookup"].setAnimated()');
      p.retimeKeys.forEach(([outF, srcF]) => {
        out.push(`tw["lookup"].setValueAt(${srcF}, ${outF})`);
      });
      out.push(`tw["label"].setValue("DYNAMIC retime — conformed from frame map (${p.retimeKeys.length} keys)")`);
      out.push('');
    }

    if (p.needsReformat) {
      // Reformat to UHD only when the exported sequence isn't already UHD.
      // Use "to format" + UHD_4K so artists can swap the target later.
      out.push('rf = nuke.createNode("Reformat")');
      out.push('rf["type"].setValue("to format")');
      out.push('rf["format"].setValue("UHD_4K")');
      out.push('rf["resize"].setValue("width")');
      out.push('rf["filter"].setValue("Lanczos4")');
      out.push('rf["label"].setValue("Match QT reference UHD")');
      out.push('');
    }
  });

  out.push('# ── Single shared Viewer at the bottom (Rec709) ────────────────────');
  out.push('v = nuke.createNode("Viewer")');
  out.push('try: v["viewerProcess"].setValue("Rec.709 (ACES)")');
  out.push('except: pass');
  out.push('');

  return out.join('\n');
}
