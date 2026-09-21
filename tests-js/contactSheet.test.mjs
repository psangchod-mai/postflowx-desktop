// Printable QC contact-sheet report. Run: node tests-js/contactSheet.test.mjs
import { buildContactSheetHtml } from '../src/scripts/features/vfxPull/vfxPullQcReport.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const shots = [
  {
    shotName: 'SHOT_010', plateName: 'SHOT_010_BG01_v001', status: 'SAFE',
    confidence: 96, visualMatch: 92, colorConf: 84, drift: 0, driftApplied: false,
    idt: 'ARRI LogC4', reframe: '3840×2160 fill', retime: 'Normal',
    tcIn: '07:20:01:07', tcOut: '07:21:22:07', frameCount: 1944,
    risk: { level: 'ok', health: 94, reasons: [] },
    heroFrames: {
      qt:  [{ pos: 'In', dataUrl: 'data:image/jpeg;base64,QQ==' }],
      ocf: [{ pos: 'In', dataUrl: 'data:image/jpeg;base64,WW==' }],
    },
  },
  {
    shotName: 'SHOT_020', plateName: 'SHOT_020_BG01_v001', status: 'REVIEW',
    confidence: 62, visualMatch: 48, colorConf: 55, drift: 6, driftApplied: false,
    idt: 'RED Log3G10', reframe: 'Editorial', retime: 'Dynamic ramp',
    risk: { level: 'review', health: 51, reasons: ['Visual match 48%', 'Frame drift +6f (not applied)'] },
    heroFrames: { qt: [], ocf: [] },
  },
  {
    shotName: 'SHOT_030', plateName: 'SHOT_030_BG01_v001', status: 'MISSING',
    confidence: 0, risk: { level: 'blocked', health: 0, reasons: ['No OCF linked'] },
  },
];
const meta = { show: 'THE SHOW', episode: 'S01E03', timelineName: 'TL1', appVersion: '3.0', generatedAt: '2026-06-22' };

const html = buildContactSheetHtml(shots, meta);

ok(html.startsWith('<!DOCTYPE html>'), 'returns a full HTML document');
ok(html.includes('QC SUMMARY — 3 shots · 1 ready · 1 review · 1 blocked'), 'summary counts shots by verdict');
ok((html.match(/class="cs-shot"/g) || []).length === 3, 'one card per shot');
ok(html.includes('data:image/jpeg;base64,QQ==') && html.includes('data:image/jpeg;base64,WW=='), 'embeds hero-frame images');
ok((html.match(/class="ph"/g) || []).length > 0, 'missing hero frames render placeholders');
ok(/cs-verdict ok">Ready/.test(html), 'ready verdict badge');
ok(/cs-verdict review">Review/.test(html), 'review verdict badge');
ok(/cs-verdict blocked">Blocked/.test(html), 'blocked verdict badge');
ok(html.includes('ARRI LogC4') && html.includes('RED Log3G10'), 'IDT shown per shot');
ok(/\+6f \(not applied\)/.test(html), 'unapplied drift flagged');
ok(html.includes('Visual match 48%'), 'risk reasons rendered');
ok(/Reviewed by/.test(html) && /Operator/.test(html), 'sign-off lines present (per-shot + overall)');
ok(html.includes('THE SHOW') && html.includes('S01E03'), 'show/episode in header');

// Empty input is graceful.
{
  const empty = buildContactSheetHtml([], meta);
  ok(empty.includes('0 shots · 0 ready'), 'empty shot list → 0 summary, no throw');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
