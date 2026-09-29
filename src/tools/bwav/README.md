# BWAV Inspector (Chrome Extension)

Inspect supported Atmos assets locally and validate ADM `audioContent` group labels against the bundled label registry.

## Install (Developer Mode)
1. Unzip the package.
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped `bwav-inspector/` folder.

## Privacy and scope
- Source media/audio and extracted XML are parsed locally and are not uploaded by this label-validation workflow. The inspector validates only extracted ADM content-group label names.
- This result is not loudness, channel-layout, silence, or delivery QC.
- The installed label registry is the source used for this check. If it is unavailable, validation fails explicitly; no live registry URL is implied.
- Operational telemetry and label-sync are enabled by default and may send the configured client ID, user agent, and profile email to the configured service. Rejected zero-byte telemetry is generic and does not include the selected filename. They are not required for local source-media parsing.

## Supported asset extensions
`.mxf`, `.wav`, `.wave`, `.rf64`, `.bw64`, `.pio`, and `.atmosir`.

`.pio` and `.atmosir` files are inspected locally only when they expose a bounded, recognizable ADM `audioContent` structure in XML, JSON, or the existing simple YAML structure. Unsupported binary or unrecognized structures report a local parsing limitation; no proprietary binary decoding is inferred.

## Included label source
- `data/atmosLabelConfiguration.json`
- `data/netflix_recognized_group_labels.json`

## Notes
- This is an MVP focused on local metadata inspection.
- AXML might be located late in very large files; the inspector scans progressively and shows a bounded local XML preview when found.


## Full-page UI
Click the BWAV Inspector toolbar icon to open the inspector in a new tab (`app.html`).
