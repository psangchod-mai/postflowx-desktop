# PostFlowX Apps Script Protection

This package moves sensitive Annotate provider logic out of the extension and into Google Apps Script.

What it protects:

- upstream tracking provider URLs
- provider API keys
- role-gated provider access
- provider catalog changes without shipping a new build

What stays local:

- video playback
- LK / RAFT / particle / NanoTrack tracking
- all heavy frame-by-frame image processing

## Files

- [AnnotateSecurity.gs](/Users/psangchod/Documents/PostFlowX_2.5/PostFlowX/apps-script/annotate-security/AnnotateSecurity.gs)

## How to wire it

1. Open your existing PostFlowX Apps Script backend project.
2. Add `AnnotateSecurity.gs` as a new script file.
3. In your current router, forward these routes into `pfxHandleAnnotateRequest_(path, req)`.
4. Redeploy the web app.

Example router hook:

```javascript
function doGet(e) {
  var path = String((e && e.parameter && e.parameter.path) || '');
  var addon = pfxHandleAnnotateRequest_(path, {
    token: e && e.parameter ? e.parameter.token : '',
    params: e && e.parameter ? e.parameter : {},
  });
  if (addon) return addon;
  return existingDoGetRouter_(e);
}

function doPost(e) {
  var path = String((e && e.parameter && e.parameter.path) || '');
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  var addon = pfxHandleAnnotateRequest_(path, {
    token: body.token || '',
    params: e && e.parameter ? e.parameter : {},
    body: body,
  });
  if (addon) return addon;
  return existingDoPostRouter_(e);
}
```

## Spreadsheet setup

Use your sheet:

- [Access / Config Sheet](https://docs.google.com/spreadsheets/d/1I92YHGwhteUxdO4ilUHM488c8HVnNMzyGEKMmyWvU-w/edit?gid=397324616#gid=397324616)

Create a tab named `AnnotateProviders` with these headers in row 1:

```text
enabled | id | label | endpoint | apiKey | apiKeyHeader | allowedRoles | hints
```

Example rows:

```text
true | primary-track | Primary Track Proxy | https://your-upstream.example.com/track | sk-live-123 | Authorization | admin,editor | faces,text
true | screen-track | Screen Track Proxy | https://your-upstream.example.com/screen-track | sk-live-456 | Authorization | admin,editor | screens
```

Optional session validation tab:

Create a tab named `Sessions` with:

```text
token | email | role | status | expiresAt
```

If you turn on required token validation, the route will check this sheet.

## Script properties

Set these in Apps Script `Project Settings -> Script properties`:

- `PFX_CONFIG_SHEET_ID` = `1I92YHGwhteUxdO4ilUHM488c8HVnNMzyGEKMmyWvU-w`
- `PFX_REQUIRE_ANNOTATE_TOKEN` = `true` or `false`

Recommendation:

- start with `false` while wiring
- switch to `true` after your session token flow is connected

## Client changes already wired

The extension now:

- asks `window.pfxPolicyApi.annotateCatalog(...)` for protected providers
- treats those providers as proxy-only
- sends tracking reacquire requests through `window.pfxPolicyApi.annotateTrackProxy(...)`

That means the extension no longer needs to ship the real provider URLs or API keys for those protected sources.

## Important limitation

This improves protection, but it does not make the whole tool uncopyable.

It protects:

- secrets
- server-side business rules
- remote provider switching

It does not protect:

- local UI code
- local tracking algorithms shipped in the extension
- requests that an authorized user can still trigger legitimately

For the strongest setup, keep sensitive decisions and entitlements server-side and keep only performance-critical image processing in the client.
