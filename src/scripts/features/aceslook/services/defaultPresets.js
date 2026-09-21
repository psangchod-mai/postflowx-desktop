// scripts/features/acesLook/services/defaultPresets.js
//
// Bundled starter ACES Look presets (D2 "shipped library"). These give a new
// user sensible one-click starting points instead of a blank panel. Each uses
// only valid enum values (see acesLookDefaults.js / acesTransformIds.js):
//   mode            ∈ hdr_vfx_pull | hdr_dailies | hdr_review | sdr_qt_in_hdr_show
//   inputTransform  ∈ IDT registry keys (AUTO, ARRI_LOGC4, SONY_SLOG3, …)
//   workingLocation ∈ ACEScg | ACEScct
//   outputTransform ∈ NONE_RECIPE_ONLY | HDR_P3D65_PQ1000 | HDR_REC2100_PQ | SDR_REC709

const NEUTRAL_PRIMARIES = { exposure: 0, contrast: 1, saturation: 1, temperature: 0 };
const NEUTRAL_CDL = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1.0 };

function _preset(name, mode, inputTransform, workingLocation, outputTransform, preserveSdr = false) {
  return {
    name, mode, inputTransform, workingLocation, outputTransform, preserveSdr,
    primaryControls: { ...NEUTRAL_PRIMARIES },
    cdlEnabled: false,
    cdl: { ...NEUTRAL_CDL },
    lookStack: [],
  };
}

// The shipped library. Camera→ACES pulls (no output bake) + common deliveries.
export const DEFAULT_PRESETS = [
  _preset('ARRI LogC4 → ACES Pull',     'hdr_vfx_pull',       'ARRI_LOGC4',  'ACEScg',  'NONE_RECIPE_ONLY'),
  _preset('Sony S-Log3 → ACES Pull',    'hdr_vfx_pull',       'SONY_SLOG3',  'ACEScg',  'NONE_RECIPE_ONLY'),
  _preset('RED Log3G10 → ACES Pull',    'hdr_vfx_pull',       'RED_LOG3G10', 'ACEScg',  'NONE_RECIPE_ONLY'),
  _preset('HDR Dailies — P3-D65 PQ 1000','hdr_dailies',       'AUTO',        'ACEScct', 'HDR_P3D65_PQ1000'),
  _preset('HDR Review — Rec.2100 PQ',   'hdr_review',         'AUTO',        'ACEScct', 'HDR_REC2100_PQ'),
  _preset('SDR QT in HDR Show — Rec.709','sdr_qt_in_hdr_show','REC709',      'ACEScct', 'SDR_REC709', true),
];
