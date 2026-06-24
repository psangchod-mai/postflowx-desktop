// features/aceslook/services/acesTransformIds.js
// ─────────────────────────────────────────────────────────────────────────────
// ACES transform ID MANIFEST — the single source of truth for IDT/ODT/LMT IDs.
//
// (The task spec calls for `assets/aces/aces_transform_ids.json`. It's realized
// here as a co-located ES module instead of a repo-root JSON so the SAME import
// path resolves in both the Electron renderer AND Node tests — a JSON under
// `assets/` cannot be imported with a stable relative path across src/ and the
// built dist/desktop/ tree, because the build rewrites asset URLs but not ESM
// imports. Edit THIS one file to update IDs; no logic changes needed.)
//
// IDs to update when the ACES manifest / OCIO config advances:
//   - aces2_0_id: ACES 2.0 Transform ID (primary; PostFlowX defaults to 2.0)
//   - aces1_3_id: ACES 1.x Transform ID (legacy interop). `null` where the
//     canonical 1.x ID isn't confidently known — the registry then returns a
//     null transformId for 1.3 rather than emitting a wrong/guessed ID.
//
// Provenance:
//   ACES 2.0 IDT/ODT registry — https://github.com/ampas/aces-dev (CTL `aces-output`/`idt`)
//   Per-version Transform ID manifest — ampas/aces ACEStransformID spec
//   OCIO ACES config — https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES
'use strict';

export const ACES_TRANSFORM_IDS = {
  acesVersion: '2.0',
  source: 'https://github.com/ampas/aces-dev (+ OpenColorIO-Config-ACES)',
  retrieved: '2026-06-22',

  // kind: 'idt' | 'odt' | 'lmt'
  // amfApplicable: emit a transformId in AMF (false → file-reference or omitted)
  transforms: {
    // ── Input transforms (IDT) ───────────────────────────────────────────────
    AUTO:              { kind: 'idt', label: 'AUTO (Detect)', ocioName: null, amfApplicable: false, aces1_3_id: null, aces2_0_id: null, note: 'Resolved from source detection. Blocks export until resolved.' },
    ARRI_LOGC3:        { kind: 'idt', label: 'ARRI LogC3 (EI800)', ocioName: 'ARRI LogC3 EI800', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.5:IDT.ARRI.Alexa-v3-logC-EI800.a1.v2',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:IDT.ARRI.Alexa-v3-logC3-EI800.a1.v2' },
    ARRI_LOGC4:        { kind: 'idt', label: 'ARRI LogC4', ocioName: 'ARRI LogC4', amfApplicable: true,
                         aces1_3_id: null, // LogC4 postdates ACES 1.x camera IDT set
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:IDT.ARRI.Alexa35-logC4.a1.v1' },
    SONY_SLOG3:        { kind: 'idt', label: 'Sony S-Log3 / S-Gamut3.Cine', ocioName: 'S-Log3 S-Gamut3.Cine', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.1:IDT.Sony.SLog3_SGamut3Cine.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:IDT.Sony.Venice_SLog3_SGamut3Cine.a1.v1' },
    RED_LOG3G10:       { kind: 'idt', label: 'RED Log3G10 / REDWideGamutRGB', ocioName: 'RED Log3G10 REDWideGamutRGB', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.1:IDT.RED.Log3G10_REDWideGamutRGB.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:IDT.RED.Log3G10_REDWideGamutRGB.a1.v1' },
    VLOG:              { kind: 'idt', label: 'Panasonic V-Log / V-Gamut', ocioName: 'V-Log V-Gamut', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.1:IDT.Panasonic.VLog_VGamut.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:IDT.Panasonic.VLog_VGamut.a1.v1' },
    REC709:            { kind: 'idt', label: 'Rec.709 / SDR QT', ocioName: 'sRGB', amfApplicable: false,
                         aces1_3_id: null, aces2_0_id: null, note: 'No official ACES IDT for Rec.709; AMF uses a CLF file reference.' },
    ACES2065_1:        { kind: 'idt', label: 'ACES2065-1 (already ACES)', ocioName: 'ACES2065-1', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.0:CSC.Academy.ACES_to_ACES.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:CSC.Academy.ACES2065-1_to_ACES2065-1.a1.v1' },
    NONE_ALREADY_ACES: { kind: 'idt', label: 'None (already in ACES)', ocioName: null, amfApplicable: false, aces1_3_id: null, aces2_0_id: null, note: 'Source already in ACES working space. No IDT.' },
    CUSTOM_FILE:       { kind: 'idt', label: 'Custom CLF file', ocioName: null, amfApplicable: false, aces1_3_id: null, aces2_0_id: null, note: 'Custom CLF/LUT provided by user (file reference).' },

    // ── Look transforms (LMT) ────────────────────────────────────────────────
    // ASC-CDL LMT: ACES 2.0 retains the v1.4 ASC_CDL LMT TransformID (no 2.0
    // re-issue of this LMT in the manifest); documented rather than guessed.
    LMT_ASC_CDL:       { kind: 'lmt', label: 'ASC CDL (look)', ocioName: null, amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.4:LMT.Academy.ASC_CDL.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v1.4:LMT.Academy.ASC_CDL.a1.v1',
                         note: 'ACES 2.0 carries the v1.4 ASC_CDL LMT ID (no 2.0 re-issue). Verify against ampas/aces manifest before changing.' },
    // ACES Reference Gamut Compression — opt-in only; 2.0 ODT already gamut-maps.
    LMT_RGC:           { kind: 'lmt', label: 'Reference Gamut Compression (RGC)', ocioName: 'ACES 1.3 Reference Gamut Compression', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.3:LMT.Academy.ReferenceGamutCompress.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v1.3:LMT.Academy.ReferenceGamutCompress.a1.v1',
                         legacy20NotRecommended: true,
                         note: 'Standalone RGC generally NOT recommended with an ACES 2.0 Output Transform (it already maps gamut).' },

    // ── Output transforms (ODT) ──────────────────────────────────────────────
    SDR_REC709:        { kind: 'odt', label: 'Rec.709 (SDR)', ocioName: 'Rec.709', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.0:ODT.Academy.Rec709_100nits_dim.a1.0.3',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:ODT.Academy.Rec709_100nits_dim.a1.v1' },
    HDR_REC2100_PQ:    { kind: 'odt', label: 'Rec.2100 PQ (HDR)', ocioName: 'Rec.2100 PQ', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.1:ODT.Academy.Rec2100_PQ_1000nits.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:ODT.Academy.Rec2100_PQ.a1.v1' },
    HDR_P3D65_PQ1000:  { kind: 'odt', label: 'P3-D65 PQ 1000 nit (HDR)', ocioName: 'P3-D65 PQ 1000 nits', amfApplicable: true,
                         aces1_3_id: 'urn:ampas:aces:transformId:v1.1:ODT.Academy.P3D65_1000nits_15nits_ST2084.a1.v1',
                         aces2_0_id: 'urn:ampas:aces:transformId:v2.0:ODT.Academy.P3D65_PQ1000nits.a1.v1' },
    // ACES 2.0 makes higher-peak P3 PQ displays first-class (1.x lacked these).
    HDR_P3D65_PQ2000:  { kind: 'odt', label: 'P3-D65 PQ 2000 nit (HDR)', ocioName: 'P3-D65 PQ 2000 nits', amfApplicable: true,
                         aces1_3_id: null, aces2_0_id: 'urn:ampas:aces:transformId:v2.0:ODT.Academy.P3D65_PQ2000nits.a1.v1' },
    HDR_P3D65_PQ4000:  { kind: 'odt', label: 'P3-D65 PQ 4000 nit (HDR)', ocioName: 'P3-D65 PQ 4000 nits', amfApplicable: true,
                         aces1_3_id: null, aces2_0_id: 'urn:ampas:aces:transformId:v2.0:ODT.Academy.P3D65_PQ4000nits.a1.v1' },
    // Parametric "custom display" — ACES 2.0 builds the Output Transform from
    // display parameters, so non-stock targets are first-class. The concrete
    // transformId is resolved by the OCIO config at apply time, hence null here.
    CUSTOM_DISPLAY:    { kind: 'odt', label: 'Custom display (parametric)', ocioName: null, amfApplicable: true,
                         aces1_3_id: null, aces2_0_id: null, parametric: true,
                         params: { peak_nits: 1000, limiting_primaries: 'P3-D65', eotf: 'PQ' },
                         note: 'ACES 2.0 parametric Output Transform; transformId resolved by the OCIO config from params.' },
    NONE_RECIPE_ONLY:  { kind: 'odt', label: 'None (recipe only, no output bake)', ocioName: null, amfApplicable: false,
                         aces1_3_id: null, aces2_0_id: null, note: 'VFX pulls — no OT element in AMF.' },
  },
};

export default ACES_TRANSFORM_IDS;
