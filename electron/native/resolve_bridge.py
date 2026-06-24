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
            return ((h * 3600) + (m * 60) + s) * int(fps) + f
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

    if source_frame is not None:
        target_frame = int(source_frame)
    else:
        target_frame = _tc_to_frame(source_tc, fps)
    log.info('Target frame: %d (tc=%s fps=%.3f)', target_frame, source_tc, fps)

    try:
        total_frames = int(target_clip.GetClipProperty('Frames') or 1)
        target_frame = max(0, min(target_frame, total_frames - 1))
    except Exception:
        pass

    # ── Create a one-frame timeline ───────────────────────────────────────────
    tl_name = f'PFX_Preview_{int(time.time())}'
    timeline = media_pool.CreateEmptyTimeline(tl_name)
    if not timeline:
        return {'ok': False, 'stage': 'create_timeline',
                'error': 'Could not create temp timeline.'}

    appended = media_pool.AppendToTimeline([{
        'mediaPoolItem': target_clip,
        'startFrame':   target_frame,
        'endFrame':     target_frame,  # single frame
        'mediaType':    1,             # video
    }])
    if not appended:
        return {'ok': False, 'stage': 'build_timeline',
                'error': 'Could not append clip to timeline.'}

    project.SetCurrentTimeline(timeline)

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

    # ── Set render settings ───────────────────────────────────────────────────
    os.makedirs(cache_dir, exist_ok=True)
    job_name = f'pfx_preview_{int(time.time())}'

    # Try to select a JPEG render preset
    for codec_pair in [('JPEG', 'JPEGData'), ('jpg', ''), ('jpeg', '')]:
        try:
            if project.SetCurrentRenderFormatAndCodec(*codec_pair):
                break
        except Exception:
            pass

    render_ok = project.SetRenderSettings({
        'SelectAllFrames': False,
        'MarkIn':  0,
        'MarkOut': 0,
        'TargetDir':   cache_dir,
        'CustomName':  job_name,
        'ExportVideo': True,
        'ExportAudio': False,
        'FormatWidth':  output_width,
        'FormatHeight': output_height,
        'VideoQuality': 85,
    })
    if not render_ok:
        return {'ok': False, 'stage': 'render_settings',
                'error': 'SetRenderSettings returned False.'}

    job_id = project.AddRenderJob()
    if not job_id:
        return {'ok': False, 'stage': 'render_job',
                'error': 'AddRenderJob returned None.'}

    project.StartRendering([job_id])
    log.info('Rendering job %s …', job_id)

    # ── Wait for render ───────────────────────────────────────────────────────
    start_t = time.time()
    while project.IsRenderingInProgress():
        if time.time() - start_t > 60:
            project.StopRendering()
            return {'ok': False, 'stage': 'render_timeout',
                    'error': 'Render did not complete within 60 s.'}
        time.sleep(0.25)

    # ── Locate the output file ────────────────────────────────────────────────
    output_file = None
    for suffix in ('', '_000000', '_000001'):
        for ext in ('.jpg', '.jpeg'):
            candidate = os.path.join(cache_dir, f'{job_name}{suffix}{ext}')
            if os.path.exists(candidate):
                output_file = candidate
                break
        if output_file:
            break

    if not output_file:
        # Broader scan for recently-created jpegs
        cutoff = start_t - 2
        try:
            for fname in sorted(os.listdir(cache_dir)):
                if fname.startswith(job_name) and fname.lower().endswith('.jpg'):
                    fp = os.path.join(cache_dir, fname)
                    if os.path.getmtime(fp) > cutoff:
                        output_file = fp
                        break
        except Exception:
            pass

    if not output_file:
        return {'ok': False, 'stage': 'render_output',
                'error': 'Render completed but no JPEG output was found.',
                'details': {'cacheDir': cache_dir, 'jobName': job_name}}

    with open(output_file, 'rb') as fh:
        raw = fh.read()

    data_url = 'data:image/jpeg;base64,' + base64.b64encode(raw).decode('utf-8')
    log.info('Still ready: %s (%d bytes)', output_file, len(raw))

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
