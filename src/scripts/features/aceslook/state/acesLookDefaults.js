// scripts/features/acesLook/state/acesLookDefaults.js
// Default state objects for each supported workflow mode.

export const MODE_DEFAULTS = {
  hdr_vfx_pull: {
    workingLocation:   'ACEScg',
    outputTransform:   'NONE_RECIPE_ONLY',
    preserveSdr:       false,
    displayLabel:      'HDR VFX Pull',
    description:       'Pull camera-native footage into ACES for VFX. No output bake.',
  },
  hdr_dailies: {
    workingLocation:   'ACEScct',
    outputTransform:   'HDR_P3D65_PQ1000',
    preserveSdr:       false,
    displayLabel:      'HDR Dailies',
    description:       'HDR-graded dailies output to P3-D65 PQ 1000 nit.',
  },
  hdr_review: {
    workingLocation:   'ACEScct',
    outputTransform:   'HDR_REC2100_PQ',
    preserveSdr:       false,
    displayLabel:      'HDR Review',
    description:       'HDR review output to Rec.2100 PQ for mastering suites.',
  },
  sdr_qt_in_hdr_show: {
    workingLocation:   'ACEScct',
    outputTransform:   'SDR_REC709',
    preserveSdr:       true,
    displayLabel:      'SDR QT in HDR Show',
    description:       'Treat SDR Rec.709 QuickTime sources within an HDR show pipeline.',
  },
};

export const WORKING_LOCATIONS = ['ACEScg', 'ACEScct'];

export const EMPTY_CDL = {
  slope:  [1, 1, 1],
  offset: [0, 0, 0],
  power:  [1, 1, 1],
  sat:    1.0,
};

export function defaultState() {
  return {
    source:          null,           // File | null (never serialized)
    sourceName:      '',             // string — survives serialization, drives re-link overlay
    sourceClass:     'unknown',      // camera_native | aces_exr_ap0 | qt_rec709 | unknown
    mode:            'hdr_vfx_pull',
    inputTransform:  'AUTO',
    workingLocation: 'ACEScg',
    outputTransform: 'NONE_RECIPE_ONLY',
    preserveSdr:     false,
    primaryControls: {
      exposure:    0,
      contrast:    1,
      saturation:  1,
      temperature: 0,
    },
    cdlEnabled:  false,
    cdl:         { ...EMPTY_CDL },
    lookStack:   [],                 // [{ id, kind, label, enabled, file?, transformId? }]
    clipId:      '',
    warnings:    [],
    errors:      [],
    exportResult: null,
  };
}
