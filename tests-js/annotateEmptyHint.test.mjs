import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const modal = readFileSync(join(ROOT, 'src/scripts/components/annotateModal/index.js'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/main.css'), 'utf8');

test('Annotate never covers a valid review frame with onboarding help', () => {
  assert.match(modal, /_setEmptyHintVisible\(_frameAvailability === 'missing'\)/);
  assert.doesNotMatch(modal, /_emptyHintTimer = setTimeout\(_dismissEmptyHint, 2000\)/);
});

test('Annotate empty hint visibility is class-driven and can override pro CSS safely', () => {
  assert.match(css, /\.sm-anno-empty-hint\s*\{[\s\S]*?opacity:\s*0\s*!important;[\s\S]*?visibility:\s*hidden\s*!important;/);
  assert.match(css, /\.sm-anno-empty-hint\.is-visible\s*\{[\s\S]*?opacity:\s*1\s*!important;[\s\S]*?visibility:\s*visible\s*!important;/);
});

test('Annotate reuses the active modal instead of stacking review windows', () => {
  assert.match(modal, /window\.__PFX_ACTIVE_ANNOTATE__/);
  assert.match(modal, /activeAnnotate\?\.isOpen\?\.\(\)/);
  assert.match(modal, /return activeAnnotate/);
});

test('Annotate primary action follows review completeness', () => {
  assert.match(modal, /mode = 'mark'; label = TT\('Add a mark'\)/);
  assert.match(modal, /mode = 'type'; label = TT\('Choose type'\)/);
  assert.match(modal, /mode = 'note'; label = TT\('Add review note'\)/);
  assert.match(modal, /btnDone\.addEventListener\('click', handlePrimaryAction\)/);
});

test('Annotate quick intents set note family and draft includes review context', () => {
  assert.match(modal, /data-note-group="remove"/);
  assert.match(modal, /ntSel\.dispatchEvent\(new Event\('change'/);
  assert.match(modal, /noteType: String\(ntSel\?\.value \|\| ''\)/);
  assert.match(modal, /Date\.now\(\) - Number\(saved\.ts\) > 7 \* 24 \* 60 \* 60 \* 1000/);
});
