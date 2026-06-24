// Color Recipe Resolver — Phase 1 (detection only).
// Searches for AMF, CDL/LUT sidecar files adjacent to the OCF source.
// Phase 2: AMF XML parsing and applied= flag logic.
(function () {
  'use strict';

  const SEARCH_ORDER = ['amf', 'cdl_lut', 'aces_default', 'bypass'];

  function _now() { return new Date().toISOString(); }

  function _hashString(s) {
    // Simple djb2 — not cryptographic, used for change detection only
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  // ── AMF detection (filesystem probe via File System Access) ───────────────
  // Looks for <stem>.amf or AMF/ subdirectory relative to the OCF file path.
  async function _findAmfNear(ocfPath) {
    // ocfPath is a full path string; we can only use it if a FileSystemDirectoryHandle is stored.
    // Phase 1: check known AMF roots from localStorage.
    try {
      const amfRoots = JSON.parse(localStorage.getItem('pfx.amf.roots') || '[]');
      // If project has AMF root paths recorded, signal found (actual file matching is Phase 2)
      if (amfRoots.length > 0) {
        return {
          status:  'amf_found',
          amfPath: '(detected)',
          warnings: ['AMF root configured; file matching requires Phase 2 XML parser'],
        };
      }
    } catch { }
    // Fallback: check window state from Plate Link
    const amfState = window.__MPS_AMF_STATE;
    if (amfState?.path || amfState?.amfPath) {
      return {
        status:  'amf_found',
        amfPath: amfState.path || amfState.amfPath || '',
        warnings: [],
      };
    }
    return null;
  }

  // ── CDL/LUT sidecar detection ─────────────────────────────────────────────
  function _findCdlLutNear(ocfPath) {
    // Phase 1: look at window __MPS state for loaded CDL/LUT
    const ocioMeta = window.__MPS_OCIO_FILE_META;
    if (ocioMeta?.path) {
      return {
        status:  'cdl_lut_found',
        lutPath: ocioMeta.path,
        warnings: [],
      };
    }
    return null;
  }

  // ── ACES default IDT from camera family ───────────────────────────────────
  function _acesDefault(camera) {
    const IDT_MAP = {
      ARRI:  'ARRI LogC3 EI800 IDT ACES',
      RED:   'RED IPP2 IDT ACES',
      SONY:  'Sony S-Gamut3.Cine/S-Log3 IDT ACES',
      CANON: 'Canon Cinema Gamut/CLog2 IDT ACES',
      BRAW:  'Blackmagic Film Gen5 IDT ACES',
    };
    const idt = IDT_MAP[camera] || null;
    return {
      status:         'aces_default',
      inputTransform: idt,
      warnings:       idt ? [] : [`No ACES IDT for camera: ${camera}`],
    };
  }

  // ── Compute recipe hash ───────────────────────────────────────────────────
  function _recipeHash(recipe) {
    const key = [
      recipe.status,
      recipe.amfPath || '',
      recipe.amfUuid || '',
      recipe.cdlPath || '',
      recipe.lutPath || '',
      recipe.clfPath || '',
      recipe.inputTransform || '',
    ].join('|');
    return _hashString(key);
  }

  // ── Main resolver ─────────────────────────────────────────────────────────
  async function resolveForSWI(swi) {
    if (!swi) return null;
    const ocfPath = swi.ocf?.path || '';
    const camera  = swi.camera || 'UNKNOWN';

    // 1. AMF
    const amf = await _findAmfNear(ocfPath);
    if (amf) {
      const recipe = {
        status:   amf.status,
        mode:     'recipe',
        amfPath:  amf.amfPath,
        warnings: amf.warnings || [],
      };
      recipe.hash = _recipeHash(recipe);
      return recipe;
    }

    // 2. CDL / LUT
    const cdl = _findCdlLutNear(ocfPath);
    if (cdl) {
      const recipe = {
        status:   cdl.status,
        mode:     'recipe',
        lutPath:  cdl.lutPath,
        cdlPath:  cdl.cdlPath,
        warnings: cdl.warnings || [],
      };
      recipe.hash = _recipeHash(recipe);
      return recipe;
    }

    // 3. ACES default
    if (camera !== 'UNKNOWN') {
      const aces = _acesDefault(camera);
      const recipe = {
        status:         aces.status,
        mode:           'template',
        inputTransform: aces.inputTransform,
        outputTransform: 'Rec.709',
        warnings:       aces.warnings || [],
      };
      recipe.hash = _recipeHash(recipe);
      return recipe;
    }

    // 4. Bypass / missing
    const recipe = {
      status:   'missing',
      mode:     'bypass',
      warnings: ['No color recipe found; proxy will use bypass/source transform'],
    };
    recipe.hash = _recipeHash(recipe);
    return recipe;
  }

  // ── Resolve color for all SWIs that are OCF-linked ───────────────────────
  async function resolveAll() {
    if (!window.PFX_SWI) return { ok: false };
    const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
    const all = await window.PFX_SWI.getAll(projectId);
    let resolved = 0;
    for (const swi of all) {
      if (swi.ocfStatus !== 'linked' && swi.ocfStatus !== 'locked') continue;
      const recipe = await resolveForSWI(swi);
      if (recipe) {
        const colorStatus = recipe.status === 'amf_found'       ? 'amf_found'
          : recipe.status === 'cdl_lut_found' ? 'cdl_lut_found'
          : recipe.status === 'aces_default'  ? 'aces_default'
          : 'bypass';
        await window.PFX_SWI.update(swi.shotWorkId, { color: recipe, colorStatus });
        resolved++;
      }
    }
    return { ok: true, resolved };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_COLOR_RECIPE = {
    resolveForSWI,
    resolveAll,
  };

  console.info('[COLOR_RECIPE] Color Recipe module ready');
})();
