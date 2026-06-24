// imf_delivery_schema.js — IMF Delivery Schema validation + App #2E built-in preset
// IMF UG Delivery Schema: https://www.imfug.com/open-source/
'use strict';

// ── Built-in presets ──────────────────────────────────────────────────────────

// SMPTE ST 2067-21 App #2E (Generic IMF Application #2 Extended) built-in ruleset.
// These rules are derived from the normative text of ST 2067-21 and common IMF UG guidance.
export const APP2E_PRESET = {
  id: 'app2e-builtin',
  label: 'Generic IMF App #2E (ST 2067-21)',
  source: 'builtin',
  rules: [
    {
      id: 'app2e-r01',
      section: 'ST 2067-21 §5',
      label: 'ApplicationIdentification',
      description: 'CPL shall include ApplicationIdentification referencing App #2E UL',
      severity: 'fail',
      check(cpl) {
        const appId = cpl?.applicationIdentification || cpl?.applicationId || '';
        return appId.includes('2067-21') || appId.includes('060e2b34.04010105.0e090602.01000000');
      },
    },
    {
      id: 'app2e-r02',
      section: 'ST 2067-3 §8.5',
      label: 'ContentVersionList',
      description: 'CPL shall contain at least one ContentVersion element',
      severity: 'fail',
      check(cpl) {
        return !!(cpl?.contentVersionId || (Array.isArray(cpl?.contentVersionList) && cpl.contentVersionList.length > 0));
      },
    },
    {
      id: 'app2e-r03',
      section: 'ST 2067-3 §8.6',
      label: 'EssenceDescriptorList',
      description: 'CPL shall include EssenceDescriptorList with one descriptor per unique MXF track',
      severity: 'fail',
      check(cpl) {
        return !!cpl?.essenceDescriptorList;
      },
    },
    {
      id: 'app2e-r04',
      section: 'ST 2067-21 §6.1',
      label: 'Video Frame Rate',
      description: 'Image essence shall use a frame rate conforming to App #2E: 24, 25, 30, 48, 50, or 60 fps (or fractional equivalents)',
      severity: 'warn',
      check(cpl) {
        const er = cpl?.editRate;
        if (!er) return null; // skip
        const validRates = [24, 25, 30, 48, 50, 60, 23.976, 29.97, 47.952, 59.94];
        return validRates.some(r => Math.abs(er - r) < 0.01);
      },
    },
    {
      id: 'app2e-r05',
      section: 'ST 2067-21 §6.2',
      label: 'Video Resolution',
      description: 'App #2E restricts video resolutions to approved sizes (e.g. 1920×1080, 3840×2160, 2048×1080, 4096×2160)',
      severity: 'warn',
      check(cpl) {
        const ed = cpl?.essenceDescriptorList;
        if (!ed) return null;
        // Check if any video descriptor has a recognized resolution
        const approved = [[1920,1080],[3840,2160],[2048,1080],[4096,2160],[1280,720],[2048,858],[4096,1716]];
        const videoDesc = Array.isArray(ed) ? ed.find(d => d.storedWidth || d.width) : null;
        if (!videoDesc) return null;
        const w = videoDesc.storedWidth || videoDesc.width || 0;
        const h = videoDesc.storedHeight || videoDesc.height || 0;
        return approved.some(([aw, ah]) => aw === w && ah === h);
      },
    },
    {
      id: 'app2e-r06',
      section: 'ST 2067-21 §6.3',
      label: 'Audio Bit Depth',
      description: 'App #2E requires audio essence bit depth of 24 bits',
      severity: 'warn',
      check(cpl) {
        const ed = cpl?.essenceDescriptorList;
        if (!ed) return null;
        const audioDesc = Array.isArray(ed) ? ed.find(d => d.audioSamplingRate || d.quantizationBits) : null;
        if (!audioDesc) return null;
        const bits = audioDesc.quantizationBits || audioDesc.bitDepth || 0;
        return bits === 24 || bits === 0; // 0 = unknown = skip
      },
    },
    {
      id: 'app2e-r07',
      section: 'ST 2067-21 §6.3',
      label: 'Audio Sample Rate',
      description: 'App #2E requires audio essence sampling rate of 48000 Hz',
      severity: 'warn',
      check(cpl) {
        const ed = cpl?.essenceDescriptorList;
        if (!ed) return null;
        const audioDesc = Array.isArray(ed) ? ed.find(d => d.audioSamplingRate) : null;
        if (!audioDesc) return null;
        const sr = audioDesc.audioSamplingRate || 0;
        return sr === 48000 || sr === 0;
      },
    },
    {
      id: 'app2e-r08',
      section: 'ST 2067-2 §C',
      label: 'TimecodeTrack',
      description: 'CPL should contain a TimecodeTrack (required in App #2 / recommended in App #2E)',
      severity: 'warn',
      check(cpl) {
        return !!cpl?.timecodeTrack;
      },
    },
    {
      id: 'app2e-r09',
      section: 'ST 2067-21 §7',
      label: 'Segment Count',
      description: 'App #2E CPLs are typically single-segment; multi-segment packages require care with reel alignment',
      severity: 'info',
      check(cpl) {
        const segs = cpl?.segments?.length || cpl?.segmentList?.length || 1;
        return segs === 1;
      },
    },
  ],
};

// ── Parse a Delivery Schema XML string ───────────────────────────────────────
// Parses an IMF UG Delivery Schema XML document and extracts named constraints.
// Returns { ok, schema: { id, label, rules[] } | null, error? }
export function parseDeliverySchema(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') {
    return { ok: false, schema: null, error: 'No XML provided' };
  }
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) {
      return { ok: false, schema: null, error: 'XML parse error: ' + parseErr.textContent.slice(0, 120) };
    }

    const root = doc.documentElement;
    const schemaId = root.getAttribute('id') || root.getAttribute('ID') || 'custom-schema';
    const schemaLabel = _getText(root, 'Label') || _getText(root, 'Name') || schemaId;
    const ruleEls = Array.from(root.querySelectorAll('Rule, Constraint, Check'));

    const rules = ruleEls.map((el, i) => {
      const id       = el.getAttribute('id') || el.getAttribute('ID') || `rule-${i}`;
      const label    = _getText(el, 'Label') || _getText(el, 'Name') || id;
      const section  = _getText(el, 'Section') || _getText(el, 'Reference') || '';
      const desc     = _getText(el, 'Description') || _getText(el, 'Text') || '';
      const sevStr   = el.getAttribute('severity') || _getText(el, 'Severity') || 'warn';
      const severity = ['fail','warn','info'].includes(sevStr) ? sevStr : 'warn';
      const valueEl  = el.querySelector('AllowedValues, AllowedValue, Value, Pattern');
      const allowed  = valueEl ? Array.from(valueEl.querySelectorAll('Value, Option')).map(v => v.textContent.trim()) : [];
      const field    = el.getAttribute('field') || _getText(el, 'Field') || '';

      return { id, label, section, description: desc, severity, field, allowedValues: allowed, _schemaRule: true };
    });

    return { ok: true, schema: { id: schemaId, label: schemaLabel, source: 'xml', rules } };
  } catch (e) {
    return { ok: false, schema: null, error: e.message };
  }
}

function _getText(el, tag) {
  const child = el.querySelector(tag);
  return child ? child.textContent.trim() : '';
}

// ── Validate CPL/AssetMap/PKL against a schema's rules ────────────────────────
// Returns array of { ruleId, label, section, status: 'pass'|'warn'|'fail'|'skip'|'info', detail }
export function validateAgainstSchema(pkg, schema) {
  if (!schema || !Array.isArray(schema.rules)) return [];
  const { cpl, assetMap, pkl, fileMap } = pkg || {};

  return schema.rules.map(rule => {
    // Built-in rules have a check() function
    if (typeof rule.check === 'function') {
      let result;
      try { result = rule.check(cpl); } catch { result = null; }
      if (result === null || result === undefined) {
        return _ruleResult(rule, 'skip', 'Insufficient metadata to evaluate');
      }
      if (result === true)  return _ruleResult(rule, 'pass', rule.description);
      if (result === false) return _ruleResult(rule, rule.severity || 'warn', rule.description);
    }

    // Schema-driven rules (from XML): check allowed values against CPL fields
    if (rule._schemaRule && rule.field && cpl) {
      const fieldParts = rule.field.split('.');
      let val = cpl;
      for (const part of fieldParts) { val = val?.[part]; }
      if (val === undefined || val === null) {
        return _ruleResult(rule, 'skip', `Field "${rule.field}" not present in loaded CPL`);
      }
      const strVal = String(val);
      if (rule.allowedValues.length > 0 && !rule.allowedValues.includes(strVal)) {
        return _ruleResult(rule, rule.severity, `Value "${strVal}" not in allowed set: ${rule.allowedValues.join(', ')}`);
      }
      return _ruleResult(rule, 'pass', `"${strVal}" — compliant`);
    }

    return _ruleResult(rule, 'skip', 'Rule type not evaluable without full MXF parse');
  });
}

function _ruleResult(rule, status, detail) {
  return {
    ruleId:  rule.id,
    label:   rule.label,
    section: rule.section || '',
    status,
    detail:  detail || '',
  };
}

// ── Run built-in App #2E preset against a package ────────────────────────────
export function validateApp2E(pkg) {
  return validateAgainstSchema(pkg, APP2E_PRESET);
}
