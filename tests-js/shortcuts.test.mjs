// Keyboard shortcut config/combo logic. Run: node tests-js/shortcuts.test.mjs
// isMac() reads navigator.platform; getShortcutsConfig() reads localStorage → polyfill both.
// navigator is a read-only getter in modern Node → define it. (macOS combo path)
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
globalThis.window = globalThis.window || {};
globalThis.localStorage = (() => { const m = new Map();
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), clear: () => m.clear() }; })();

const {
  isTypingTarget, captureComboFromEvent, eventComboVariants, comboToDisplay,
  resolveShortcutAction, getShortcutsConfig, computeCustomCount,
} = await import('../src/scripts/core/shortcuts.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
function eqA(got, want, l) { eq(JSON.stringify(got), JSON.stringify(want), l); }

// ── isTypingTarget ──
ok(isTypingTarget({ tagName: 'INPUT' }), 'INPUT is typing target');
ok(isTypingTarget({ tagName: 'textarea' }), 'textarea is typing target');
ok(isTypingTarget({ tagName: 'SELECT' }), 'SELECT is typing target');
ok(isTypingTarget({ isContentEditable: true }), 'contentEditable is typing target');
ok(!isTypingTarget({ tagName: 'DIV' }), 'DIV is not typing target');
ok(!isTypingTarget(null), 'null is not typing target');

// ── captureComboFromEvent (mac: Cmd→MOD) ──
eq(captureComboFromEvent({ code: 'KeyS', metaKey: true }), 'MOD+KeyS', 'Cmd+S → MOD+KeyS');
eq(captureComboFromEvent({ code: 'KeyA', metaKey: true, shiftKey: true }), 'MOD+SHIFT+KeyA', 'Cmd+Shift+A');
eq(captureComboFromEvent({ code: 'KeyS', ctrlKey: true }), 'CTRL+KeyS', 'mac Ctrl stays explicit CTRL');
eq(captureComboFromEvent({ code: 'ShiftLeft' }), '', 'bare modifier → empty combo');
eq(captureComboFromEvent(null), '', 'null event → empty');

// ── eventComboVariants (explicit + aliased) ──
eqA(eventComboVariants({ code: 'KeyS', metaKey: true }), ['META+KeyS', 'MOD+KeyS'], 'meta variants');
eqA(eventComboVariants({ code: 'KeyJ' }), ['KeyJ'], 'no-modifier → single variant');
eqA(eventComboVariants({ code: 'MetaLeft' }), [], 'bare modifier → no variants');

// ── comboToDisplay (mac) ──
eq(comboToDisplay('MOD+KeyS'), 'Cmd+S', 'MOD→Cmd, KeyS→S');
eq(comboToDisplay('ALT+Comma'), 'Opt+,', 'ALT→Opt, Comma→,');
eq(comboToDisplay('SHIFT+Digit1'), 'Shift+1', 'SHIFT, Digit1→1');
eq(comboToDisplay('CTRL+KeyA'), 'Ctrl+A', 'CTRL→Ctrl');
eq(comboToDisplay('Numpad5'), 'Num 5', 'Numpad→Num');
eq(comboToDisplay('Equal'), '=', 'Equal→=');
eq(comboToDisplay(''), '-', 'empty → dash');

// ── resolveShortcutAction (explicit cfg → no localStorage dependency) ──
const cfg = {
  save:  { enabled: true,  combos: ['MOD+KeyS'] },
  open:  { enabled: false, combos: ['MOD+KeyO'] },
  blink: { enabled: true,  combos: ['KeyB'] },
};
eq(resolveShortcutAction({ code: 'KeyS', metaKey: true }, null, { cfg }), 'save', 'Cmd+S → save');
eq(resolveShortcutAction({ code: 'KeyB' }, null, { cfg }), 'blink', 'B → blink');
eq(resolveShortcutAction({ code: 'KeyO', metaKey: true }, null, { cfg }), null, 'disabled action not matched');
eq(resolveShortcutAction({ code: 'KeyO', metaKey: true }, null, { cfg, allowDisabled: true }), 'open', 'allowDisabled matches');
eq(resolveShortcutAction({ code: 'KeyZ', metaKey: true }, null, { cfg }), null, 'unmapped → null');
eq(resolveShortcutAction({ code: 'MetaLeft' }, null, { cfg }), null, 'bare modifier → null');

// ── getShortcutsConfig defaults + computeCustomCount ──
localStorage.clear();
const def = getShortcutsConfig();
ok(def && typeof def === 'object' && Object.keys(def).length > 0, 'default config has actions');
const c0 = computeCustomCount(def);
eq(c0.custom, 0, 'unmodified config → 0 custom');
ok(c0.total > 0, 'computeCustomCount reports total');
const firstId = Object.keys(def)[0];
const modified = { ...def, [firstId]: { ...def[firstId], combos: ['MOD+KeyQ', 'MOD+KeyW'] } };
eq(computeCustomCount(modified).custom, 1, 'one changed action → 1 custom');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
