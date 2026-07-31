// scripts/auth/permissions.js — PostFlowX Permission Helpers
// Reads the resolved PostFlowX policy session populated by boot-guard.
// Canonical tab/action names come from AccessControl and are translated here
// to the live UI's current data-main values where needed.
// Exposed as window.PFX_PERMISSIONS

window.PFX_PERMISSIONS = (() => {
  'use strict';

  let _cached = null; // set by boot-guard after successful load

  // ── Tab ID mapping: canonical policy key → live data-main value ──────────
  const TAB_CANONICAL_TO_DATA_MAIN = {
    pull_prep:    'prepmark',
    cut_diff:     'cutdiff2',
    plate_link:   'platelink2',
    visual_qc:    'reviews',
    t_conform:    'trlconf',
    bwav:         'bwav',
    preflight:    'preflight',
    imf:          'imf',
    aces_look:    'aceslook',
    render_queue: 'renderq',
    settings:     'about',
    // Legacy aliases accepted for older rows/docs. External policy should use
    // canonical keys above and keep marker access action-based.
    markers:      'prepmark',
    review:       'reviews',
    trl_conf:     'trlconf',
  };

  // Reverse: data-main → canonical
  const DATA_MAIN_TO_CANONICAL = {};
  for (const [k, v] of Object.entries(TAB_CANONICAL_TO_DATA_MAIN)) {
    if (!DATA_MAIN_TO_CANONICAL[v]) DATA_MAIN_TO_CANONICAL[v] = k;
  }

  function _perms() {
    return _cached?.permissions || null;
  }

  /**
   * Check if user can access a tab.
   * Accepts either canonical IDs (pull_prep) or data-main values (prepmark).
   */
  function canAccessTab(tabId) {
    // render_queue and settings are always accessible regardless of role
    if (_UNGATED_TABS.has(tabId)) return true;
    const canonical = DATA_MAIN_TO_CANONICAL[tabId];
    if (canonical && _UNGATED_TABS.has(canonical)) return true;
    const p = _perms();
    if (!p) return true; // no permission layer → allow all
    const tabs = p.tabs || [];
    if (tabs.includes('*')) return true;
    // Try direct match first, then canonical → data-main mapping
    if (tabs.includes(tabId)) return true;
    if (canonical && tabs.includes(canonical)) return true;
    const dataMain = TAB_CANONICAL_TO_DATA_MAIN[tabId]; // canonical → data-main
    if (dataMain && tabs.includes(dataMain)) return true;
    return false;
  }

  /** Check if user can perform an action. */
  function canDoAction(actionId) {
    const p = _perms();
    if (!p) return true;
    const actions = p.actions || [];
    return actions.includes('*') || actions.includes(actionId);
  }

  /**
   * Returns true if the user has view-only access
   * (can view but cannot perform any mutating actions).
   */
  function isReadOnly() {
    const p = _perms();
    if (!p) return false;
    const actions = p.actions || [];
    if (actions.includes('*')) return false;
    const mutating = [
      'save_project', 'load_timeline', 'load_video',
      'add_marker', 'edit_marker_meta', 'delete_marker',
      'open_annotation', 'edit_annotation',
      'export_csv', 'export_pdf', 'export_xlsx', 'export_package',
      'relink_all',
      'open_aces_look', 'save_aces_preset', 'load_aces_preset',
      'export_amf', 'export_clf', 'export_cdl', 'export_color_summary',
      // Legacy action keys retained so older stored sessions still behave.
      'edit_cut', 'export', 'import_media', 'import_timeline',
      'annotate', 'comment', 'relink_media',
    ];
    return !mutating.some(a => actions.includes(a));
  }

  function getRole()    { return _cached?.role    || null; }
  function getUser()    { return _cached?.user    || null; }
  function getSession() { return _cached          || null; }

  /** List all allowed data-main tab IDs for the current session. */
  function getAllowedDataMainTabs() {
    const p = _perms();
    if (!p) return null; // null = no restrictions
    const tabs = p.tabs || [];
    if (tabs.includes('*')) return null; // null = all allowed
    const result = new Set();
    for (const t of tabs) {
      // t might be canonical or data-main
      const dm = TAB_CANONICAL_TO_DATA_MAIN[t] || t;
      result.add(dm);
    }
    // render_queue and settings are always visible regardless of role
    for (const canonical of _UNGATED_TABS) {
      const dm = TAB_CANONICAL_TO_DATA_MAIN[canonical] || canonical;
      result.add(dm);
    }
    return result;
  }

  /**
   * Run fn() if the user has the given action permission.
   * onDenied is called (optionally) if permission is missing.
   * Also fires a logEvent so the backend can record the attempt.
   */
  function requireAction(actionId, fn, onDenied) {
    if (canDoAction(actionId)) {
      fn();
    } else {
      window.pfxPolicyApi?.logEvent({
        event:     'access_denied',
        action:    actionId,
        user:      getUser()?.email || 'unknown',
        timestamp: new Date().toISOString(),
      });
      if (typeof onDenied === 'function') onDenied(actionId);
    }
  }

  /** Check if a feature flag is active in the current session policy. */
  function hasFeatureFlag(flagKey) {
    // featureFlags lives at the session TOP LEVEL (set by boot-guard / auth.js /
    // ipc.js), not nested under permissions.
    const flags = _cached?.featureFlags || {};
    return !!flags[flagKey];
  }

  // Tabs always open to all users — never gate these.
  const _UNGATED_TABS = new Set(['render_queue', 'settings']);

  /**
   * Switch to a tab by canonical key, checking permission first.
   * Returns true if the switch was allowed, false if denied.
   */
  function openTab(tabKey) {
    const dataMain = TAB_CANONICAL_TO_DATA_MAIN[tabKey] || tabKey;
    if (!_UNGATED_TABS.has(tabKey) && !canAccessTab(tabKey)) {
      // The toast names things by `data-main`, not by canonical tab key. Passing
      // tabKey put the schema's own word in front of the user — "Your account
      // cannot do this: plate_link" — for the one refusal that has a perfectly
      // good name available. Translate to the key the name table is keyed by.
      window.pfxNoAccessView?.showDeniedToast(dataMain);
      return false;
    }
    const btn = document.querySelector(`[data-main="${dataMain}"]`);
    if (btn) btn.click();
    return true;
  }

  /** Called by boot-guard once auth resolves successfully. */
  function setSession(sess) {
    _cached = sess;
    window.dispatchEvent(new CustomEvent('pfx:permissions-ready', { detail: sess }));
  }

  return {
    canAccessTab,
    openTab,
    canDoAction,
    requireAction,
    hasFeatureFlag,
    isReadOnly,
    getRole,
    getUser,
    getSession,
    getAllowedDataMainTabs,
    setSession,
    TAB_CANONICAL_TO_DATA_MAIN,
    DATA_MAIN_TO_CANONICAL,
  };
})();
