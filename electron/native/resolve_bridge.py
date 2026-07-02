#!/usr/bin/env python3
"""
resolve_bridge.py — Standalone DaVinci Resolve scripting bridge for PostFlowX.

Protocol: reads a single JSON command from stdin, writes a single JSON result
to stdout. All logs go to stderr (captured by native_router.js and written to
~/Library/Application Support/PostFlowX/logs/resolve-bridge.log).

Supported actions:
  status              — Check Resolve installation / scripting connectivity
  extractStillFrame   — Import OCF, create temp timeline, render one JPEG frame
"""

import sys
import os
import json
import time
import base64
import logging
import traceback
import tempfile
import subprocess

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='%(asctime)s [resolve_bridge] %(levelname)s %(message)s',
)
log = logging.getLogger('resolve_bridge')

# ── Resolve scripting module search paths ────────────────────────────────────

_RESOLVE_SCRIPT_PATHS = [
    '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules',
    os.path.join(os.environ.get('HOME', ''), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules'),
    os.path.join(os.environ.get('RESOLVE_SCRIPT_API', ''), 'Modules'),
]
_RESOLVE_APP = '/Applications/DaVinci Resolve/DaVinci Resolve.app'


def _load_resolve():
    """Return a DaVinci Resolve scripting app object, or None."""
    for p in _RESOLVE_SCRIPT_PATHS:
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)

    try:
        import DaVinciResolveScript as dvr  # type: ignore[import]
        app = dvr.scriptapp('Resolve')
        return app if app is not None else None
    except Exception:
        pass

    return None


# ── Timecode helpers ─────────────────────────────────────────────────────────

def _tc_to_frame(tc: str, fps: float = 24.0) -> int:
    """Convert HH:MM:SS:FF timecode string to absolute frame number."""
    try:
        parts = tc.replace(';', ':').split(':')
        if len(parts) == 4:
            h, m, s, f = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
            # Use the nominal integer frame rate (round, not truncate): 23.976→24,
            # 29.97→30. Truncating with int() drifts ~1 frame/sec on fractional rates.
            return ((h * 3600) + (m * 60) + s) * round(fps) + f
    except Exception:
        pass
    return 0


# ── Action: status ───────────────────────────────────────────────────────────

def handle_status() -> dict:
    installed = os.path.exists(_RESOLVE_APP)
    if not installed:
        return {'ok': True, 'installed': False, 'running': False, 'connected': False,
                'state': 'not_installed'}

    resolve = _load_resolve()
    if resolve is None:
        # Installed but not running (or scripting disabled)
        return {'ok': True, 'installed': True, 'running': False, 'connected': False,
                'state': 'not_running',
                'error': 'Resolve scripting API unavailable — ensure Resolve is open and '
                         'External Scripting is enabled in Preferences → System → General.'}
    try:
        version = resolve.GetVersionString() or '?'
        pm = resolve.GetProjectManager()
        proj = pm.GetCurrentProject() if pm else None
        return {
            'ok': True, 'installed': True, 'running': True, 'connected': True,
            'state': 'connected',
            'resolveVersion': version,
            'currentProject': proj.GetName() if proj else None,
        }
    except Exception as e:
        return {'ok': True, 'installed': True, 'running': True, 'connected': False,
                'state': 'error', 'error': str(e)}


# ── Action: extractStillFrame ────────────────────────────────────────────────

def handle_extract_still_frame(cmd: dict) -> dict:
    ocf_path      = str(cmd.get('ocfPath') or cmd.get('filePath') or '').strip()
    source_tc     = str(cmd.get('sourceTc') or cmd.get('timecode') or '01:00:00:00').strip()
    source_frame  = cmd.get('sourceFrame')  # optional, overrides tc
    output_width  = int(cmd.get('outputWidth') or 960)
    cache_dir     = str(cmd.get('cacheDir') or tempfile.gettempdir())
    fmt           = str(cmd.get('format') or 'jpg').lower().strip('.')
    color_mode    = str(cmd.get('colorPreviewMode') or 'rec709')

    if not ocf_path:
        return {'ok': False, 'error': 'ocfPath is required.', 'stage': 'validate'}

    if not os.path.exists(ocf_path):
        return {'ok': False, 'stage': 'import_media',
                'error': f'OCF file not found: {os.path.basename(ocf_path)}',
                'details': {'fileExists': False, 'ocfPath': ocf_path}}

    resolve = _load_resolve()
    if resolve is None:
        return {'ok': False, 'stage': 'connect',
                'error': 'Resolve is not running or scripting API is unavailable.',
                'requiresResolve': True, 'resolveAvailable': False,
                'decoder': 'Unsupported', 'extractor': 'resolve'}

    try:
        return _do_extract(resolve, ocf_path, source_tc, source_frame,
                           output_width, cache_dir, fmt, color_mode)
    except Exception as e:
        log.error('extractStillFrame error: %s\n%s', str(e), traceback.format_exc())
        return {'ok': False, 'stage': 'exception', 'error': str(e)}


def _do_extract(resolve, ocf_path: str, source_tc: str, source_frame,
                output_width: int, cache_dir: str, fmt: str, color_mode: str) -> dict:
    resolve_ver = '?'
    try:
        resolve_ver = resolve.GetVersionString() or '?'
    except Exception:
        pass
    log.info('Resolve %s — extracting: %s tc=%s', resolve_ver, os.path.basename(ocf_path), source_tc)

    pm = resolve.GetProjectManager()
    if not pm:
        return {'ok': False, 'stage': 'connect', 'error': 'GetProjectManager() returned None.'}

    # ── Get or create the scratch project ────────────────────────────────────
    SCRATCH = 'PostFlowX_Preview_Temp'
    project = pm.GetCurrentProject()
    if not project or project.GetName() != SCRATCH:
        loaded = pm.LoadProject(SCRATCH)
        if not loaded:
            project = pm.CreateProject(SCRATCH)
            if not project:
                return {'ok': False, 'stage': 'project',
                        'error': f'Could not create project "{SCRATCH}".'}
        else:
            project = pm.GetCurrentProject()

    if not project:
        return {'ok': False, 'stage': 'project', 'error': 'No project available.'}
    log.info('Project: %s', project.GetName())

    # Defensive: a render left "in progress" by a prior crash/abort blocks
    # CreateEmptyTimeline (and thus every future preview). Clear it up front.
    try:
        if project.IsRenderingInProgress():
            project.StopRendering()
        project.DeleteAllRenderJobs()
    except Exception:
        pass

    media_pool = project.GetMediaPool()

    # ── Find or import the clip ───────────────────────────────────────────────
    target_clip = None
    try:
        for clip in (media_pool.GetRootFolder().GetClipList() or []):
            try:
                if clip.GetClipProperty('File Path') == ocf_path:
                    target_clip = clip
                    break
            except Exception:
                pass
    except Exception:
        pass

    if not target_clip:
        log.info('Importing %s', ocf_path)
        imported = media_pool.ImportMedia([ocf_path])
        if not imported:
            return {'ok': False, 'stage': 'import_media',
                    'error': f'Resolve could not import: {os.path.basename(ocf_path)}',
                    'details': {'resolveVersion': resolve_ver, 'fileExists': True}}
        target_clip = imported[0]

    log.info('Clip: %s', target_clip.GetName() if target_clip else 'None')

    # ── Determine FPS and target frame ────────────────────────────────────────
    try:
        fps = float(target_clip.GetClipProperty('FPS') or 24)
    except Exception:
        fps = 24.0

    # Camera OCF (ARRIRAW/X-OCN/R3D) runs FREE-RUN timecode — e.g. the clip's
    # first frame is at 09:45:08:00, not 00:00:00:00. So the requested editorial
    # source TC must be made RELATIVE to the clip's own Start TC (which Resolve
    # reports), otherwise tcToFrame() yields a huge absolute frame (e.g. 807511)
    # that's nowhere inside an 80-second clip and the append/seek fails.
    clip_start_tc = ''
    try:
        clip_start_tc = target_clip.GetClipProperty('Start TC') or ''
    except Exception:
        pass

    if source_frame is not None:
        target_frame = int(source_frame)
    elif clip_start_tc and ':' in clip_start_tc:
        target_frame = _tc_to_frame(source_tc, fps) - _tc_to_frame(clip_start_tc, fps)
    else:
        target_frame = _tc_to_frame(source_tc, fps)
    log.info('Target frame: %d (tc=%s startTC=%s fps=%.3f)', target_frame, source_tc, clip_start_tc or '?', fps)

    try:
        total_frames = int(target_clip.GetClipProperty('Frames') or 1)
        target_frame = max(0, min(target_frame, max(0, total_frames - 1)))
    except Exception:
        target_frame = max(0, target_frame)

    # ── Create a one-frame timeline ───────────────────────────────────────────
    tl_name = f'PFX_Preview_{int(time.time())}'
    timeline = media_pool.CreateEmptyTimeline(tl_name)
    if not timeline:
        return {'ok': False, 'stage': 'create_timeline',
                'error': 'Could not create temp timeline.'}

    # Cleanup helper: delete the render job + temp timeline so the scratch project
    # doesn't accumulate them on EVERY failure path (not just success).
    _job_id = [None]
    def _drop_temp():
        try:
            if _job_id[0]:
                project.DeleteRenderJob(_job_id[0])
        except Exception:
            pass
        try:
            media_pool.DeleteTimelines([timeline])
        except Exception:
            pass

    # Append a short WINDOW that begins at the target frame — a zero-length
    # [N,N] single-frame range is rejected on several Resolve builds (the
    # original "Could not append clip" failure). We render the window's first
    # timeline frame (= target_frame) via MarkIn/MarkOut below.
    try:
        _tot = max(1, int(target_clip.GetClipProperty('Frames') or 1))
    except Exception:
        _tot = 1
    win_start = max(0, min(target_frame, _tot - 1))
    win_end   = min(win_start + 9, _tot - 1)
    if win_end <= win_start:                      # clip too short / target at end
        win_start = max(0, win_end - 1)
    target_offset = target_frame - win_start      # frames from window start to target

    appended = media_pool.AppendToTimeline([{
        'mediaPoolItem': target_clip,
        'startFrame':   win_start,
        'endFrame':     win_end,
        'mediaType':    1,             # video only
    }])
    if not appended:                              # last resort: whole clip
        appended = media_pool.AppendToTimeline([{ 'mediaPoolItem': target_clip, 'mediaType': 1 }])
        target_offset = target_frame
    if not appended:
        _drop_temp()
        return {'ok': False, 'stage': 'build_timeline',
                'error': 'Could not append clip to timeline.'}

    project.SetCurrentTimeline(timeline)
    # Render frame = timeline start + offset to the target within the appended window.
    try:
        _tl_start = int(timeline.GetStartFrame())
    except Exception:
        _tl_start = 0
    _mark = _tl_start + max(0, target_offset)

    # ── Compute output dimensions ─────────────────────────────────────────────
    try:
        res_str = target_clip.GetClipProperty('Resolution') or ''
        if 'x' in res_str:
            ow, oh = map(int, res_str.split('x'))
            output_height = max(1, int(output_width * oh / max(1, ow)))
        else:
            output_height = int(output_width * 9 / 16)
    except Exception:
        output_height = int(output_width * 9 / 16)

    # ── Render the window to H.264, then pull frame 0 (= target) with ffmpeg ──
    # GrabStill+ExportStills fails headless on Resolve 21 (ExportStills→False) and
    # the JPEG render preset isn't honoured. Rendering the appended window to a
    # normal H.264 .mp4 IS reliable (Resolve debayers the ARRIRAW), and the first
    # rendered frame is the target. ffmpeg/avfoundation decode H.264 trivially.
    os.makedirs(cache_dir, exist_ok=True)
    job_name = f'pfx_preview_{int(time.time())}'
    start_t = time.time()

    for codec_pair in [('mp4', 'H264'), ('mov', 'H264'), ('mp4', 'H265')]:
        try:
            if project.SetCurrentRenderFormatAndCodec(*codec_pair):
                break
        except Exception:
            pass

    render_ok = project.SetRenderSettings({
        'SelectAllFrames': True,          # render the whole (short) window timeline
        'TargetDir':   cache_dir,
        'CustomName':  job_name,
        'ExportVideo': True,
        'ExportAudio': False,
        'FormatWidth':  output_width,
        'FormatHeight': output_height,
    })
    if not render_ok:
        _drop_temp()
        return {'ok': False, 'stage': 'render_settings', 'error': 'SetRenderSettings returned False.'}

    job_id = project.AddRenderJob()
    _job_id[0] = job_id
    if not job_id:
        _drop_temp()
        return {'ok': False, 'stage': 'render_job', 'error': 'AddRenderJob returned None.'}
    project.StartRendering([job_id])
    log.info('Rendering window job %s …', job_id)
    while project.IsRenderingInProgress():
        if time.time() - start_t > 60:
            project.StopRendering()
            _drop_temp()
            return {'ok': False, 'stage': 'render_timeout', 'error': 'Render did not complete within 60 s.'}
        time.sleep(0.2)

    # Locate the rendered video.
    video_file = None
    try:
        cands = []
        for fname in os.listdir(cache_dir):
            if fname.startswith(job_name) and fname.lower().endswith(('.mp4', '.mov')):
                fp = os.path.join(cache_dir, fname)
                if os.path.getmtime(fp) >= start_t - 2 and os.path.getsize(fp) > 1024:
                    cands.append((os.path.getmtime(fp), fp))
        if cands:
            cands.sort(reverse=True)
            video_file = cands[0][1]
    except Exception:
        pass
    if not video_file:
        _drop_temp()
        return {'ok': False, 'stage': 'render_output',
                'error': 'Render completed but no video output was found.',
                'details': {'cacheDir': cache_dir, 'jobName': job_name}}

    # Extract frame 0 (the target) as a JPEG with ffmpeg.
    output_file = os.path.join(cache_dir, f'{job_name}.jpg')
    ffmpeg = next((p for p in ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']
                   if p == 'ffmpeg' or os.path.exists(p)), 'ffmpeg')
    try:
        subprocess.run([ffmpeg, '-y', '-nostdin', '-loglevel', 'error', '-i', video_file,
                        '-frames:v', '1', '-vf', f'scale={int(output_width)}:-1', output_file],
                       timeout=30, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        _drop_temp()
        return {'ok': False, 'stage': 'frame_extract', 'error': f'ffmpeg frame extract failed: {e}'}
    if not (os.path.exists(output_file) and os.path.getsize(output_file) > 0):
        _drop_temp()
        return {'ok': False, 'stage': 'frame_extract',
                'error': 'ffmpeg produced no frame from the Resolve render.'}
    try:
        os.remove(video_file)
    except Exception:
        pass

    with open(output_file, 'rb') as fh:
        raw = fh.read()

    data_url = 'data:image/jpeg;base64,' + base64.b64encode(raw).decode('utf-8')
    log.info('Still ready: %s (%d bytes)', output_file, len(raw))

    # ── Clean up so Resolve's render queue + timeline list don't accumulate ───
    _drop_temp()

    return {
        'ok':           True,
        'dataUrl':      data_url,
        'imageDataUrl': data_url,  # legacy alias
        'imagePath':    output_file,
        'stage':        'complete',
        'decoder':      'Resolve Engine',
        'extractor':    'resolve',
        'backend':      'davinci_resolve',
        'resolveAvailable': True,
        'sourceFrame':  target_frame,
        'sourceTc':     source_tc,
        'resolveVersion': resolve_ver,
    }


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({'ok': False, 'error': 'Empty input', 'stage': 'parse'}))
            sys.exit(1)
        cmd = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({'ok': False, 'error': f'JSON parse error: {e}', 'stage': 'parse'}))
        sys.exit(1)

    action = cmd.get('action', '')

    try:
        if action == 'status':
            result = handle_status()
        elif action == 'extractStillFrame':
            result = handle_extract_still_frame(cmd)
        else:
            result = {'ok': False, 'error': f'Unknown action: {action!r}', 'stage': 'dispatch'}
    except Exception as e:
        log.error('Unhandled error: %s\n%s', str(e), traceback.format_exc())
        result = {'ok': False, 'error': str(e), 'stage': 'exception'}

    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == '__main__':
    main()
