export const DEFAULT_SETTINGS = {
  activeW: null,
  activeH: null,
  arTol: 0.005
};

// ---- Helpers ----
function isNum(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

function safeLower(s) { return String(s ?? "").toLowerCase(); }

function ratio(w, h) { return w && h ? (w / h) : null; }

function approxEqual(a, b, tol) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}

function collectElements(doc) {
  try { return Array.from(doc.querySelectorAll("*")); }
  catch { return []; }
}

// Find candidate dimensions by tag/attr heuristics
function findDims(doc, keywords) {
  const els = collectElements(doc);
  const kw = keywords.map(s => s.toLowerCase());
  const candidates = [];

  for (const el of els) {
    const tag = safeLower(el.tagName);
    const attrMap = {};
    for (const a of Array.from(el.attributes ?? [])) {
      attrMap[safeLower(a.name)] = a.value;
    }

    const tagHit = kw.some(k => tag.includes(k)) ||
                   kw.some(k => Object.keys(attrMap).some(n => n.includes(k)));

    if (!tagHit) continue;

    const wKeys = ["width", "w", "canvaswidth", "activewidth", "imagewidth", "codedwidth"];
    const hKeys = ["height", "h", "canvasheight", "activeheight", "imageheight", "codedheight"];

    const wVal = wKeys.map(k => attrMap[k]).find(v => isNum(v));
    const hVal = hKeys.map(k => attrMap[k]).find(v => isNum(v));

    if (isNum(wVal) && isNum(hVal)) {
      candidates.push({
        tag: el.tagName,
        width: Number(wVal),
        height: Number(hVal),
        attrs: attrMap
      });
      continue;
    }

    // If not in attributes, try child text in <Width>3840</Width> style
    const children = Array.from(el.children ?? []);
    const childW = children.find(c => safeLower(c.tagName).includes("width") && isNum(c.textContent));
    const childH = children.find(c => safeLower(c.tagName).includes("height") && isNum(c.textContent));
    if (childW && childH) {
      candidates.push({
        tag: el.tagName,
        width: Number(childW.textContent),
        height: Number(childH.textContent),
        attrs: attrMap
      });
    }
  }

  // Prefer the largest area candidate (often canvas/coded)
  candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return candidates[0] ?? null;
}

function keywordExists(doc, keywords) {
  const xml = doc?.documentElement?.outerHTML ?? "";
  const s = xml.toLowerCase();
  return keywords.some(k => s.includes(k.toLowerCase()));
}

// Find shot segments (heuristic)
function findSegments(doc) {
  const els = collectElements(doc);
  const segs = [];
  const keys = [
    ["in", "out"],
    ["start", "end"],
    ["firstframe", "lastframe"],
    ["inframe", "outframe"]
  ];

  for (const el of els) {
    const attrs = {};
    for (const a of Array.from(el.attributes ?? [])) attrs[safeLower(a.name)] = a.value;

    for (const [k1, k2] of keys) {
      const v1 = attrs[k1];
      const v2 = attrs[k2];
      if (isNum(v1) && isNum(v2)) {
        const a = Number(v1), b = Number(v2);
        const s = Math.min(a, b), e = Math.max(a, b);
        if (e >= s) segs.push({ tag: el.tagName, in: s, out: e });
      }
    }
  }

  segs.sort((a, b) => a.in - b.in);
  return segs;
}

// ---- Rule engine ----
export function runAllRules({ doc, rawText, settings }) {
  const ctx = { doc, rawText, settings };
  const findings = [];

  for (const rule of RULES) {
    try {
      const out = rule.run(ctx) || [];
      for (const f of out) findings.push({ ruleId: rule.id, ...f });
    } catch (e) {
      findings.push({
        ruleId: rule.id,
        severity: "error",
        message: `Rule crashed: ${rule.id}`,
        detail: String(e?.message ?? e)
      });
    }
  }

  // Sort by severity
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return findings;
}

// ---- Built-in rules (MVP) ----
const RULES = [
  {
    id: "PARSE_OK",
    run: ({ doc }) => {
      if (!doc) {
        return [{
          severity: "error",
          message: "Could not parse the file as XML/JSON metadata",
          detail: "Confirm the file is valid XML/JSON and the encoding is correct"
        }];
      }
      return [{
        severity: "info",
        message: "File parsed successfully",
        detail: `Root: ${doc.documentElement?.tagName ?? "(unknown)"}`
      }];
    }
  },
  {
    id: "MASTERING_DISPLAY_PRESENT",
    run: ({ doc }) => {
      if (!doc) return [];
      const hits = keywordExists(doc, [
        "mastering", "display", "primaries", "white", "luminance", "maxluminance", "minluminance"
      ]);
      if (!hits) {
        return [{
          severity: "warn",
          message: "No mastering display / primaries keywords found (heuristic)",
          detail: "This may be a different schema, or the metadata may be incomplete"
        }];
      }
      return [{
        severity: "info",
        message: "Mastering display / color signals found (heuristic)",
        detail: "Validate actual values against your mastering configuration/report"
      }];
    }
  },
  {
    id: "CANVAS_ACTIVE_AR",
    run: ({ doc, settings }) => {
      if (!doc) return [];

      // Try to locate canvas and active/image dims
      const canvas = findDims(doc, ["canvas", "coded", "container"]);
      const active = findDims(doc, ["active", "image", "picture"]);

      const expectedW = settings.activeW;
      const expectedH = settings.activeH;
      const tol = Number(settings.arTol ?? 0.005);

      const findings = [];

      if (!canvas && !active && !(expectedW && expectedH)) {
        findings.push({
          severity: "warn",
          message: "Could not find width/height in metadata",
          detail: "Enter expected active width/height in Settings to enable Aspect Ratio checks"
        });
        return findings;
      }

      // Determine ARs
      const expectedAR = expectedW && expectedH ? ratio(expectedW, expectedH) : null;
      const canvasAR = canvas ? ratio(canvas.width, canvas.height) : null;
      const activeAR = active ? ratio(active.width, active.height) : null;

      if (canvas) {
        findings.push({
          severity: "info",
          message: `Canvas dims (heuristic): ${canvas.width}x${canvas.height}`,
          detail: `From <${canvas.tag}>`
        });
      }
      if (active) {
        findings.push({
          severity: "info",
          message: `Active/Image dims (heuristic): ${active.width}x${active.height}`,
          detail: `From <${active.tag}>`
        });
      }
      if (expectedAR) {
        findings.push({
          severity: "info",
          message: `Expected active dims: ${expectedW}x${expectedH}`,
          detail: `Expected AR=${expectedAR.toFixed(6)} (tol ±${tol})`
        });
      }

      // Compare ARs (prefer expected vs active; else canvas vs active)
      if (expectedAR && activeAR) {
        if (!approxEqual(expectedAR, activeAR, tol)) {
          findings.push({
            severity: "error",
            message: "Active/Image aspect ratio does not match expected",
            detail: `expected=${expectedAR.toFixed(6)} vs active=${activeAR.toFixed(6)}`
          });
        } else {
          findings.push({
            severity: "info",
            message: "Active/Image aspect ratio matches expected",
            detail: `active AR=${activeAR.toFixed(6)}`
          });
        }
      } else if (canvasAR && activeAR) {
        // Not necessarily must match, but often should be consistent
        if (!approxEqual(canvasAR, activeAR, tol)) {
          findings.push({
            severity: "warn",
            message: "Canvas AR differs from Active/Image AR (may be valid, but please confirm)",
            detail: `canvas=${canvasAR.toFixed(6)} vs active=${activeAR.toFixed(6)}`
          });
        } else {
          findings.push({
            severity: "info",
            message: "Canvas AR and Active/Image AR are close",
            detail: `AR=${activeAR.toFixed(6)}`
          });
        }
      }

      return findings;
    }
  },
  {
    id: "SHOT_SEGMENT_CONTINUITY",
    run: ({ doc }) => {
      if (!doc) return [];
      const segs = findSegments(doc);
      if (segs.length < 2) {
        return [{
          severity: "info",
          message: "Not enough segment/frame ranges found to validate continuity (heuristic)",
          detail: "If your metadata uses a different schema, you may need a custom rule"
        }];
      }

      const findings = [{
        severity: "info",
        message: `Found ${segs.length} frame ranges (heuristic)` ,
        detail: `First: ${segs[0].in}-${segs[0].out}, Last: ${segs[segs.length - 1].in}-${segs[segs.length - 1].out}`
      }];

      // Check gaps/overlaps
      let gaps = 0, overlaps = 0;
      for (let i = 1; i < segs.length; i++) {
        const prev = segs[i - 1], cur = segs[i];
        if (cur.in > prev.out + 1) gaps++;
        if (cur.in <= prev.out) overlaps++;
      }

      if (gaps > 0) {
        findings.push({
          severity: "warn",
          message: `Gaps found between frame ranges: ${gaps}`,
          detail: "May indicate discontinuous cut boundaries or a metadata conversion issue"
        });
      }
      if (overlaps > 0) {
        findings.push({
          severity: "error",
          message: `Overlaps found between frame ranges: ${overlaps}`,
          detail: "Often causes shot mapping issues; verify the timeline and the export"
        });
      }
      if (gaps === 0 && overlaps === 0) {
        findings.push({
          severity: "info",
          message: "Frame ranges look continuous (heuristic)",
          detail: "Still recommended to visually spot-check highlight-heavy shots, fades, and hard cuts"
        });
      }
      return findings;
    }
  }
];
