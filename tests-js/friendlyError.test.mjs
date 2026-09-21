// friendlyError translator. Run: node tests-js/friendlyError.test.mjs
import { friendlyError, friendlyText } from '../src/scripts/core/friendlyError.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function has(text, sub, l) { ok(String(text).toLowerCase().includes(sub.toLowerCase()), `${l} (got ${JSON.stringify(text)})`); }

// Technical → friendly
has(friendlyText('Error: ENOENT: no such file, open /Volumes/X/a.mxf'), 'found', 'ENOENT → not found');
has(friendlyText('ENOENT: no such file, open /Volumes/X/a.mxf'), '/Volumes/X/a.mxf', 'file path preserved in hint');
// Volumes in a post house have spaces in their names. Node quotes the path, so
// there is no excuse for truncating it at the first space — a half path is
// worse than none, because it names a real-looking folder that isn't the one.
has(friendlyText("ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/sh010/a.ari'"),
  '/Volumes/SHOW DRIVE 01/sh010/a.ari', 'quoted path with spaces kept whole');
ok(!friendlyText("ENOENT: open '/Volumes/SHOW DRIVE 01/a.ari'").includes('/Volumes/SHOW\n'),
  'no truncated path left behind');
has(friendlyText('EACCES: permission denied'), 'permission', 'EACCES → permission');
has(friendlyText('ENOSPC: no space left on device'), 'disk is full', 'ENOSPC → disk full');
has(friendlyText('Request failed with status 403 Forbidden'), 'authorize', '403 → authorize');
has(friendlyText('companion server not running (ECONNREFUSED)'), "helper", 'companion down → helper');
has(friendlyText('Resolve not found on PATH'), 'optional', 'resolve not found → optional');
has(friendlyText('Scripting not available'), 'simple mode', 'scripting → simple mode');
has(friendlyText('Helper is too old'), 'updated', 'old helper → update');
has(friendlyText('Unknown native action: colorAces2OutputTransforms'), 'updated', 'unknown action → update helper');
has(friendlyText('ffmpeg: could not decode stream'), 'decoded', 'ffmpeg → decode');
has(friendlyText('TypeError: Cannot read properties of undefined (reading "x")'), 'went wrong', 'JS error → generic');
has(friendlyText('Operation timed out after 30000ms'), 'timed out', 'timeout');
has(friendlyText('Unexpected token < in JSON at position 0'), 'unexpected response', 'bad JSON');

// Structured output
const f = friendlyError('EACCES: permission denied');
ok(f.title === 'Permission denied', 'structured title set');
ok(!!f.hint, 'structured hint set');
ok(f.raw.includes('EACCES'), 'raw preserved');

// Pass-through: already-friendly strings must NOT be mangled
const friendly = 'Scan a VFX folder first.';
ok(friendlyText(friendly) === friendly, 'friendly message passes through unchanged');
ok(friendlyText('No VFX folder selected.') === 'No VFX folder selected.', 'friendly #2 unchanged');

// Prefix stripping on unmatched errors
ok(friendlyText('Error: Something specific happened') === 'Something specific happened', 'strips Error: prefix');

// Robustness
ok(friendlyText(null) === 'Something went wrong.', 'null → default');
ok(typeof friendlyText(new Error('EACCES: denied')) === 'string', 'accepts Error object');
ok(friendlyText({ message: 'ENOSPC: full' }).toLowerCase().includes('disk'), 'accepts {message}');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
