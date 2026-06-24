/**
 * ocf_exr_handler.js — PostFlowX Native Helper: OCF → EXR handler stubs
 *
 * This file documents the contract that the native companion app must implement
 * for the OCF → EXR Pull feature. Register these handlers in the companion's
 * message router alongside the existing IMF / ProRes handlers.
 *
 * All handlers receive a request object and must call respond(result).
 * Long-running jobs (ocfExrExportStart) must be non-blocking:
 *   - start the work on a background thread / child process
 *   - return a jobId immediately
 *   - let ocfExrExportStatus be polled for progress
 *
 * Native Helper CLI contract (pfx-helper binary):
 *   pfx-helper export-exr --job /path/to/job.json
 *   pfx-helper ocf-probe  --folder /path/to/ocf
 *   pfx-helper open-folder --path /path/to/dir
 */

// ── Handler: ocfPickFolder ────────────────────────────────────────────────────
// Show a native folder picker dialog.
// Request:  {}
// Response: { path: string }  OR  { path: null } if cancelled
function handleOcfPickFolder(request, respond) {
  // macOS: use NSOpenPanel
  // Windows: use SHBrowseForFolder or IFileOpenDialog
  // Example using electron/node dialog:
  //   const { dialog } = require('electron');
  //   const result = dialog.showOpenDialogSync({ properties: ['openDirectory'] });
  //   respond({ path: result?.[0] || null });
  respond({ path: null, _stub: true });
}

// ── Handler: ocfProbeFolder ───────────────────────────────────────────────────
// Recursively walk a folder and return metadata for every camera file found.
// Request:  { folderPath: string }
// Response: Array<OcfFileInfo>
//   OcfFileInfo: { name, path, reel, tcIn, tcOut, fps, frameCount, camera, format, resolution }
//
// Supported formats (probe with relevant SDK or ffprobe):
//   .R3D (RED SDK), .ari/.arx (ARRIRAW), .braw (Blackmagic RAW),
//   .mxf (ARRI/Sony/Canon RAW in MXF), .mov (ProRes RAW), .dpx, .exr sequences
function handleOcfProbeFolder(request, respond) {
  const { folderPath } = request;
  if (!folderPath) { respond({ error: 'folderPath required' }); return; }

  // Pseudo-implementation:
  // 1. Walk folderPath recursively (ignore hidden files, max depth 8)
  // 2. For each found camera file:
  //    a. Probe with ffprobe / camera SDK for: reel, source TC in/out, fps, frame count
  //    b. Collect into OcfFileInfo object
  // 3. Return array of OcfFileInfo
  //
  // Example using ffprobe:
  //   ffprobe -v quiet -print_format json -show_streams -show_format <file>
  //   Parse: streams[0].r_frame_rate, nb_frames, tags.timecode, format.tags.reel_name
  //
  // For RED .R3D:
  //   Use REDline SDK: REDline --useMeta --start 0 --count 1 -i file.R3D
  //   Parse stdout for TC, fps, reel, resolution
  //
  // Return:
  respond({ files: [], _stub: true, _message: 'Implement ocfProbeFolder in native helper' });
}

// ── Handler: ocfExrExportStart ────────────────────────────────────────────────
// Start an async EXR export job. Returns immediately with a jobId.
// Request:  { job: ExrJobJSON }  (see smartExrPullPlanner.js for full schema)
// Response: { jobId: string }
//
// The job must run in a background thread. Status is polled via ocfExrExportStatus.
//
// Decoder strategy (in priority order):
//   1. Camera-native SDK (RED SDK, ARRIRAW SDK, BRAW SDK)
//   2. OpenImageIO (oiiotool --frames "in#.exr" -o "out.####.exr")
//   3. FFmpeg (ffmpeg -i input.mov -frames:v N -vf "format=rgb48" frame%04d.exr)
//   4. DaVinci Resolve script (see smartExrReportExporter.js)
//   5. Nuke script (see smartExrReportExporter.js)
//
// If none work: return { jobId: null, error: 'Cannot decode <format>', canFallback: true }
// The UI will show the fallback panel with Resolve/Nuke options.

const _activeJobs = new Map(); // jobId → { state, progress, result, error }

function handleOcfExrExportStart(request, respond) {
  const { job } = request;
  if (!job) { respond({ error: 'job required' }); return; }

  const jobId = `exr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  _activeJobs.set(jobId, { state: 'running', progress: 0, result: null, error: null });
  respond({ jobId });

  // Start background export (non-blocking)
  _runExrExport(jobId, job);
}

async function _runExrExport(jobId, job) {
  const state = _activeJobs.get(jobId);
  if (!state) return;

  try {
    // 1. Validate source exists
    // 2. Create output directory: job.outputDir
    // 3. Determine decoder
    // 4. Run decode loop frame-by-frame or via batch command
    // 5. Update state.progress as frames complete
    // 6. On completion: set state.state = 'done', state.result = resultJSON

    // Pseudo decode using ffmpeg (fallback path):
    // const { execFile } = require('child_process');
    // const startF = frameToSeconds(job.exportIn, job.fps);
    // const endF   = frameToSeconds(job.exportOut, job.fps);
    // const duration = (endF - startF).toFixed(3);
    // const cmd = [
    //   '-ss', String(startF),
    //   '-t', duration,
    //   '-i', job.sourcePath,
    //   '-vf', `scale=iw:ih`,
    //   '-pix_fmt', job.exr.bitDepth === 'half' ? 'rgb48le' : 'rgbf32le',
    //   '-compression_algo', '3',   // ZIP
    //   `${job.outputDir}/${job.outputPattern.replace('%04d', '%04d')}`,
    // ];
    // Run with progress monitoring...

    // Result format:
    const result = {
      status: 'success',
      shotId: job.shotId,
      framesExported: job.expectedFrameCount,
      firstFrame: job.frameStart,
      lastFrame: job.frameStart + job.expectedFrameCount - 1,
      missingFrames: [],
      warnings: [],
      errors: [],
      metadata: {
        sourceTimecode: job.sourceIn,
        fps: job.fps,
        resolution: '4096x2160',  // probe from actual output
        camera: '',
        reel: job.metadata?.sourceReel || '',
      },
    };

    state.state = 'done';
    state.progress = 100;
    state.result = result;
  } catch (err) {
    state.state = 'failed';
    state.error = String(err?.message || err);
  }
}

// ── Handler: ocfExrExportStatus ───────────────────────────────────────────────
// Poll the status of a running export job.
// Request:  { jobId: string }
// Response: { state: 'running'|'done'|'failed'|'cancelled', progressPct: number, result?, error? }
function handleOcfExrExportStatus(request, respond) {
  const { jobId } = request;
  const state = _activeJobs.get(jobId);
  if (!state) { respond({ state: 'unknown', progressPct: 0 }); return; }
  respond({
    state: state.state,
    progressPct: state.progress,
    result: state.result || undefined,
    error: state.error || undefined,
  });
}

// ── Handler: ocfExrExportCancel ───────────────────────────────────────────────
// Cancel a running export job.
// Request:  { jobId: string }
// Response: { ok: boolean }
function handleOcfExrExportCancel(request, respond) {
  const { jobId } = request;
  const state = _activeJobs.get(jobId);
  if (state && state.state === 'running') {
    state.state = 'cancelled';
    // Kill the child process if running: job._proc?.kill()
  }
  respond({ ok: true });
}

// ── Handler: openFolder ───────────────────────────────────────────────────────
// Open a folder in Finder / Explorer.
// Request:  { path: string }
// Response: { ok: boolean }
function handleOpenFolder(request, respond) {
  const { path } = request;
  if (!path) { respond({ ok: false }); return; }
  // macOS: execFile('open', [path])
  // Windows: execFile('explorer', [path])
  respond({ ok: true, _stub: true });
}

// ── Route registration ────────────────────────────────────────────────────────
// Call this in the companion's message router initializer:
//
//   registerHandler('ocfPickFolder',      handleOcfPickFolder);
//   registerHandler('ocfProbeFolder',     handleOcfProbeFolder);
//   registerHandler('ocfExrExportStart',  handleOcfExrExportStart);
//   registerHandler('ocfExrExportStatus', handleOcfExrExportStatus);
//   registerHandler('ocfExrExportCancel', handleOcfExrExportCancel);
//   registerHandler('openFolder',         handleOpenFolder);

module.exports = {
  handleOcfPickFolder,
  handleOcfProbeFolder,
  handleOcfExrExportStart,
  handleOcfExrExportStatus,
  handleOcfExrExportCancel,
  handleOpenFolder,
};
