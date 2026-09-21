// VFX Pull geometry/reframe engine. Run: node tests-js/geometryEngine.test.mjs
// Golden coverage for the LIVE (previously untested) src/.../vfxPull/geometryEngine.js.
import { extractGeometry, buildGeometrySidecar, RESIZE_MODE, GEOMETRY_BAKE }
  from '../src/scripts/features/vfxPull/geometryEngine.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
function eqA(got, want, l) { ok(JSON.stringify(got) === JSON.stringify(want), `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── identity event ──
const idg = extractGeometry({ sourceResolution: '4096x2160', outputResolution: '1920x1080' });
eq(idg.hasGeometry, false, 'identity → hasGeometry false');
eq(idg.scale, 1, 'identity scale 1');
eq(idg.ffmpegCrop, '', 'identity → no crop string');
eq(idg.ffmpegScale, 'scale=1920:1080', 'ffmpegScale from outputResolution');
eq(idg.resizeMode, RESIZE_MODE.SCALE_TO_FIT, 'default resize mode');
eq(idg.bakeMode, GEOMETRY_BAKE.NONE, 'bakeMode none by default');
eqA(idg.matrix, [1, 0, 0, 0, 1, 0, 0, 0, 1], 'identity matrix');
eq(idg.sourceResolution, '4096x2160', 'sourceResolution round-trips');

// ── resolution parsing variants ──
eq(extractGeometry({ sourceResolution: { width: 3840, height: 2160 } }).sourceResolution, '3840x2160', 'res from {width,height} object');
eq(extractGeometry({ mediaResolution: '2048x1080' }).sourceResolution, '2048x1080', 'res from mediaResolution fallback');
eq(extractGeometry({ timelineResolution: '1998x1080' }).ffmpegScale, 'scale=1998:1080', 'ffmpegScale falls back to timelineResolution');

// ── crop → ffmpeg crop string + hasGeometry ──
const cg = extractGeometry({ sourceResolution: '4096x2160', crop: { left: 100, right: 100, top: 50, bottom: 50 } });
eq(cg.ffmpegCrop, 'crop=3896:2060:100:50', 'crop math: (W-L-R):(H-T-B):L:T');
eq(cg.hasGeometry, true, 'crop → hasGeometry true');
ok(cg.notes.some(n => /Crop/.test(n)), 'crop note present');
// alternate NLE crop field names
eq(extractGeometry({ sourceResolution: '4096x2160', crop: { l: 10, r: 20, t: 0, b: 0 } }).ffmpegCrop, 'crop=4066:2160:10:0', 'crop l/r/t/b aliases');

// ── scale + matrix (scale-about-centre) ──
const sg = extractGeometry({ sourceResolution: '4096x2160', transform: { scale: 2 } });
eq(sg.hasGeometry, true, 'scale≠1 → hasGeometry');
eqA(sg.matrix, [2, 0, -2048, 0, 2, -1080, 0, 0, 1], 'scale=2 matrix about 4096x2160 centre');

// ── NLE field-name conventions ──
eq(extractGeometry({ transform: { zoomX: 1.5 } }).scale, 1.5, 'scale from transform.zoomX');
eq(extractGeometry({ transform: { scaleX: 2.56, scaleY: 2.56 } }).scale, 2.56, 'scale from Resolve transform.scaleX/scaleY');
eq(extractGeometry({ transform: { position: [40, -20] } }).positionX, 40, 'posX from Resolve transform.position pair');
eq(extractGeometry({ transform: { position: [40, -20] } }).positionY, -20, 'posY from Resolve transform.position pair');
eq(extractGeometry({ transform: { offsetX: 40, offsetY: -20 } }).positionX, 40, 'posX from transform.offsetX');
eq(extractGeometry({ transform: { offsetX: 40, offsetY: -20 } }).positionY, -20, 'posY from transform.offsetY');

// ── resize-mode mapping ──
eq(extractGeometry({ resizeMode: 'scale_to_fill' }).resizeMode, RESIZE_MODE.SCALE_TO_FILL, 'fill mode');
eq(extractGeometry({ resizeMode: 'CropToFit' }).resizeMode, RESIZE_MODE.CROP, 'crop mode (case-insensitive)');
eq(extractGeometry({ resizeMode: 'distort' }).resizeMode, RESIZE_MODE.STRETCH, 'stretch/distort mode');
eq(extractGeometry({ resizeMode: 'native' }).resizeMode, RESIZE_MODE.NONE, 'none/native mode');

// ── pixel aspect triggers hasGeometry ──
eq(extractGeometry({ sourceResolution: '720x576', pixelAspect: 1.46 }).hasGeometry, true, 'anamorphic PAR → hasGeometry');

// ── buildGeometrySidecar ──
const side = buildGeometrySidecar({ shotId: 'SH010', plateName: 'SH010_v1', geometry: cg });
eq(side.shotName, 'SH010', 'sidecar shotName');
eq(side.plateName, 'SH010_v1', 'sidecar plateName');
eq(side.cropL, 100, 'sidecar cropL from geometry');
eq(side.resizeMode, 'scale_to_fit', 'sidecar resizeMode');
const empty = buildGeometrySidecar({});
eq(empty.scale, 1, 'sidecar defaults scale 1');
eq(empty.bakeMode, 'none', 'sidecar defaults bakeMode none');
eqA(empty.notes, [], 'sidecar defaults notes []');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
