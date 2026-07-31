// scripts/core/noticeGlobals.js
// The one place the classic-script auth layer can reach the translated wording.
//
// src/index.html loads auth/guarded-action.js, auth/read-only.js,
// auth/project-lease.js and auth/media-coordinator.js as plain
// `<script src=…>` — no type="module" — so they cannot import anything, which
// is the structural reason every refusal string in them was an English literal
// written in place. Converting four files that other classic scripts read at
// load time is a bigger change than the wording is worth, so the wording comes
// to them instead: this module imports the pure notice builders and hangs them
// on window, the same shape auth/noAccessView.js already publishes as
// window.pfxNoAccessView.
//
// Nothing here decides anything — accessNotice.js does. This file exists only
// so that "which words" and "which module system" stop being the same question.

import { guardNotice, readOnlyNotice, actionName } from './accessNotice.js';

window.PFX_NOTICE = { guardNotice, readOnlyNotice, actionName };
