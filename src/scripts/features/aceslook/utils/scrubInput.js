// Drag-to-scrub + double-click-to-reset for numeric controls.
//
// attachScrub(labelEl, inputEl, opts)
//   labelEl   — the draggable trigger (label/span); gets ew-resize cursor
//   inputEl   — the <input type="number"> to update
//   opts.step       — value change per pixel of drag (default 0.01)
//   opts.min/max    — clamp bounds
//   opts.decimals   — display precision (default 3)
//   opts.defaultVal — value restored on double-click of inputEl
//   opts.onChange   — called with new numeric value on every change

export function attachScrub(labelEl, inputEl, {
  step       = 0.01,
  min,
  max,
  decimals   = 3,
  defaultVal,
  onChange,
} = {}) {
  labelEl.style.cursor = 'ew-resize';
  labelEl.title = 'Drag to adjust' + (defaultVal !== undefined ? ' · Double-click value to reset' : '');

  labelEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();

    const startX   = e.clientX;
    const startVal = parseFloat(inputEl.value) || 0;

    document.body.style.cursor    = 'ew-resize';
    document.body.style.userSelect = 'none';

    function onMove(mv) {
      const dx = mv.clientX - startX;
      let v = startVal + dx * step;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      v = Math.round(v / step) * step;           // snap to step
      inputEl.value = v.toFixed(decimals);
      onChange?.(parseFloat(v.toFixed(decimals)));
    }

    function onUp() {
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // Double-click on the number input to reset to default
  if (defaultVal !== undefined) {
    inputEl.addEventListener('dblclick', e => {
      e.preventDefault();
      inputEl.value = Number(defaultVal).toFixed(decimals);
      onChange?.(defaultVal);
    });
    inputEl.title = 'Double-click to reset to default';
  }

  // Scroll wheel on the number input for fine adjustment
  inputEl.addEventListener('wheel', e => {
    if (document.activeElement !== inputEl) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    let v = (parseFloat(inputEl.value) || 0) + dir * step;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    inputEl.value = v.toFixed(decimals);
    onChange?.(parseFloat(v.toFixed(decimals)));
  }, { passive: false });
}

// Variant: scrub a single label across multiple inputs (ganged channels).
// onChange receives the new delta-applied array of values.
export function attachScrubGanged(labelEl, inputEls, {
  step       = 0.001,
  min,
  max,
  decimals   = 4,
  defaultVals,
  onChange,
} = {}) {
  labelEl.style.cursor = 'ew-resize';
  labelEl.title = 'Drag to adjust all channels' + (defaultVals ? ' · Double-click to reset' : '');

  labelEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();

    const startX    = e.clientX;
    const startVals = inputEls.map(el => parseFloat(el.value) || 0);

    document.body.style.cursor     = 'ew-resize';
    document.body.style.userSelect = 'none';

    function onMove(mv) {
      const dx = mv.clientX - startX;
      const vals = startVals.map(sv => {
        let v = sv + dx * step;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        return parseFloat(v.toFixed(decimals));
      });
      inputEls.forEach((el, i) => { el.value = vals[i].toFixed(decimals); });
      onChange?.(vals);
    }

    function onUp() {
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // Double-click label to reset all channels
  if (defaultVals) {
    labelEl.addEventListener('dblclick', () => {
      inputEls.forEach((el, i) => { el.value = Number(defaultVals[i]).toFixed(decimals); });
      onChange?.(defaultVals);
    });
  }
}
