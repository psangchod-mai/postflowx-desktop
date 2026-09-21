// Resolve the frame value that corresponds to second 0 of a flattened
// reference movie while accepting both relative and absolute parser events.
export function referenceBaseFrames(events, fps, tcToFrames) {
  const list = Array.isArray(events) ? events : [];
  const first = list.find(Boolean);
  if (!first) return 0;

  const rawRec = Number(first._recInFrames);
  const declaredBase = Number(first._seqBaseFrames);
  const absoluteRec = tcToFrames(first.recIn, fps);
  if (Number.isFinite(rawRec)) {
    // XMEML: absolute record TC = sequence base + relative record frame.
    if (Number.isFinite(declaredBase)
        && Math.abs(absoluteRec - (declaredBase + rawRec)) <= 2) {
      return 0;
    }
    // Parser already stored an absolute record frame; subtract the declared base.
    if (Number.isFinite(declaredBase) && Math.abs(absoluteRec - rawRec) <= 2) {
      return declaredBase;
    }
    // Unknown relative representation: preserve the actual sequence origin, not
    // the first visible cut, so a deliberate opening gap remains in the ref.
    if (Math.abs(rawRec) < Math.max(fps * 60 * 30, Math.abs(absoluteRec) * 0.5)) {
      return 0;
    }
  }
  if (Number.isFinite(declaredBase)) return declaredBase;
  const absoluteFrames = list.map(e => tcToFrames(e?.recIn, fps)).filter(Number.isFinite);
  return absoluteFrames.length ? Math.min(...absoluteFrames) : 0;
}
