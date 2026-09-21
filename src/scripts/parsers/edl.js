// modules/parser_edl.js
// -----------------------------------------------------------------------------
// CMX3600 EDL parser (simple + robust)
//
// Allows loading .edl files into PostFlowX.
//
// What it reads:
// - Event lines (CMX3600):
//     001  REELNAME  V     C   01:00:00:00 01:00:01:00 00:00:10:00 00:00:11:00
// - Comment lines:
//     * SOURCE FILE: A001C001_....mov
//     * FROM CLIP NAME: ...
// - Locator lines (either):
//     LOC: 00:00:10:00 GREEN SHOT_0010
//     * LOC: 00:00:10:00 GREEN SHOT_0010
//
// Returns:
//   {
//     events:[{
//       clipName, srcFile, reel,
//       srcIn, srcOut, recIn, recOut,
//       fps, sourceType:"edl",
//       _edlEvent, _edlFcm,
//       _edlLoc, _edlComments
//     }],
//     projectName,
//     fps,       // whole-frame timecode base (always an integer)
//     fpsExact   // true playback rate (23.976023976… for an NTSC header)
//   }
// -----------------------------------------------------------------------------

import { nominalBase } from '../modules/utils_time.js';

function basename(p = "") {
  const s = String(p || "").trim();
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

function stemNoExt(name = "") {
  const s = basename(name);
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}

function framePart(tc = "") {
  // Accept drop-frame ';' separators as well as ':' — a DF EDL uses HH:MM:SS;FF.
  const m = String(tc).match(/^\d{2}[:;]\d{2}[:;]\d{2}[:;](\d{2})$/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseEDL(edlText, filename = "") {
  const text = String(edlText || "");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let title = "";
  let fcm = "";
  let explicitFps = 0;

  let cur = null;
  const events = [];
  let maxFF = 0;

  // Match both non-drop (HH:MM:SS:FF) and drop-frame (HH:MM:SS;FF) timecodes.
  // Without the ';' alternative, every event line in a drop-frame EDL was
  // skipped — the whole EDL imported as zero events.
  const tcRe = /\b\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}\b/g;

  const bumpMax = (tc) => {
    const ff = framePart(tc);
    if (Number.isFinite(ff)) maxFF = Math.max(maxFF, ff);
  };

  const pushCur = () => {
    if (!cur) return;
    if (!cur._edlComments?.length) delete cur._edlComments;
    events.push(cur);
    cur = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const t = line.trim();
    if (!t) continue;

    // headers
    if (/^TITLE\s*:/i.test(t)) {
      title = t.replace(/^TITLE\s*:/i, "").trim();
      continue;
    }
    if (/^FCM\s*:/i.test(t)) {
      fcm = t.replace(/^FCM\s*:/i, "").trim();
      continue;
    }
    if (/^(?:FRAME_RATE|FPS)\s*:/i.test(t)) {
      const fv = parseFloat(t.replace(/^(?:FRAME_RATE|FPS)\s*:\s*/i, ""));
      if (Number.isFinite(fv) && fv > 0) explicitFps = fv;
      continue;
    }

    // event line (starts with event number + has 4 timecodes)
    if (/^\d{1,6}\s+/.test(t)) {
      const tcs = t.match(tcRe);
      if (tcs && tcs.length >= 4) {
        const firstTc = tcs[0];
        const prefix = t.slice(0, t.indexOf(firstTc)).trim();
        const tokens = prefix.split(/\s+/);

        const evNum = tokens[0] || String(events.length + 1);
        const reelTok = tokens[1] || "REEL";
        const trackTok = tokens[2] || "V";
        // Capture full transition token: "D 025" → "D025", "W001" stays "W001", "C" stays "C"
        const t3 = tokens[3] || 'C';
        const transTok = (t3 === 'D' || t3 === 'W') && tokens[4] && /^\d+$/.test(tokens[4])
          ? t3 + tokens[4]
          : t3;

        // keep only video-bearing tracks. CMX3600 combined picture+sound codes
        // (B = both, AA/V, A2/V …) carry video too, so treat any token containing
        // 'V', or the literal 'B', as video-bearing.
        const isVideoTrack = /V/i.test(trackTok) || trackTok.toUpperCase() === 'B';
        if (!isVideoTrack) {
          pushCur();
          cur = null;
          continue;
        }

        pushCur();

        const last4 = tcs.slice(-4);
        const [srcIn, srcOut, recIn, recOut] = last4;
        [srcIn, srcOut, recIn, recOut].forEach(bumpMax);

        // "V" → V1/track 0, "V2" → V2/track 1, "V3" → V3/track 2 …
        const _vNum = /^V(\d+)$/i.test(trackTok) ? parseInt(trackTok.slice(1), 10) : 1;

        cur = {
          clipName: reelTok,
          srcFile: reelTok, // placeholder; can be replaced by * SOURCE FILE:
          reel: reelTok,

          srcIn,
          srcOut,
          recIn,
          recOut,

          fps: 24, // filled later with guess
          sourceType: "edl",
          type: "video",
          role: `V${_vNum}`,
          trackIndex: _vNum - 1,
          disabled: false,
          isOCF: false,
          markers: [],
          _markers: [],

          track: trackTok,
          transition: transTok,

          _edlEvent: evNum,
          _edlFcm: fcm || undefined,
          _edlComments: []
        };
        continue;
      }
    }

    // comments / locator lines (attach to current event)
    if (cur) {
      // comment line
      if (/^\*/.test(t)) {
        const c = t.replace(/^\*\s*/, "");

        // * FROM CLIP NAME:
        if (/^FROM CLIP NAME\s*:/i.test(c)) {
          const v = c.replace(/^FROM CLIP NAME\s*:/i, "").trim();
          if (v) cur.clipName = v;
          continue;
        }

        // * SOURCE FILE:
        if (/^(SOURCE FILE|SOURCE|SRC FILE)\s*:/i.test(c)) {
          const v = c.replace(/^(SOURCE FILE|SOURCE|SRC FILE)\s*:/i, "").trim();
          if (v) {
            const base = basename(v);
            cur.srcFile = base || v;
            cur.reel = stemNoExt(base || v) || cur.reel;
          }
          continue;
        }


        // * SPEED:
        if (/^SPEED\s*:/i.test(c)) {
          const v = c.replace(/^SPEED\s*:/i, '').trim();
          // parse numeric percent
          const m = v.match(/(\d+(?:\.\d+)?)/);
          if (m) {
            const sp = parseFloat(m[1]);
            if (Number.isFinite(sp)) {
              cur.speed = sp;
              cur.speedFactor = sp;
              cur.speedComment = `${sp}%`;
              cur.speedSummary = `${sp}%`;
            }
          }
          continue;
        }

        // * DYNAMIC RETIME:
        if (/^(DYNAMIC\s+RETIME|DYNAMIC\s+SPEED)\s*:/i.test(c)) {
          const v = c.replace(/^(DYNAMIC\s+RETIME|DYNAMIC\s+SPEED)\s*:/i, '').trim();
          try {
            const obj = JSON.parse(v);
            if (Array.isArray(obj)) {
              cur.speedKeys = obj;
            } else {
              cur.speedKeys = [obj];
            }
            cur.speedComment = cur.speedComment || 'DYNAMIC';
            cur.speedSummary = cur.speedSummary || 'DYNAMIC';
          } catch {
            // keep raw
            cur.speedKeys = [{ raw: v }];
          }
          continue;
        }

        // * TRANSFORM:
        if (/^TRANSFORM\s*:/i.test(c)) {
          const v = c.replace(/^TRANSFORM\s*:/i, '').trim();
          if (!v || /^NONE$/i.test(v)) {
            cur.transform = null;
            cur.transformComment = 'NONE';
            cur.transformSummary = 'NONE';
          } else {
            try {
              const obj = JSON.parse(v);
              cur.transform = obj;
              cur.transformComment = JSON.stringify(obj);
              cur.transformSummary = cur.transformComment;
            } catch {
              cur.transform = { raw: v };
              cur.transformComment = v;
              cur.transformSummary = v;
            }
          }
          continue;
        }
        // * LOC:
        if (/^LOC\s*:/i.test(c)) {
          const line2 = c.trim().startsWith("LOC:")
            ? c.trim()
            : `LOC: ${c.replace(/^LOC\s*:/i, "").trim()}`;
          cur._edlLoc = line2;
          continue;
        }

        cur._edlComments.push(c);
        continue;
      }

      // non-comment LOC line
      if (/^LOC\s*:/i.test(t)) {
        cur._edlLoc = t;
        continue;
      }
    }
  }

  pushCur();

  // fps: prefer explicit header (FRAME_RATE: / FPS:), otherwise guess from max FF field
  let fpsGuess;
  if (explicitFps > 0) {
    fpsGuess = explicitFps;
  } else {
    fpsGuess = 24;
    if (maxFF >= 59) fpsGuess = 60;
    else if (maxFF >= 49) fpsGuess = 50;
    else if (maxFF >= 29) fpsGuess = 30;
    else if (maxFF >= 24) fpsGuess = 25;
    else fpsGuess = 24;
    // if header says DROP FRAME, prefer >=30
    if (/drop\s*frame/i.test(fcm || "")) fpsGuess = Math.max(fpsGuess, 30);
  }

  // A FRAME_RATE:/FPS: header line is taken verbatim, so explicitFps can be
  // fractional ("FRAME_RATE: 23.976"). The guess branch cannot be — it picks
  // from a fixed set — but the base still has to be derived rather than
  // assumed, because the header branch is the one real EDLs take. `fps` is the
  // whole-frame timecode base, `fpsExact` the true rate: the shared contract.
  const fpsBase = nominalBase(fpsGuess);
  events.forEach((ev) => (ev.fps = fpsBase));

  const projectName = title || stemNoExt(filename || "EDL_PROJECT") || "EDL_PROJECT";
  return { events, fps: fpsBase, fpsExact: fpsGuess, projectName, sourceType: "edl" };
}
