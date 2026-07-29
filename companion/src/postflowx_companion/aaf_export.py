"""
AAF export for PostFlowX Native Helper.
NLE Linked AAF: binary AAF for Avid/Resolve (linked media, pyaaf2)
Pro Tools Audio AAF: binary AAF with consolidated WAV/BWF (pyaaf2 + ffmpeg)
"""
from __future__ import annotations

import base64
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

_MEDIA_EXTS = frozenset({
    '.wav', '.aiff', '.aif', '.bwf', '.flac', '.mp3', '.aac', '.m4a',
    '.mov', '.mp4', '.mxf', '.r3d', '.braw', '.ari', '.dpx', '.exr',
    '.m4v', '.mts', '.m2ts', '.avi', '.mkv', '.dng', '.cine',
})


def _get_log_file() -> Path:
    log_dir = Path(os.path.expanduser(
        "~/Library/Application Support/PostFlowX/logs"
    ))
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "aaf_export.log"


def _get_logger() -> logging.Logger:
    logger = logging.getLogger("pfx.aaf_export")
    if not logger.handlers:
        handler = logging.FileHandler(_get_log_file(), encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s  %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
    return logger


def _ensure_vendor_path() -> None:
    """Ensure companion/src is on sys.path so bundled aaf2 is always found."""
    vendor = str(Path(__file__).resolve().parent.parent.parent)  # companion/src/
    if vendor not in sys.path:
        sys.path.insert(0, vendor)


def has_pyaaf2() -> bool:
    _ensure_vendor_path()
    try:
        import aaf2  # noqa: F401
        return True
    except ImportError:
        return False


def _check_pyaaf2():
    _ensure_vendor_path()
    try:
        import aaf2
        return aaf2
    except ImportError:
        return None


def get_pyaaf2_version() -> str | None:
    """Return the installed pyaaf2 version string, or None if not available."""
    _ensure_vendor_path()
    try:
        import aaf2
        return getattr(aaf2, "__version__", "unknown")
    except ImportError:
        return None


def find_ffmpeg() -> str | None:
    env_path = os.environ.get('POSTFLOWX_FFMPEG', '').strip()
    if env_path and shutil.which(env_path):
        return env_path
    # Prefer the binary BUNDLED in the .app (Dev Brief P0#2): a GUI-launched
    # companion has a stripped PATH and no /opt/homebrew, so the lookups below
    # only resolve in dev. _resource_bin() returns a full path or None.
    try:
        from .proxy_service import _resource_bin
        bundled = _resource_bin('ffmpeg')
        if bundled:
            return bundled
    except Exception:
        pass
    for c in ('ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg'):
        found = shutil.which(c)
        if found:
            return found
    try:
        import imageio_ffmpeg
        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and os.path.isfile(path):
            return path
    except Exception:
        pass
    return None


_find_ffmpeg = find_ffmpeg


def _timecode_to_frames(tc: str, fps: float) -> int:
    m = re.match(r'^(\d{1,2})[:;](\d{2})[:;](\d{2})[:;.](\d{2})$', str(tc or '').strip())
    if not m:
        try:
            return max(0, int(tc))
        except Exception:
            return 0
    fps_int = max(1, round(fps))
    return ((int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])) * fps_int) + int(m[4])


def _frames_to_seconds(frames: int, fps: float) -> float:
    return frames / fps if fps > 0 else 0.0


def _frames_to_samples(frames: int, fps: float, sr: int = 48000) -> int:
    return round(_frames_to_seconds(frames, fps) * sr)


def _fps_rational(fps: float) -> Fraction:
    if abs(fps - 23.976) < 0.02:
        return Fraction(24000, 1001)
    if abs(fps - 29.97) < 0.02:
        return Fraction(30000, 1001)
    if abs(fps - 59.94) < 0.02:
        return Fraction(60000, 1001)
    return Fraction(max(1, round(fps)), 1)


def _fps_int(fps: float) -> int:
    return round(float(_fps_rational(fps)))


def _populate_cache(media_roots, cache):
    scanned = cache.setdefault('__scanned__', set())
    for root in (media_roots or []):
        if root in scanned:
            continue
        scanned.add(root)
        try:
            for dp, _, fnames in os.walk(root):
                for fn in fnames:
                    if Path(fn).suffix.lower() in _MEDIA_EXTS:
                        cache.setdefault(fn, os.path.join(dp, fn))
        except OSError:
            pass


def _resolve_media_path(ev, media_roots, cache):
    for field in ('audioFile', 'audioPath', 'srcAudioFile', 'srcFile', 'assetPath', 'path', 'filePath', 'file', 'sourcePath'):
        v = ev.get(field) or ''
        if v and Path(v).is_file():
            return str(Path(v).resolve())
    _populate_cache(media_roots, cache)
    for field in ('audioFile', 'srcAudioFile', 'srcFile', 'assetPath', 'path'):
        v = ev.get(field) or ''
        if v:
            bn = Path(v).name
            if bn in cache:
                return cache[bn]
    for nf in ('reel', 'clipName'):
        name = (ev.get(nf) or '').strip()
        if not name:
            continue
        for fn, fp in list(cache.items()):
            if not fn.startswith('__') and Path(fn).stem == name:
                return fp
    return None


def _extract_mono_wav(src, ch, start_sec, dur_sec, handles_sec, out_path, ffmpeg, sr=48000):
    # Head handle is limited by how much source exists before the in-point. If the
    # in-point is within a handle of the file start, capture only what's available
    # and shrink the requested duration to match — otherwise the WAV would be short
    # a head while claiming a full head, pushing audio out of sync downstream.
    head_sec = min(handles_sec, max(0.0, start_sec))
    actual_start = start_sec - head_sec            # >= 0
    actual_dur = head_sec + dur_sec + handles_sec  # actual head + body + full tail
    cmd = [
        ffmpeg, '-y',
        '-ss', f'{actual_start:.6f}',
        '-i', src,
        '-t', f'{actual_dur:.6f}',
        '-map', f'0:a:{ch}',
        '-ar', str(sr),
        '-ac', '1',
        '-c:a', 'pcm_s24le',
        out_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        if r.returncode != 0:
            return False, r.stderr.decode(errors='replace')[-400:]
        return True, ''
    except subprocess.TimeoutExpired:
        return False, 'ffmpeg timed out'
    except Exception as exc:
        return False, str(exc)


def export_nle_linked_aaf(payload):
    """Create binary NLE Linked AAF for Avid / Resolve / conform."""
    aaf2 = _check_pyaaf2()
    if not aaf2:
        return {
            'status': 'error',
            'code': 'AAF_WRITER_MISSING',
            'userMessage': 'Real AAF export requires AAF SDK or pyaaf2 support in the Native Helper.',
        }

    fps = float(payload.get('fps', 24))
    drop = bool(payload.get('dropFrame', False))
    proj = str(payload.get('projectName') or 'Timeline')
    tl_start = int(payload.get('timelineStartFrame', 0))
    events = list(payload.get('events') or [])
    opts = dict(payload.get('options') or {})
    media_roots = list(opts.get('mediaRoots') or [])

    fps_frac = _fps_rational(fps)
    fps_i = _fps_int(fps)

    def ev_rec_in(ev):
        return _timecode_to_frames(ev.get('recIn') or '00:00:00:00', fps)

    vid_evs = [ev for ev in events if not str(ev.get('type', '')).lower().startswith('a')]
    if not vid_evs:
        vid_evs = events
    vid_evs = sorted(vid_evs, key=ev_rec_in)

    rec_outs = [_timecode_to_frames(ev.get('recOut') or ev.get('recIn') or '00:00:00:00', fps) for ev in vid_evs]
    tl_end = max(rec_outs) if rec_outs else tl_start
    tl_dur = max(1, tl_end - tl_start)

    report = {'warnings': [], 'eventCount': len(vid_evs), 'unresolved': []}
    media_cache: dict = {}
    safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '_', proj)
    out_name = f'{safe_name}_pfx_nle_linked.aaf'
    tmp_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix='.aaf', delete=False) as tmp:
            tmp_path = tmp.name

        with aaf2.open(tmp_path, 'w') as f:
            comp = f.create.CompositionMob()
            comp.name = proj
            comp['UsageCode'].value = 'Usage_TopLevel'
            f.content.mobs.append(comp)

            tc_obj = f.create.Timecode(fps=fps_i, drop=drop)
            tc_obj.start = tl_start
            tc_obj.length = tl_dur
            tc_slot = f.create.TimelineMobSlot()
            tc_slot.slot_id = 100
            tc_slot.name = 'TC1'
            tc_slot.edit_rate = fps_frac
            tc_slot.origin = 0
            tc_slot.segment = tc_obj
            comp.slots.append(tc_slot)

            v1_comps = []
            cursor = tl_start
            master_mobs_map = {}

            for ev in vid_evs:
                rec_in = _timecode_to_frames(ev.get('recIn') or '00:00:00:00', fps)
                rec_out = _timecode_to_frames(ev.get('recOut') or ev.get('recIn') or '00:00:00:00', fps)
                src_in = _timecode_to_frames(ev.get('srcIn') or '00:00:00:00', fps)
                src_out = _timecode_to_frames(ev.get('srcOut') or ev.get('srcIn') or '00:00:00:00', fps)
                rec_dur = max(1, rec_out - rec_in)
                src_dur = max(1, src_out - src_in)
                reel = ev.get('reel') or 'UNTITLED'
                clip_name = ev.get('clipName') or reel

                if rec_in > cursor:
                    gap = f.create.Filler(media_kind='picture')
                    gap.length = rec_in - cursor
                    v1_comps.append(gap)

                mob_key = reel
                if mob_key not in master_mobs_map:
                    mm = f.create.MasterMob()
                    mm.name = clip_name
                    f.content.mobs.append(mm)
                    sm = f.create.SourceMob()
                    sm.name = reel
                    f.content.mobs.append(sm)

                    sm_seq = f.create.Sequence(media_kind='picture')
                    sm_seq.length = src_dur
                    sm_fill = f.create.Filler(media_kind='picture')
                    sm_fill.length = src_dur
                    sm_seq.components.append(sm_fill)
                    sm_slot = f.create.TimelineMobSlot()
                    sm_slot.slot_id = 1
                    sm_slot.name = 'V1'
                    sm_slot.edit_rate = fps_frac
                    sm_slot.origin = 0
                    sm_slot.segment = sm_seq
                    sm.slots.append(sm_slot)

                    media_path = _resolve_media_path(ev, media_roots, media_cache)
                    if media_path:
                        desc = f.create.DataEssenceDescriptor()
                        desc['SampleRate'].value = fps_frac
                        desc['Length'].value = src_dur
                        loc = f.create.NetworkLocator()
                        loc['URLString'].value = Path(media_path).as_uri()
                        desc.locator.append(loc)
                        sm.descriptor = desc
                    else:
                        report['unresolved'].append({'reel': reel, 'clipName': clip_name})
                        report['warnings'].append(f'Unresolved media for reel: {reel}')
                        desc = f.create.TapeDescriptor()
                        sm.descriptor = desc

                    mm_clip = f.create.SourceClip(media_kind='picture')
                    mm_clip.length = src_dur
                    mm_clip.start = src_in
                    mm_clip['SourceID'].value = sm.mob_id
                    mm_clip.slot_id = 1
                    mm_seq = f.create.Sequence(media_kind='picture')
                    mm_seq.length = src_dur
                    mm_seq.components.append(mm_clip)
                    mm_slot = f.create.TimelineMobSlot()
                    mm_slot.slot_id = 1
                    mm_slot.name = 'V1'
                    mm_slot.edit_rate = fps_frac
                    mm_slot.origin = 0
                    mm_slot.segment = mm_seq
                    mm.slots.append(mm_slot)
                    master_mobs_map[mob_key] = mm

                mm = master_mobs_map[mob_key]
                comp_clip = f.create.SourceClip(media_kind='picture')
                comp_clip.length = rec_dur
                comp_clip.start = 0
                comp_clip['SourceID'].value = mm.mob_id
                comp_clip.slot_id = 1
                v1_comps.append(comp_clip)
                cursor = max(cursor, rec_in + rec_dur)

            if cursor < tl_end:
                trail = f.create.Filler(media_kind='picture')
                trail.length = tl_end - cursor
                v1_comps.append(trail)

            v1_seq = f.create.Sequence(media_kind='picture')
            v1_seq.length = tl_dur
            for c in v1_comps:
                v1_seq.components.append(c)
            v1_slot = f.create.TimelineMobSlot()
            v1_slot.slot_id = 1
            v1_slot.name = 'V1'
            v1_slot.edit_rate = fps_frac
            v1_slot.origin = 0
            v1_slot.segment = v1_seq
            comp.slots.append(v1_slot)

        with open(tmp_path, 'rb') as fout:
            raw_bytes = fout.read()
        os.unlink(tmp_path)
        tmp_path = None

        if not raw_bytes or raw_bytes[:1] == b'<':
            return {
                'status': 'error',
                'code': 'AAF_INVALID_OUTPUT',
                'userMessage': 'Generated file is not valid binary AAF.',
            }

        return {
            'status': 'ok',
            'data': {
                'fileName': out_name,
                'bytesBase64': base64.b64encode(raw_bytes).decode('ascii'),
                'report': report,
            },
        }
    except Exception as exc:
        return {
            'status': 'error',
            'code': 'AAF_EXPORT_FAILED',
            'userMessage': f'AAF export failed: {exc}',
        }
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def export_protools_aaf(payload):
    """Create binary Pro Tools Audio AAF with consolidated/embedded WAV/BWF."""
    aaf2 = _check_pyaaf2()
    if not aaf2:
        return {
            'status': 'error',
            'code': 'AAF_WRITER_MISSING',
            'userMessage': 'Real AAF export requires AAF SDK or pyaaf2 support in the Native Helper.',
        }

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return {
            'status': 'error',
            'code': 'FFMPEG_MISSING',
            'userMessage': 'Pro Tools AAF requires ffmpeg for audio consolidation.',
        }

    fps = float(payload.get('fps', 24))
    drop = bool(payload.get('dropFrame', False))
    proj = str(payload.get('projectName') or 'Timeline')
    tl_start = int(payload.get('timelineStartFrame', 0))
    events = list(payload.get('events') or [])
    opts = dict(payload.get('options') or {})
    sr = int(opts.get('sampleRate', 48000))
    bit = int(opts.get('bitDepth', 24))
    handles = int(opts.get('handlesFrames', 8))
    embed = bool(opts.get('embedAudio', True))
    split = bool(opts.get('splitMonoTracks', True))
    media_roots = list(opts.get('mediaRoots') or [])

    handles_sec = handles / fps if fps > 0 else 0.0
    fps_frac = _fps_rational(fps)
    fps_i = _fps_int(fps)
    audio_rate = Fraction(sr, 1)

    def ev_rec_in(ev):
        return _timecode_to_frames(ev.get('recIn') or '00:00:00:00', fps)

    audio_evs = [ev for ev in events if str(ev.get('type', '')).lower().startswith('a')]
    if not audio_evs:
        audio_evs = events
    audio_evs = sorted(audio_evs, key=ev_rec_in)

    if not audio_evs:
        return {
            'status': 'error',
            'code': 'AAF_NO_AUDIO_EVENTS',
            'userMessage': 'Pro Tools AAF: no audio events found.',
        }

    rec_ins = [ev_rec_in(ev) for ev in audio_evs]
    rec_outs = [_timecode_to_frames(ev.get('recOut') or ev.get('recIn') or '00:00:00:00', fps) for ev in audio_evs]
    tl_start_s = min(rec_ins)
    tl_end_s = max(rec_outs)
    tl_dur_f = max(1, tl_end_s - tl_start_s)
    tl_dur_samples = _frames_to_samples(tl_dur_f, fps, sr)

    report = {'warnings': [], 'eventCount': len(audio_evs), 'unresolved': []}
    missing = []
    media_cache: dict = {}

    for i, ev in enumerate(audio_evs):
        path = _resolve_media_path(ev, media_roots, media_cache)
        ev['_resolved_path'] = path
        if path is None:
            missing.append({
                'eventIndex': i,
                'reel': ev.get('reel', ''),
                'clipName': ev.get('clipName', ''),
                'expected': ev.get('srcFile') or ev.get('audioFile') or '',
            })

    if missing:
        return {
            'status': 'error',
            'code': 'AAF_MISSING_AUDIO_MEDIA',
            'userMessage': 'Pro Tools AAF blocked: missing source audio/media paths.',
            'data': {'missing': missing},
        }

    safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '_', proj)
    out_name = f'{safe_name}_pfx_protools_audio.aaf'
    tmp_dir = tempfile.mkdtemp(prefix='pfx_aaf_')
    tmp_aaf = os.path.join(tmp_dir, 'output.aaf')

    try:
        track_clips: dict = {}

        for i, ev in enumerate(audio_evs):
            src_path = ev['_resolved_path']
            ti = int(ev.get('trackIndex', 0))
            rec_in_f = _timecode_to_frames(ev.get('recIn') or '00:00:00:00', fps)
            rec_out_f = _timecode_to_frames(ev.get('recOut') or ev.get('recIn') or '00:00:00:00', fps)
            src_in_f = _timecode_to_frames(ev.get('srcIn') or '00:00:00:00', fps)
            rec_dur_f = max(1, rec_out_f - rec_in_f)
            src_start_sec = _frames_to_seconds(src_in_f, fps)
            dur_sec = _frames_to_seconds(rec_dur_f, fps)
            rec_in_samp = _frames_to_samples(rec_in_f - tl_start_s, fps, sr)
            dur_samp = _frames_to_samples(rec_dur_f, fps, sr)
            handle_samp = round(handles_sec * sr)

            num_channels = 2
            if split:
                try:
                    probe_r = subprocess.run(
                        ['ffprobe', '-v', 'quiet', '-select_streams', 'a:0',
                         '-show_entries', 'stream=channels', '-of', 'csv=p=0', src_path],
                        capture_output=True, text=True, timeout=10,
                    )
                    nc = probe_r.stdout.strip()
                    if nc and nc.isdigit():
                        num_channels = int(nc)
                except Exception:
                    pass

            ch_range = range(num_channels) if split else range(1)
            for ch_idx in ch_range:
                slot_idx = ti + ch_idx
                wav_out = os.path.join(tmp_dir, f'ev{i}_ch{ch_idx}.wav')
                ok, err = _extract_mono_wav(
                    src_path, ch_idx, src_start_sec, dur_sec, handles_sec, wav_out, ffmpeg, sr,
                )
                if not ok:
                    report['warnings'].append(f'Event {i} ch{ch_idx}: {err}')
                    continue
                # Use the actual available head (matches _extract_mono_wav) so the
                # timeline placement and WAV content stay aligned when the source
                # in-point is within a handle of the file start.
                head_samp = round(min(handles_sec, max(0.0, src_start_sec)) * sr)
                handle_start_samp = max(0, rec_in_samp - head_samp)
                actual_dur_samp = head_samp + dur_samp + handle_samp
                track_clips.setdefault(slot_idx, []).append({
                    'rec_in_samp': handle_start_samp,
                    'dur_samp': actual_dur_samp,
                    'clip_name': ev.get('clipName') or ev.get('reel') or f'Clip_{i}',
                    'reel': ev.get('reel') or 'UNTITLED',
                    'wav_path': wav_out,
                })

        with aaf2.open(tmp_aaf, 'w') as f:
            comp = f.create.CompositionMob()
            comp.name = proj
            comp['UsageCode'].value = 'Usage_TopLevel'
            f.content.mobs.append(comp)

            tc_obj = f.create.Timecode(fps=fps_i, drop=drop)
            tc_obj.start = tl_start_s
            tc_obj.length = tl_dur_f
            tc_slot = f.create.TimelineMobSlot()
            tc_slot.slot_id = 100
            tc_slot.name = 'TC1'
            tc_slot.edit_rate = fps_frac
            tc_slot.origin = 0
            tc_slot.segment = tc_obj
            comp.slots.append(tc_slot)

            for t_idx, slot_idx in enumerate(sorted(track_clips.keys())):
                clips_data = track_clips[slot_idx]
                slot_name = f'A{slot_idx + 1}'
                audio_comps = []
                cursor_samp = 0

                for cd in sorted(clips_data, key=lambda x: x['rec_in_samp']):
                    ri_samp = cd['rec_in_samp']
                    d_samp = cd['dur_samp']
                    wav = cd['wav_path']
                    reel = cd['reel']
                    c_name = cd['clip_name']

                    if ri_samp > cursor_samp:
                        gap = f.create.Filler(media_kind='sound')
                        gap.length = ri_samp - cursor_samp
                        audio_comps.append(gap)

                    mm = f.create.MasterMob()
                    mm.name = c_name
                    f.content.mobs.append(mm)
                    sm = f.create.SourceMob()
                    sm.name = reel
                    f.content.mobs.append(sm)

                    if embed and Path(wav).exists():
                        with open(wav, 'rb') as wf:
                            wav_bytes = wf.read()
                        desc = f.create.WAVEDescriptor()
                        desc['SampleRate'].value = audio_rate
                        desc['Length'].value = d_samp
                        desc['Channels'].value = 1
                        desc['QuantizationBits'].value = bit
                        sm.descriptor = desc
                        ess = f.create.EssenceData()
                        ess.mob_id = sm.mob_id
                        ess.write(wav_bytes)
                        f.content.essence.append(ess)
                    else:
                        desc = f.create.WAVEDescriptor()
                        desc['SampleRate'].value = audio_rate
                        desc['Length'].value = d_samp
                        if Path(wav).exists():
                            loc = f.create.NetworkLocator()
                            loc['URLString'].value = Path(wav).as_uri()
                            desc.locator.append(loc)
                        sm.descriptor = desc

                    sm_seq = f.create.Sequence(media_kind='sound')
                    sm_seq.length = d_samp
                    sm_fill = f.create.Filler(media_kind='sound')
                    sm_fill.length = d_samp
                    sm_seq.components.append(sm_fill)
                    sm_slot = f.create.TimelineMobSlot()
                    sm_slot.slot_id = 1
                    sm_slot.name = slot_name
                    sm_slot.edit_rate = audio_rate
                    sm_slot.origin = 0
                    sm_slot.segment = sm_seq
                    sm.slots.append(sm_slot)

                    mm_clip = f.create.SourceClip(media_kind='sound')
                    mm_clip.length = d_samp
                    mm_clip.start = 0
                    mm_clip['SourceID'].value = sm.mob_id
                    mm_clip.slot_id = 1
                    mm_seq2 = f.create.Sequence(media_kind='sound')
                    mm_seq2.length = d_samp
                    mm_seq2.components.append(mm_clip)
                    mm_slot = f.create.TimelineMobSlot()
                    mm_slot.slot_id = 1
                    mm_slot.name = slot_name
                    mm_slot.edit_rate = audio_rate
                    mm_slot.origin = 0
                    mm_slot.segment = mm_seq2
                    mm.slots.append(mm_slot)

                    comp_clip = f.create.SourceClip(media_kind='sound')
                    comp_clip.length = d_samp
                    comp_clip.start = 0
                    comp_clip['SourceID'].value = mm.mob_id
                    comp_clip.slot_id = 1
                    audio_comps.append(comp_clip)
                    cursor_samp = ri_samp + d_samp

                if cursor_samp < tl_dur_samples:
                    trail = f.create.Filler(media_kind='sound')
                    trail.length = tl_dur_samples - cursor_samp
                    audio_comps.append(trail)

                a_seq = f.create.Sequence(media_kind='sound')
                a_seq.length = tl_dur_samples
                for c in audio_comps:
                    a_seq.components.append(c)
                a_slot = f.create.TimelineMobSlot()
                a_slot.slot_id = t_idx + 1
                a_slot.name = slot_name
                a_slot['PhysicalTrackNumber'].value = slot_idx + 1
                a_slot.edit_rate = audio_rate
                a_slot.origin = 0
                a_slot.segment = a_seq
                comp.slots.append(a_slot)

        with open(tmp_aaf, 'rb') as fout:
            raw_bytes = fout.read()

        if not raw_bytes or raw_bytes[:1] == b'<':
            return {
                'status': 'error',
                'code': 'AAF_INVALID_OUTPUT',
                'userMessage': 'Generated file is not valid binary AAF.',
            }

        return {
            'status': 'ok',
            'data': {
                'fileName': out_name,
                'bytesBase64': base64.b64encode(raw_bytes).decode('ascii'),
                'report': report,
            },
        }
    except Exception as exc:
        return {
            'status': 'error',
            'code': 'AAF_EXPORT_FAILED',
            'userMessage': f'Pro Tools AAF export failed: {exc}',
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
