// xml.js's Basic Motion "scale" parsing — an axis-specific Scale X/Scale Y
// parameter must not also populate the uniform `transform.scale` field.
//
// extractFxFromClipitem()'s generic-scale branch excludes axis-specific keys
// via `!key.includes('scalex') && !key.includes('scaley')`, but the axis
// branches it's meant to defer to also recognize the *spaced* form emitted by
// a real XMEML <name>Scale X</name>/<name>Scale Y</name> tag (when there is
// no <parameterid>, `key` falls back to the lowercased <name> text, i.e.
// "scale x"/"scale y"). `"scale x".includes('scalex')` is false — no
// contiguous "scalex" substring — so the exclusion never fires for the
// spaced form, and a Scale X/Scale Y parameter wrongly sets BOTH
// transform.scale (uniform) and transform.scaleX/scaleY (per-axis).
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXMEML } from '../../src/scripts/parsers/xml.js';

function buildWithMotionParam(paramName, value) {
  return `<?xml version="1.0"?><xmeml version="5"><sequence>
    <name>R</name><rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
    <timecode><rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
      <frame>86400</frame><displayformat>NDF</displayformat></timecode>
    <media><video><track><clipitem><name>c1</name>
      <start>0</start><end>24</end><in>0</in><out>24</out>
      <rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
      <file><name>A001C001.mov</name><pathurl>file:///a.mov</pathurl>
        <timecode><frame>86400</frame>
          <rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
        </timecode></file>
      <filter><effect><name>Basic Motion</name>
        <parameter><name>${paramName}</name><value>${value}</value></parameter>
      </effect></filter>
    </clipitem></track></video></media></sequence></xmeml>`;
}

test('a Scale X parameter sets transform.scaleX only, not transform.scale', () => {
  const res = parseXMEML(buildWithMotionParam('Scale X', '150'));
  const tf = res.events[0].transform;
  assert.ok(tf, 'transform present');
  assert.equal(tf.scaleX, 1.5, '150 > 10, so normalized to a 1.5 multiplier');
  assert.equal(tf.scale, undefined, 'an axis-specific param must not also set the uniform scale');
});

test('a Scale Y parameter sets transform.scaleY only, not transform.scale', () => {
  const res = parseXMEML(buildWithMotionParam('Scale Y', '75'));
  const tf = res.events[0].transform;
  assert.ok(tf, 'transform present');
  assert.equal(tf.scaleY, 0.75, '75 > 10, so normalized to a 0.75 multiplier');
  assert.equal(tf.scale, undefined, 'an axis-specific param must not also set the uniform scale');
});

test('a plain Scale parameter still sets the uniform transform.scale', () => {
  const res = parseXMEML(buildWithMotionParam('Scale', '150'));
  const tf = res.events[0].transform;
  assert.ok(tf, 'transform present');
  assert.equal(tf.scale, 150, 'a true uniform-scale parameter must still populate transform.scale');
  assert.equal(tf.scaleX, undefined);
  assert.equal(tf.scaleY, undefined);
});
