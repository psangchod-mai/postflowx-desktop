/**
 * PostFlowX Annotate Security Add-on for Apps Script
 *
 * Add this file to your existing PostFlowX Apps Script backend project.
 * Then call `pfxHandleAnnotateRequest_(path, req)` from your current router.
 *
 * Goal:
 * - keep upstream tracking provider URLs and API keys out of the client
 * - store provider config in Google Sheets
 * - proxy Annotate re-acquire requests server-side
 *
 * Expected request paths:
 * - GET  ?path=annotateCatalog&token=...
 * - POST ?path=annotateTrack
 */

var PFX_ANNOTATE_DEFAULT_SHEET_ID = '1I92YHGwhteUxdO4ilUHM488c8HVnNMzyGEKMmyWvU-w';
var PFX_ANNOTATE_PROVIDER_SHEET = 'AnnotateProviders';
var PFX_ANNOTATE_SESSION_SHEET = 'Sessions';

function pfxHandleAnnotateRequest_(path, req) {
  switch (String(path || '')) {
    case 'annotateCatalog':
      return pfxAnnotateCatalog_(req || {});
    case 'annotateTrack':
      return pfxAnnotateTrack_(req || {});
    default:
      return null;
  }
}

function pfxAnnotateCatalog_(req) {
  var auth = pfxVerifyAnnotateAccess_(req);
  if (!auth.ok) return pfxJsonOut_(auth, auth.code || 403);

  var providers = pfxReadAnnotateProviders_()
    .filter(function (row) { return row.enabled; })
    .filter(function (row) { return pfxProviderAllowedForRole_(row, auth.role); })
    .map(function (row) {
      return {
        ok: true,
        id: row.id,
        label: row.label,
        source: 'protected',
        proxy: true,
        hints: row.hints,
      };
    });

  return pfxJsonOut_({ ok: true, providers: providers });
}

function pfxAnnotateTrack_(req) {
  var auth = pfxVerifyAnnotateAccess_(req);
  if (!auth.ok) return pfxJsonOut_(auth, auth.code || 403);

  var body = req.body || {};
  var providerId = String(body.providerId || '').trim();
  var payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  if (!providerId) return pfxJsonOut_({ ok: false, error: 'missing_provider_id' }, 400);
  if (!payload.imageDataUrl) return pfxJsonOut_({ ok: false, error: 'missing_image' }, 400);

  var provider = pfxFindAnnotateProvider_(providerId);
  if (!provider || !provider.enabled) {
    return pfxJsonOut_({ ok: false, error: 'provider_not_found' }, 404);
  }
  if (!pfxProviderAllowedForRole_(provider, auth.role)) {
    return pfxJsonOut_({ ok: false, error: 'provider_not_allowed' }, 403);
  }

  var headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    var hdr = provider.apiKeyHeader || 'Authorization';
    headers[hdr] = hdr.toLowerCase() === 'authorization' && !/^bearer\s/i.test(provider.apiKey)
      ? 'Bearer ' + provider.apiKey
      : provider.apiKey;
  }

  try {
    var response = UrlFetchApp.fetch(provider.endpoint, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: headers,
      muteHttpExceptions: true,
      followRedirects: true,
    });
    var status = response.getResponseCode();
    var text = response.getContentText() || '';
    var json = null;
    try { json = JSON.parse(text); } catch (err) {}
    if (status < 200 || status >= 300) {
      return pfxJsonOut_({
        ok: false,
        error: 'provider_request_failed',
        providerId: providerId,
        status: status,
      }, status);
    }
    if (json && typeof json === 'object') {
      if (typeof json.ok === 'undefined') json.ok = true;
      json.providerId = providerId;
      return pfxJsonOut_(json, 200);
    }
    return pfxJsonOut_({ ok: true, providerId: providerId, raw: text }, 200);
  } catch (err2) {
    return pfxJsonOut_({
      ok: false,
      error: 'provider_exception',
      providerId: providerId,
      message: String(err2 && err2.message || err2 || 'unknown_error'),
    }, 500);
  }
}

function pfxVerifyAnnotateAccess_(req) {
  var body = req.body || {};
  var token = String(req.token || body.token || '').trim();
  var requireToken = String(pfxGetScriptProp_('PFX_REQUIRE_ANNOTATE_TOKEN', 'false')).toLowerCase() === 'true';
  if (!requireToken) {
    return { ok: true, role: 'admin', email: '' };
  }
  if (!token) {
    return { ok: false, code: 401, error: 'missing_token' };
  }

  var session = pfxLookupSessionByToken_(token);
  if (!session) {
    return { ok: false, code: 403, error: 'invalid_token' };
  }
  if (session.status && String(session.status).toLowerCase() !== 'active') {
    return { ok: false, code: 403, error: 'inactive_session' };
  }
  if (session.expiresAt) {
    var exp = new Date(session.expiresAt).getTime();
    if (isFinite(exp) && exp > 0 && exp < Date.now()) {
      return { ok: false, code: 403, error: 'expired_session' };
    }
  }
  return {
    ok: true,
    role: session.role || 'viewer',
    email: session.email || '',
    session: session,
  };
}

function pfxLookupSessionByToken_(token) {
  var rows = pfxReadSheetRows_(PFX_ANNOTATE_SESSION_SHEET);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].token || '').trim() === token) return rows[i];
  }
  return null;
}

function pfxFindAnnotateProvider_(providerId) {
  var rows = pfxReadAnnotateProviders_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id || '').trim() === providerId) return rows[i];
  }
  return null;
}

function pfxReadAnnotateProviders_() {
  return pfxReadSheetRows_(PFX_ANNOTATE_PROVIDER_SHEET).map(function (row) {
    return {
      enabled: pfxToBool_(row.enabled),
      id: String(row.id || '').trim(),
      label: String(row.label || row.id || 'Protected Provider').trim(),
      endpoint: String(row.endpoint || row.url || '').trim(),
      apiKey: String(row.apiKey || '').trim(),
      apiKeyHeader: String(row.apiKeyHeader || 'Authorization').trim() || 'Authorization',
      allowedRoles: pfxCsv_(row.allowedRoles),
      hints: pfxCsv_(row.hints),
    };
  }).filter(function (row) {
    return row.id && row.endpoint;
  });
}

function pfxProviderAllowedForRole_(provider, role) {
  var allowed = provider.allowedRoles || [];
  if (!allowed.length || allowed.indexOf('*') >= 0) return true;
  return allowed.indexOf(String(role || '').trim()) >= 0;
}

function pfxReadSheetRows_(sheetName) {
  var sheet = pfxGetConfigSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) return [];
  var headers = values[0].map(function (v) { return String(v || '').trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var src = values[r];
    var row = {};
    for (var c = 0; c < headers.length; c++) row[headers[c]] = src[c];
    rows.push(row);
  }
  return rows;
}

function pfxGetConfigSpreadsheet_() {
  var id = pfxGetScriptProp_('PFX_CONFIG_SHEET_ID', PFX_ANNOTATE_DEFAULT_SHEET_ID);
  return SpreadsheetApp.openById(String(id || '').trim());
}

function pfxGetScriptProp_(key, fallback) {
  var val = PropertiesService.getScriptProperties().getProperty(key);
  return val == null || val === '' ? fallback : val;
}

function pfxCsv_(value) {
  return String(value || '')
    .split(',')
    .map(function (v) { return String(v || '').trim(); })
    .filter(function (v) { return !!v; });
}

function pfxToBool_(value) {
  var v = String(value == null ? '' : value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

function pfxJsonOut_(obj, status) {
  var output = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  if (typeof output.setHeader === 'function') {
    output.setHeader('Cache-Control', 'no-store, max-age=0');
    output.setHeader('X-PFX-Status', String(status || 200));
  }
  return output;
}
