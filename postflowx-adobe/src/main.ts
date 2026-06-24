// UXP plugin entry point.
// Panel lifecycle is managed by the UXP runtime via manifest.json entrypoints.
// Command handlers for utility entrypoints are registered here.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const uxp: any;

try {
  const entrypoints = uxp?.entrypoints;
  if (entrypoints) {
    entrypoints.setup({
      commands: {
        'postflowx.syncNow': {
          run() {
            // The panel's coordinator handles sync — broadcast a custom event
            // that the panel can listen to if it is open.
            window.dispatchEvent(new CustomEvent('pfx:syncNow'));
          },
        },
        'postflowx.setBaseline': {
          run() {
            window.dispatchEvent(new CustomEvent('pfx:setBaseline'));
          },
        },
      },
    });
  }
} catch {
  // entrypoints API unavailable — panel still works standalone
}
