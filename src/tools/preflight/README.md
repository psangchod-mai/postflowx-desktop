# Preflight Validator (Chrome Extension)

A Manifest V3 Chrome extension that helps teams pre-validate delivery assets with a simple non-tech UI:
IMF (Dolby Vision): Textless, nearfield stems/print masters, editorial, servicing ProRes, NAM archive, and VFX wrap assets.

## Install (Developer Mode)
1) Chrome → `chrome://extensions`
2) Enable **Developer mode**
3) Click **Load unpacked**
4) Select the folder: `preflight_validator_extension/`

## Use
- Click the toolbar icon → **Open Preflight Validator**
- Pick **Profile** (Final Delivery / Servicing / Music / VFX Wrap / Archive)
- Click **Select folder** (or files) → then **Run preflight**
- Open any asset card → **View / Fix** → confirm manual checks and tick checklists
- **Export report** opens an HTML report you can Print/Save as PDF.

## Notes / Limitations
- This build runs fully inside the browser for safety.
- Some deep metadata checks (codec/ProRes profile, VFR detection, DV XML parsing) appear as **manual confirm**.
- WAV checks (PCM + 48kHz + channels) and filesystem checks (checksum/path/illegal chars/zip) are automated.
