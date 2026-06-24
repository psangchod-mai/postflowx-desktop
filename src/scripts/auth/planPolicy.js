// auth/planPolicy.js — pure plan → {tabs, actions} policy. Single source of
// truth for which tabs/actions each plan grants. Loaded as a CLASSIC script
// (the auth layer isn't ESM), so it publishes onto globalThis rather than using
// `export`. Node tests `import` it for side effect and read globalThis.
// NOT a new auth system — the existing policy, extracted + testable.
;(function (g) {
  'use strict';

  const TABS_BY_PLAN = {
    free:       ['pull_prep', 'cut_diff'],
    pro:        ['pull_prep', 'cut_diff', 'visual_qc', 'aces_look'],
    enterprise: ['*'],
  };

  const ACTIONS_BY_PLAN = {
    free:       ['open_project', 'view_markers'],
    pro:        [
      'open_project', 'save_project',
      'load_timeline', 'load_video',
      'view_markers', 'add_marker', 'edit_marker_meta', 'delete_marker',
      'open_annotation', 'edit_annotation',
      'export_csv', 'export_pdf', 'export_xlsx', 'export_package',
      'relink_all',
      'open_aces_look', 'save_aces_preset', 'load_aces_preset',
      'export_amf', 'export_clf', 'export_cdl', 'export_color_summary',
      // Smart Pro color additions:
      'export_fdl_asc', 'import_amf',
    ],
    enterprise: ['*'],
  };

  function tabsForPlan(plan) { return TABS_BY_PLAN[plan] || ['pull_prep']; }
  function actionsForPlan(plan) { return ACTIONS_BY_PLAN[plan] || ['view']; }
  function canPlanDoAction(plan, action) {
    const list = actionsForPlan(plan);
    return list.includes('*') || list.includes(action);
  }

  g.PFX_PLAN_POLICY = { TABS_BY_PLAN, ACTIONS_BY_PLAN, tabsForPlan, actionsForPlan, canPlanDoAction };
})(typeof globalThis !== 'undefined' ? globalThis : this);
