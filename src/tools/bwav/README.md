# BWAV Inspector (Chrome Extension)

Inspect BWAV/BW64/RF64 files that embed ADM (AXML/CHNA) and validate bed/object group labels.

## Install (Developer Mode)
1. Unzip the package.
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped `bwav-inspector/` folder.

## Zero-setup (shared rollout)
This build is preconfigured to send user logs and label-sync requests to a shared Google Sheets Web App.
Most users can install and start using the tool immediately.

## Included rule sets
- `data/netflix_recognized_group_labels.json`
- `data/netflix_adm_deliverable_profiles.json`

## Notes
- This is an MVP focused on metadata-only checks.
- AXML might be located late in very large files; in that case, extract `axml.xml` offline and validate (planned improvement).


## Full-page UI
Click the BWAV Inspector toolbar icon to open the inspector in a new tab (`app.html`).
