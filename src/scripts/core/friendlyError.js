// scripts/core/friendlyError.js
// PostFlowX — translate raw exception text into plain-language, actionable messages.
//
// Most user-facing errors in the app are `showError(err?.message || String(err))`,
// which dumps raw exception text (ENOENT, 403, "TypeError: cannot read propert…").
// This maps the common technical failures to a friendly message + a next step.
//
// CONSERVATIVE BY DESIGN: if nothing matches, the original text is passed through
// unchanged — many call sites already write good messages ("Scan a VFX folder first.").
//
// Dual-use: importable (ESM) for tests, and sets window.pfxFriendlyError /
// window.pfxFriendlyText for classic-script consumers.
// ─────────────────────────────────────────────────────────────────────────────

// Localise a rule string. The renderer exposes window.PFX_t from
// scripts/modules/i18n.js; this file deliberately does not import it, because
// it is also loaded directly by Node tests where there is no window — and
// English is the right answer there.
//
// Translation happens HERE, on the three parts separately, rather than being
// left to the i18n MutationObserver. The observer only ever sees what
// friendlyText() produces, which is `message + ' ' + hint` glued together, and
// that concatenation is not a dictionary key — so an observer-only approach
// silently leaves every error in English. Translating the parts also keeps the
// dictionary keyed on short, reusable sentences instead of 20 long pairs.
function _t(s) {
  if (!s) return s;
  try {
    return (typeof window !== 'undefined' && window.PFX_t) ? window.PFX_t(s) : s;
  } catch (_) {
    return s;
  }
}

// Exported for core/friendlyAlert.js, which is handed an operation label at the
// call site ("Reviews CSV export failed") and has to localise it with exactly
// this shim — guarded, and with no import of i18n, for the same reason.
export { _t as translate };

// Normalize any thrown thing → raw string.
function _raw(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const s = String(err.message || err.error || err.reason || err.toString?.() || '');
    // A plain object with no message stringifies to "[object Object]", which is
    // worse in a banner than saying nothing — fall through to the generic text.
    return s === '[object Object]' ? '' : s;
  }
  return String(err);
}

// Strip noisy JS prefixes so pass-through text reads cleaner.
function _strip(s) {
  return String(s)
    .replace(/^\s*(Uncaught\s+)?(Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError):\s*/i, '')
    .trim();
}

// First filesystem-looking path in the text, if any (for file-not-found hints).
//
// Two passes, and the order is the whole point. Node quotes the path in every
// fs error — "ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/a.ari'"
// — and inside the quotes the end of the path is unambiguous, so a quoted path
// is taken whole, spaces and all. Post-house volumes are named "SHOW DRIVE 01"
// and "Client Delivery", not "showdrive01"; the unquoted scan below has to stop
// at whitespace, and on its own it handed back "/Volumes/SHOW" — a path that
// does not exist, sending the user to look in the wrong place. It stays only as
// the fallback for messages that were assembled without quotes.
function _path(s) {
  const t = String(s);
  const quoted = t.match(/['"]((?:[A-Za-z]:)?(?:[\\/][^'"\n]+)+)['"]/);
  if (quoted) return quoted[1];
  const m = t.match(/(?:[A-Za-z]:)?(?:\/[^\s:'"]+)+/);
  return m ? m[0] : '';
}

// Ordered specific → general. Each rule: {test, title, message, hint}.
// message/hint may be functions of (raw) for interpolation.
const RULES = [
  {
    test: /(companion|helper service).*(refus|not running|unavailable|503|502|failed to (fetch|connect))|econnrefused/i,
    title: 'Helper not responding',
    message: "PostFlowX's helper service isn't responding right now.",
    hint: 'Reopen the app, or run the installer from Settings › Resolve Engine.',
  },
  {
    test: /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid token|missing token/i,
    title: 'Authorization failed',
    message: "PostFlowX couldn't authorize with its helper service.",
    hint: 'Restart the app. If it keeps happening, re-run the installer.',
  },
  {
    test: /helper.*(too old|out of date|outdated)|unknown (native )?action|unsupported action/i,
    title: 'Helper needs updating',
    message: 'The PostFlowX helper needs to be updated.',
    hint: 'Run the installer again from Settings › Resolve Engine, then reload.',
  },
  {
    test: /resolve.*(not found|not installed|unavailable|missing)|no.*resolve.*install/i,
    title: 'Resolve not found',
    message: "DaVinci Resolve wasn't found on this machine.",
    hint: 'Resolve is optional — IMF Validation and pulls work fine without it.',
  },
  {
    test: /scripting.*(not available|unavailable|disabled)|resolve.*scripting/i,
    title: 'Resolve scripting unavailable',
    message: "DaVinci Resolve scripting isn't available here.",
    hint: 'Switch to Simple Mode in Settings › Resolve Engine.',
  },
  {
    test: /enospc|no space left|disk (is )?full|not enough (disk )?space/i,
    title: 'Disk full',
    message: 'The disk is full, so PostFlowX could not finish writing.',
    hint: 'Free up space or choose another drive, then try again.',
  },
  {
    test: /eacces|eperm|permission denied|operation not permitted|not authorized to access/i,
    title: 'Permission denied',
    message: "PostFlowX doesn't have permission to open that location.",
    hint: 'Pick a different folder, or grant Files & Folders access in System Settings › Privacy & Security.',
  },
  {
    // Locked by another app — in a post house this is nearly always Resolve or
    // Premiere still holding the file. Distinct from a permissions problem, and
    // the fix is different, so it must not fall into the EACCES rule above.
    test: /\bebusy\b|\betxtbsy\b|resource busy|being used by another|file is locked/i,
    title: 'File is in use',
    message: 'Another application is still using that file.',
    hint: 'Close it in the other app — often Resolve or Premiere — then try again.',
  },
  {
    test: /enoent|no such file|file not found|cannot find (the )?(file|path)|does not exist/i,
    title: 'File not found',
    message: (raw) => {
      const p = _path(raw);
      // The path is data, not prose — it is appended after the translated
      // sentence rather than interpolated into it, so no locale has to carry a
      // placeholder and the filename an assistant needs is never reworded.
      return p
        ? `${_t("That file or folder couldn't be found:")}\n${p}`
        : _t("That file or folder couldn't be found.");
    },
    hint: 'Check that it still exists and the drive is connected.',
  },
  {
    test: /etimedout|timed out|timeout|deadline exceeded/i,
    title: 'Timed out',
    message: 'That took too long and timed out.',
    hint: 'Check the file size or connection and try again.',
  },
  {
    // Explicit write/encode/mux wording only. Deliberately narrow: a bare
    // "ffmpeg exited with code 1" stays with the decode rule below, because
    // nothing in that string says which end failed and guessing wrong sends the
    // user to replace good media when the real problem is the output folder.
    test: /failed to (encode|mux|write)|(encoding|muxing|writing) (failed|error)|output file .*(cannot|could not) be written/i,
    title: 'Export could not be written',
    message: 'The export stopped partway through writing the file.',
    hint: 'Check the output folder has space and is writable, then try again.',
  },
  {
    test: /(could not|failed to|unable to).*(decode|read media)|ffmpeg|codec|unsupported (format|codec)|no decoder|decode (error|failed)|moov atom|invalid data found|malformed|truncated (file|stream)/i,
    title: 'Could not decode media',
    message: "This media couldn't be decoded.",
    hint: 'The format may be unsupported, or the media helper needs installing (Settings › Resolve Engine).',
  },
  {
    test: /unexpected token|unexpected end of (json|input)|json\.parse|is not valid json|parse error/i,
    title: 'Unexpected response',
    message: 'PostFlowX got an unexpected response.',
    hint: 'Try again. If it repeats, restart the app.',
  },
  {
    // "failed to fetch" is the browser's wording; "fetch failed" / ENOTFOUND is
    // what Node and the companion produce. Both reach this same banner.
    test: /failed to fetch|fetch failed|networkerror|network request failed|err_network|net::|enotfound|eai_again|dns lookup/i,
    title: 'Network problem',
    message: "PostFlowX couldn't reach the service it needed.",
    hint: 'Check your connection and try again.',
  },
  {
    // The WASM decoders die this way when memory runs short — render_queue.js
    // already special-cases it for jobs, but it reaches the error banner too.
    // Must precede the generic rule below, which would otherwise claim it via
    // "out of memory" and give the wrong advice (restart, rather than close a
    // tab: the memory is held by the other open decoders, and restarting the
    // whole app to reclaim it is a much bigger hammer than the user needs).
    test: /memory access out of bounds|wasm|webassembly|allocation (failed|size too large)/i,
    title: 'Ran out of memory',
    message: 'This needed more memory than was available.',
    hint: 'Close the other tabs and any large apps, then run this on its own.',
  },
  {
    // Raw JS programming errors — never show the stack-y text to a user.
    test: /cannot read propert|is not a function|is not defined|undefined is not|null is not|maximum call stack|out of memory/i,
    title: 'Something went wrong',
    message: 'Something went wrong inside PostFlowX.',
    hint: 'Please try again. If it keeps happening, restart the app.',
  },
];

/**
 * friendlyError(err) → { title, message, hint, raw }
 * Pure. `title` is a short label, `message` a plain sentence, `hint` a next step.
 * If nothing matches, returns the (prefix-stripped) original text with no hint.
 */
export function friendlyError(err) {
  const raw = _raw(err);
  const stripped = _strip(raw);

  for (const rule of RULES) {
    if (rule.test.test(raw) || rule.test.test(stripped)) {
      // Function-valued message/hint localise their own static parts (see the
      // ENOENT rule); literal ones are translated here. `raw` stays in English
      // — it is for a support log, not for the user.
      const message = typeof rule.message === 'function' ? rule.message(raw) : _t(rule.message);
      const hint = typeof rule.hint === 'function' ? rule.hint(raw) : _t(rule.hint);
      return { title: _t(rule.title), message, hint: hint || '', raw };
    }
  }

  // Pass-through: keep the app's already-friendly messages intact. Those are
  // rendered into the DOM, so the i18n observer translates them by the normal
  // route; only this fallback literal never reaches the DOM as a dictionary
  // key on its own, so it is localised here.
  return { title: '', message: stripped || _t('Something went wrong.'), hint: '', raw };
}

/**
 * friendlyText(err) → single string suitable for a toast / error banner.
 *
 * The hint goes on its own line, not glued to the message with a space. Two of
 * the rules above end their message with a filesystem path, and a space-joined
 * hint lands directly after it:
 *
 *   That file or folder couldn't be found:
 *   /Volumes/SHOW DRIVE 01/reel3/A003C012.ari Check that it still exists and…
 *
 * Post-house volumes have spaces in their names, so there is nothing in that
 * line telling a reader where the path stops and the advice starts. The only
 * consumer is core/errorBanner.js, whose element carries `white-space: pre-wrap`
 * — the newline is honoured, and a two-line banner is what it was sized for.
 */
export function friendlyText(err) {
  const f = friendlyError(err);
  return f.hint ? `${f.message}\n${f.hint}` : f.message;
}

/**
 * friendlyStatus(text) → the same string, with any raw exception tail rewritten.
 *
 * For a panel status line, not a banner. The distinction matters:
 *
 *   _setStatus(`Relink failed: ${e?.message || e}`)
 *
 * The prefix is the only thing on screen that says WHICH operation failed —
 * the status line has no title bar, no icon, no context of its own. Running
 * that whole string through friendlyText() would return
 * "PostFlowX doesn't have permission to open that location. …" and drop
 * "Relink failed" on the floor, trading jargon for lost context. So the label
 * is held back and only the tail is rewritten.
 *
 * A label must be a PHRASE ("Rescan failed", "Review proxy error (sh010)"),
 * hence the \s in the first group. That is load-bearing: without it a bare
 * "ENOENT: no such file…" would treat "ENOENT" as the operation name and leave
 * the very jargon this exists to remove sitting on screen as a heading.
 *
 * Like friendlyText, this is conservative: a string it cannot improve comes
 * back byte-identical, so progress and success lines ("Ready", "Relinked: x.ari",
 * "Visual match: scanning 4/57…") pass through untouched.
 */
export function friendlyStatus(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return s;

  const m = s.match(/^([^:]{1,40}\s[^:]{0,40}):\s+([\s\S]+)$/);
  if (m) {
    const tail = friendlyText(m[2]);
    if (tail && tail !== m[2]) return `${m[1]}: ${tail}`;
    return s;
  }

  const out = friendlyText(s);
  return (out && out !== s) ? out : s;
}

// Expose globals for non-module / classic-script consumers.
if (typeof window !== 'undefined') {
  window.pfxFriendlyError = friendlyError;
  window.pfxFriendlyText = friendlyText;
  window.pfxFriendlyStatus = friendlyStatus;
}
