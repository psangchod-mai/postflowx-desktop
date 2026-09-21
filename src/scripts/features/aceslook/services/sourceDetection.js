// scripts/features/acesLook/services/sourceDetection.js
// Classify a File into a source class and suggest an input transform.
// Checks filename patterns first (high signal), then extension (lower signal).

/**
 * @param {File} file
 * @returns {{ sourceClass: string, suggestedInputTransform: string, confidence: 'high'|'medium'|'low' }}
 */
export function detectSource(file) {
  if (!file) return { sourceClass: 'unknown', suggestedInputTransform: 'AUTO', confidence: 'low' };

  const raw  = file.name || '';
  const name = raw.toLowerCase();
  const ext  = name.split('.').pop() || '';

  // ── Already-ACES content ──────────────────────────────────────────────────
  if (/\baces\b|_ap0_|_aces2065/i.test(raw)) {
    return { sourceClass: 'aces_exr_ap0', suggestedInputTransform: 'ACES2065_1', confidence: 'high' };
  }

  // ── ARRI ─────────────────────────────────────────────────────────────────
  // LogC4 (ALEXA 35 / Mini 35)
  if (/logc4|log_c4|alexa.?35|mini.?35/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'ARRI_LOGC4', confidence: 'high' };
  }
  // LogC3 (ALEXA Mini / AMIRA / LF)
  if (/logc3?|log.c[_\s]?3?|alexa|amira|a35|lf[_\s]?log|arri/i.test(raw) && ext !== 'ari') {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'ARRI_LOGC3', confidence: 'high' };
  }
  // ARRI ALEXA 35 clip naming: A_XXXXXXXX_YYYYMMDD_... (no explicit log tag in name)
  // ALEXA 35 shoots LogC4; Mini / LF → LogC3. Default to LogC4 (newer / more common for fresh projects).
  if (/^a[_\-]\d{4,}|a\d{3,4}c\d{3,4}/i.test(raw) && (ext === 'mxf' || ext === 'arx' || ext === 'ari')) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'ARRI_LOGC4', confidence: 'medium' };
  }
  // .arx / .ari native files
  if (ext === 'arx' || ext === 'ari') {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'ARRI_LOGC3', confidence: 'medium' };
  }

  // ── Sony ─────────────────────────────────────────────────────────────────
  if (/s.?log.?3|slog3|sgamut|s_gamut|venice|burano|fx[3679]|a7s|a7.?iii|a7.?iv|ilme|pxw|pmw/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'SONY_SLOG3', confidence: 'high' };
  }
  if (/s.?log.?2|slog2/i.test(raw)) {
    // SLog2 — map to SLog3 as closest; add note
    return { sourceClass: 'camera_native', suggestedInputTransform: 'SONY_SLOG3', confidence: 'medium' };
  }

  // ── RED ──────────────────────────────────────────────────────────────────
  if (ext === 'r3d') {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'RED_LOG3G10', confidence: 'high' };
  }
  if (/log3g10|redwidegamut|komodo|monstro|helium|gemini|dragon|raven|scarlet|epic|weapon/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'RED_LOG3G10', confidence: 'high' };
  }

  // ── Panasonic V-Log ───────────────────────────────────────────────────────
  if (/v.?log|vgamut|gh[56]|s1h?|s5|bggh|au.?eva|varicam|lumix/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'VLOG', confidence: 'high' };
  }

  // ── Blackmagic BRAW ────────────────────────────────────────────────────────
  if (ext === 'braw') {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'AUTO', confidence: 'medium' };
  }
  if (/bmpcc|ursa|pocket|blackmagic|braw|film.gen.?[45]/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'AUTO', confidence: 'medium' };
  }

  // ── Canon C-Log ───────────────────────────────────────────────────────────
  if (/clog[23]?|c.log|cinema.eos|eos.c[57]|eos.r5|eos.r[67]/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'AUTO', confidence: 'medium' };
  }

  // ── DJI D-Log ─────────────────────────────────────────────────────────────
  if (/d.?log|dji|mavic|inspire|zenmuse/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'AUTO', confidence: 'medium' };
  }

  // ── Fuji F-Log ────────────────────────────────────────────────────────────
  if (/f.?log[12]?|fuji|xt[234567]|gfx/i.test(raw)) {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'AUTO', confidence: 'medium' };
  }

  // ── Extension-based fallbacks ─────────────────────────────────────────────

  if (ext === 'exr') {
    return { sourceClass: 'aces_exr_ap0', suggestedInputTransform: 'NONE_ALREADY_ACES', confidence: 'medium' };
  }

  if (ext === 'dpx') {
    return { sourceClass: 'camera_native', suggestedInputTransform: 'AUTO', confidence: 'low' };
  }

  if (ext === 'mxf') {
    // MXF: check filename for log/camera hints before falling back to AUTO
    if (/logc|slog|log3g10|vlog/i.test(name)) {
      return { sourceClass: 'camera_native', suggestedInputTransform: _logHintToTransform(name), confidence: 'medium' };
    }
    // ARRI ALEXA 35 / Mini 35 naming: A_XXXXXXX_YYYYMMDD_... (reel starts with A_ + digits)
    // A001C001_... / A002... are also ARRI-style clip names
    if (/^a[_\-]?\d{4}|_a\d{4}c\d{3}|a\d{3,4}c\d{3,4}/i.test(raw)) {
      return { sourceClass: 'camera_native', suggestedInputTransform: 'ARRI_LOGC4', confidence: 'medium' };
    }
    // Sony MXF: F5, F55, Venice, Burano clip naming (C\d{3} prefix or XDCAM-style)
    if (/^c\d{3}|^[a-z]{1,3}\d{6}|pxw|pmw/i.test(raw)) {
      return { sourceClass: 'camera_native', suggestedInputTransform: 'SONY_SLOG3', confidence: 'medium' };
    }
    return { sourceClass: 'camera_native', suggestedInputTransform: 'AUTO', confidence: 'low' };
  }

  if (ext === 'mov' || ext === 'qt') {
    // Log hint in filename → camera native
    if (_hasLogHint(name)) {
      return { sourceClass: 'camera_native', suggestedInputTransform: _logHintToTransform(name), confidence: 'medium' };
    }
    // Proxy / QT suffixes → Rec.709
    if (/proxy|_rec.?709|_709|_sdr|_lq|dailies/i.test(name)) {
      return { sourceClass: 'qt_rec709', suggestedInputTransform: 'REC709', confidence: 'high' };
    }
    return { sourceClass: 'qt_rec709', suggestedInputTransform: 'REC709', confidence: 'medium' };
  }

  if (ext === 'mp4') {
    return { sourceClass: 'qt_rec709', suggestedInputTransform: 'REC709', confidence: 'high' };
  }

  return { sourceClass: 'unknown', suggestedInputTransform: 'AUTO', confidence: 'low' };
}

function _hasLogHint(name) {
  return /logc|slog|log3g10|vlog|logfilm|crlog|blackmagic|braw|clog|dlog|flog/i.test(name);
}

function _logHintToTransform(name) {
  if (/logc4/i.test(name))   return 'ARRI_LOGC4';
  if (/logc/i.test(name))    return 'ARRI_LOGC3';
  if (/slog3/i.test(name))   return 'SONY_SLOG3';
  if (/log3g10/i.test(name)) return 'RED_LOG3G10';
  if (/vlog/i.test(name))    return 'VLOG';
  return 'AUTO';
}
