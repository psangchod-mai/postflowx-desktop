// Avid AAF parser — contract + golden.
//
// SKIPPED: AAF is an OLE2 (Structured Storage) binary container. Synthesizing
// valid OLE2 bytes by hand is error-prone and would risk a green test over a
// wrong fixture — which the task explicitly forbids. The correct fixture is a
// tiny REAL .aaf exported from Avid/Resolve. Once committed as
// test/fixtures/avid_basic.aaf, unskip this and assert contract + golden via
// the worker's extracted pure functions (see test/README.md → AAF).
import test from 'node:test';

test('avid_basic.aaf — contract + golden', { skip: 'Needs a real tiny .aaf sample (OLE2 binary — do not synthesize). See test/README.md.' }, () => {});
