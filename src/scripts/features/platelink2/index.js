/**
 * PLATE LINK 2.0 — VFX Folder Scanner & Delivery Verifier
 * PostFlowX — scripts/features/platelink2/index.js
 *
 * Layout:
 *  Left  — text-only VFX shot list (group / shot name / status dot)
 *  Right — QuickTime preview (top, full width) + shot detail info (below)
 *
 * Uses AMF module for scanning and export; renders its own left-panel list.
 */

// ── Plate Link 2.0 — i18n strings ─────────────────────────────────────────
const _PL2_STRINGS = {
  eng: {
    scanBtn:'📁 Import VFX Folder', ctxNoFolder:'No folder',
    ctxShots:'{n} shots', ctxReady:'{n} ready', ctxMissing:'{n} missing',
    filterAll:'All', filterReady:'✓ Ready', filterNoSeq:'No Seq', filterNoEdl:'No EDL', filterNoLook:'No Look',
    aeBtn:'AE Script', nukeBtn:'Nuke .nk', shotsListBtn:'VFX Shots List ▾', exportBtn:'More ▾',
    menuXlsx:'📊 Excel (.xlsx)', menuPdf:'📎 PDF', menuCsv:'📄 CSV',
    menuJson:'🔗 Mapping JSON', menuNukePy:'▏ Nuke .py',
    searchPlaceholder:'Search shot name…',
    slEmptyTitle:'No shots yet', slEmptyHint:'Scan your VFX delivery folder to list its shots here.',
    qtHint:'Select a shot on the left to preview its QuickTime reference.', qtNoRef:'No QuickTime reference found',
    qtReimport:'Re-import folder to enable preview', inspEmpty:'Select a shot to see its details.',
    relinkBtn:'Re-link video previews', relinkBusy:'Linking…',
    toastNoScan:'Scan a VFX folder first.', toastNoAmf:'AMF module not loaded.',
    progressScanning:'Scanning…', toastScanFail:'Scan failed: ',
    toastScanned:'Scanned {n} shots.', toastCopied:'Copied path!',
    selNone:'{n} shots', selSelected:'{n} / {m} selected', selFiltered:'{n} / {m} shots',
    progressStarting:'Starting…', progressExporting:'Exporting…',
    progressDone:'Done', progressError:'Export error', progressFail:'Export failed',
    inspSeqTitle:'SEQUENCE', inspEdlTitle:'EDL EVENTS',
    inspCamTitle:'CAMERA · LENS', inspLookTitle:'LOOK · CDL',
    inspNoEdl:'No EDL events', inspNoExr:'No EXR metadata',
    inspPattern:'Pattern', inspRange:'Range', inspFrames:'Frames',
    inspExt:'Ext', inspRes:'Res', inspCs:'CS', inspVerify:'Verify',
    inspEdlTot:'EDL tot', inspCamera:'Camera', inspLens:'Lens',
    inspFocal:'Focal', inspTstop:'T-Stop', inspFocus:'Focus',
    inspFile:'File', inspType:'Type',
    fvMatch:'✓ match', fvHdl:'+{n} fr (hdl)', fvShort:'{n} fr SHORT',
    evtLabel:'EVT {n}',
    codecErr:'Unsupported codec — export as H.264 MP4 for preview',
  },
  th: {
    scanBtn:'📁 นำเข้าโฟลเดอร์ VFX', ctxNoFolder:'ยังไม่ได้เลือกโฟลเดอร์',
    ctxShots:'{n} ช็อต', ctxReady:'{n} พร้อม', ctxMissing:'{n} ขาด',
    filterAll:'ทั้งหมด', filterReady:'✓ พร้อม', filterNoSeq:'ไม่มี Seq', filterNoEdl:'ไม่มี EDL', filterNoLook:'ไม่มี Look',
    aeBtn:'AE Script', nukeBtn:'Nuke .nk', shotsListBtn:'รายการ VFX ▾', exportBtn:'เพิ่มเติม ▾',
    menuXlsx:'📊 Excel (.xlsx)', menuPdf:'📎 PDF', menuCsv:'📄 CSV',
    menuJson:'🔗 Mapping JSON', menuNukePy:'▏ Nuke .py',
    searchPlaceholder:'ค้นหาชื่อช็อต…',
    slEmptyTitle:'ยังไม่มีช็อต', slEmptyHint:'สแกนโฟลเดอร์ VFX เพื่อดูรายการช็อต',
    qtHint:'เลือกช็อตเพื่อดูตัวอย่าง', qtNoRef:'ไม่พบไฟล์ QuickTime อ้างอิง',
    qtReimport:'นำเข้าโฟลเดอร์ใหม่เพื่อเปิดตัวอย่าง', inspEmpty:'เลือกช็อต',
    relinkBtn:'เชื่อมต่อวิดีโอตัวอย่างใหม่', relinkBusy:'กำลังเชื่อมต่อ…',
    toastNoScan:'สแกนโฟลเดอร์ VFX ก่อน', toastNoAmf:'ไม่ได้โหลดโมดูล AMF',
    progressScanning:'กำลังสแกน…', toastScanFail:'สแกนล้มเหลว: ',
    toastScanned:'สแกน {n} ช็อตแล้ว', toastCopied:'คัดลอกพาธแล้ว!',
    selNone:'{n} ช็อต', selSelected:'เลือก {n} / {m}', selFiltered:'{n} / {m} ช็อต',
    progressStarting:'กำลังเริ่ม…', progressExporting:'กำลังส่งออก…',
    progressDone:'เสร็จสิ้น', progressError:'ส่งออกผิดพลาด', progressFail:'ส่งออกล้มเหลว',
    inspSeqTitle:'ซีเควนซ์', inspEdlTitle:'EDL EVENTS',
    inspCamTitle:'กล้อง · เลนส์', inspLookTitle:'LOOK · CDL',
    inspNoEdl:'ไม่มีอีเวนต์ EDL', inspNoExr:'ไม่มีเมตาดาต้า EXR',
    inspPattern:'รูปแบบ', inspRange:'ช่วง', inspFrames:'เฟรม',
    inspExt:'นามสกุล', inspRes:'ความละเอียด', inspCs:'Color Space', inspVerify:'ตรวจสอบ',
    inspEdlTot:'EDL รวม', inspCamera:'กล้อง', inspLens:'เลนส์',
    inspFocal:'ทางยาวโฟกัส', inspTstop:'T-Stop', inspFocus:'โฟกัส',
    inspFile:'ไฟล์', inspType:'ประเภท',
    fvMatch:'✓ ตรงกัน', fvHdl:'+{n} fr (hdl)', fvShort:'{n} fr ขาด',
    evtLabel:'EVT {n}',
    codecErr:'ไม่รองรับ codec — ให้ export เป็น H.264 MP4 ก่อน',
  },
  id: {
    scanBtn:'📁 Impor Folder VFX', ctxNoFolder:'Belum ada folder',
    ctxShots:'{n} shot', ctxReady:'{n} siap', ctxMissing:'{n} hilang',
    filterAll:'Semua', filterReady:'✓ Siap', filterNoSeq:'No Seq', filterNoEdl:'No EDL', filterNoLook:'No Look',
    aeBtn:'AE Script', nukeBtn:'Nuke .nk', shotsListBtn:'Daftar Shot VFX ▾', exportBtn:'Lainnya ▾',
    menuXlsx:'📊 Excel (.xlsx)', menuPdf:'📎 PDF', menuCsv:'📄 CSV',
    menuJson:'🔗 Mapping JSON', menuNukePy:'▏ Nuke .py',
    searchPlaceholder:'Cari nama shot…',
    slEmptyTitle:'Belum ada shot', slEmptyHint:'Pindai folder VFX untuk melihat daftar shot.',
    qtHint:'Pilih shot untuk pratinjau', qtNoRef:'Referensi QuickTime tidak ditemukan',
    qtReimport:'Impor ulang folder untuk mengaktifkan pratinjau', inspEmpty:'Pilih shot',
    relinkBtn:'Tautkan ulang pratinjau video', relinkBusy:'Menautkan…',
    toastNoScan:'Pindai folder VFX terlebih dahulu.', toastNoAmf:'Modul AMF belum dimuat.',
    progressScanning:'Memindai…', toastScanFail:'Pemindaian gagal: ',
    toastScanned:'{n} shot berhasil dipindai.', toastCopied:'Path disalin!',
    selNone:'{n} shot', selSelected:'{n} / {m} dipilih', selFiltered:'{n} / {m} shot',
    progressStarting:'Memulai…', progressExporting:'Mengekspor…',
    progressDone:'Selesai', progressError:'Kesalahan ekspor', progressFail:'Ekspor gagal',
    inspSeqTitle:'SEKUENS', inspEdlTitle:'EDL EVENTS',
    inspCamTitle:'KAMERA · LENSA', inspLookTitle:'LOOK · CDL',
    inspNoEdl:'Tidak ada event EDL', inspNoExr:'Tidak ada metadata EXR',
    inspPattern:'Pola', inspRange:'Rentang', inspFrames:'Frame',
    inspExt:'Ekstensi', inspRes:'Resolusi', inspCs:'Color Space', inspVerify:'Verifikasi',
    inspEdlTot:'Total EDL', inspCamera:'Kamera', inspLens:'Lensa',
    inspFocal:'Focal', inspTstop:'T-Stop', inspFocus:'Fokus',
    inspFile:'File', inspType:'Tipe',
    fvMatch:'✓ cocok', fvHdl:'+{n} fr (hdl)', fvShort:'{n} fr KURANG',
    evtLabel:'EVT {n}',
    codecErr:'Codec tidak didukung — ekspor sebagai H.264 MP4 untuk pratinjau',
  },
  ph: {
    scanBtn:'📁 I-import ang VFX Folder', ctxNoFolder:'Walang folder',
    ctxShots:'{n} shot', ctxReady:'{n} handa', ctxMissing:'{n} nawawala',
    filterAll:'Lahat', filterReady:'✓ Handa', filterNoSeq:'Walang Seq', filterNoEdl:'Walang EDL', filterNoLook:'Walang Look',
    aeBtn:'AE Script', nukeBtn:'Nuke .nk', shotsListBtn:'Listahan ng VFX Shot ▾', exportBtn:'Iba pa ▾',
    menuXlsx:'📊 Excel (.xlsx)', menuPdf:'📎 PDF', menuCsv:'📄 CSV',
    menuJson:'🔗 Mapping JSON', menuNukePy:'▏ Nuke .py',
    searchPlaceholder:'Maghanap ng pangalan ng shot…',
    slEmptyTitle:'Walang shot', slEmptyHint:'I-scan ang VFX folder para makita ang listahan ng shot.',
    qtHint:'Pumili ng shot para sa preview', qtNoRef:'Walang nahanap na QuickTime reference',
    qtReimport:'I-re-import ang folder para ma-enable ang preview', inspEmpty:'Pumili ng shot',
    relinkBtn:'I-relink ang mga video preview', relinkBusy:'Nag-lilink…',
    toastNoScan:'Mag-scan ng VFX folder muna.', toastNoAmf:'Hindi na-load ang AMF module.',
    progressScanning:'Nag-ssa-scan…', toastScanFail:'Nabigo ang pag-scan: ',
    toastScanned:'Na-scan ang {n} na shot.', toastCopied:'Nakopya ang path!',
    selNone:'{n} shot', selSelected:'{n} / {m} napili', selFiltered:'{n} / {m} shot',
    progressStarting:'Nagsisimula…', progressExporting:'Nag-e-export…',
    progressDone:'Tapos na', progressError:'Error sa pag-export', progressFail:'Nabigo ang pag-export',
    inspSeqTitle:'SEQUENCE', inspEdlTitle:'EDL EVENTS',
    inspCamTitle:'CAMERA · LENS', inspLookTitle:'LOOK · CDL',
    inspNoEdl:'Walang EDL event', inspNoExr:'Walang EXR metadata',
    inspPattern:'Pattern', inspRange:'Saklaw', inspFrames:'Frame',
    inspExt:'Extension', inspRes:'Resolution', inspCs:'Color Space', inspVerify:'I-verify',
    inspEdlTot:'Kabuuang EDL', inspCamera:'Camera', inspLens:'Lens',
    inspFocal:'Focal', inspTstop:'T-Stop', inspFocus:'Focus',
    inspFile:'File', inspType:'Uri',
    fvMatch:'✓ tugma', fvHdl:'+{n} fr (hdl)', fvShort:'{n} fr KULANG',
    evtLabel:'EVT {n}',
    codecErr:'Hindi sinusuportahang codec — i-export bilang H.264 MP4 para sa preview',
  },
  tw: {
    scanBtn:'📁 匯入 VFX 資料夾', ctxNoFolder:'尚未選擇資料夾',
    ctxShots:'{n} 個鏡頭', ctxReady:'{n} 已就緒', ctxMissing:'{n} 缺失',
    filterAll:'全部', filterReady:'✓ 已就緒', filterNoSeq:'缺 Seq', filterNoEdl:'缺 EDL', filterNoLook:'缺 Look',
    aeBtn:'AE 腳本', nukeBtn:'Nuke .nk', shotsListBtn:'VFX 鏡頭清單 ▾', exportBtn:'更多 ▾',
    menuXlsx:'📊 Excel (.xlsx)', menuPdf:'📎 PDF', menuCsv:'📄 CSV',
    menuJson:'🔗 Mapping JSON', menuNukePy:'▏ Nuke .py',
    searchPlaceholder:'搜尋鏡頭名稱…',
    slEmptyTitle:'尚無鏡頭', slEmptyHint:'掃描 VFX 資料夾以查看鏡頭清單。',
    qtHint:'選取鏡頭以預覽', qtNoRef:'找不到 QuickTime 參考檔案',
    qtReimport:'重新匯入資料夾以啟用預覽', inspEmpty:'請選取鏡頭',
    relinkBtn:'重新連結影片預覽', relinkBusy:'連結中…',
    toastNoScan:'請先掃描 VFX 資料夾。', toastNoAmf:'AMF 模組未載入。',
    progressScanning:'掃描中…', toastScanFail:'掃描失敗：',
    toastScanned:'已掃描 {n} 個鏡頭。', toastCopied:'已複製路徑！',
    selNone:'{n} 個鏡頭', selSelected:'已選 {n} / {m}', selFiltered:'{n} / {m} 個鏡頭',
    progressStarting:'啟動中…', progressExporting:'匯出中…',
    progressDone:'完成', progressError:'匯出錯誤', progressFail:'匯出失敗',
    inspSeqTitle:'序列', inspEdlTitle:'EDL 事件',
    inspCamTitle:'攝影機 · 鏡頭', inspLookTitle:'LOOK · CDL',
    inspNoEdl:'無 EDL 事件', inspNoExr:'無 EXR 元資料',
    inspPattern:'樣式', inspRange:'範圍', inspFrames:'幀數',
    inspExt:'副檔名', inspRes:'解析度', inspCs:'色彩空間', inspVerify:'驗證',
    inspEdlTot:'EDL 總計', inspCamera:'攝影機', inspLens:'鏡頭',
    inspFocal:'焦距', inspTstop:'T-Stop', inspFocus:'對焦',
    inspFile:'檔案', inspType:'類型',
    fvMatch:'✓ 相符', fvHdl:'+{n} fr (hdl)', fvShort:'{n} fr 不足',
    evtLabel:'EVT {n}',
    codecErr:'不支援此編碼器 — 請先匯出為 H.264 MP4',
  },
  kr: {
    scanBtn:'📁 VFX 폴더 가져오기', ctxNoFolder:'폴더 없음',
    ctxShots:'{n}개 샷', ctxReady:'{n}개 준비됨', ctxMissing:'{n}개 없음',
    filterAll:'전체', filterReady:'✓ 준비됨', filterNoSeq:'Seq 없음', filterNoEdl:'EDL 없음', filterNoLook:'Look 없음',
    aeBtn:'AE 스크립트', nukeBtn:'Nuke .nk', shotsListBtn:'VFX 샷 목록 ▾', exportBtn:'더보기 ▾',
    menuXlsx:'📊 Excel (.xlsx)', menuPdf:'📎 PDF', menuCsv:'📄 CSV',
    menuJson:'🔗 Mapping JSON', menuNukePy:'▏ Nuke .py',
    searchPlaceholder:'샷 이름 검색…',
    slEmptyTitle:'샷 없음', slEmptyHint:'VFX 폴더를 스캔하여 샷 목록을 확인하세요.',
    qtHint:'샷을 선택하여 미리보기', qtNoRef:'QuickTime 참조 파일을 찾을 수 없음',
    qtReimport:'미리보기를 활성화하려면 폴더를 다시 가져오세요', inspEmpty:'샷을 선택하세요',
    relinkBtn:'비디오 미리보기 재연결', relinkBusy:'연결 중…',
    toastNoScan:'VFX 폴더를 먼저 스캔하세요.', toastNoAmf:'AMF 모듈이 로드되지 않았습니다.',
    progressScanning:'스캔 중…', toastScanFail:'스캔 실패: ',
    toastScanned:'{n}개 샷 스캔 완료.', toastCopied:'경로가 복사되었습니다!',
    selNone:'{n}개 샷', selSelected:'{n} / {m}개 선택됨', selFiltered:'{n} / {m}개 샷',
    progressStarting:'시작 중…', progressExporting:'내보내는 중…',
    progressDone:'완료', progressError:'내보내기 오류', progressFail:'내보내기 실패',
    inspSeqTitle:'시퀀스', inspEdlTitle:'EDL 이벤트',
    inspCamTitle:'카메라 · 렌즈', inspLookTitle:'LOOK · CDL',
    inspNoEdl:'EDL 이벤트 없음', inspNoExr:'EXR 메타데이터 없음',
    inspPattern:'패턴', inspRange:'범위', inspFrames:'프레임',
    inspExt:'확장자', inspRes:'해상도', inspCs:'색공간', inspVerify:'확인',
    inspEdlTot:'EDL 합계', inspCamera:'카메라', inspLens:'렌즈',
    inspFocal:'초점 거리', inspTstop:'T-Stop', inspFocus:'초점',
    inspFile:'파일', inspType:'유형',
    fvMatch:'✓ 일치', fvHdl:'+{n} fr (hdl)', fvShort:'{n} fr 부족',
    evtLabel:'EVT {n}',
    codecErr:'지원하지 않는 코덱 — H.264 MP4로 내보내어 미리보기 하세요',
  },
  jp: {
    scanBtn:'📁 VFXフォルダーを読み込む', ctxNoFolder:'フォルダー未選択',
    ctxShots:'{n}カット', ctxReady:'{n}件 準備完了', ctxMissing:'{n}件 欠落',
    filterAll:'すべて', filterReady:'✓ 準備完了', filterNoSeq:'Seq なし', filterNoEdl:'EDL なし', filterNoLook:'Look なし',
    aeBtn:'AEスクリプト', nukeBtn:'Nuke .nk', shotsListBtn:'VFXカットリスト ▾', exportBtn:'その他 ▾',
    menuXlsx:'📊 Excel (.xlsx)', menuPdf:'📎 PDF', menuCsv:'📄 CSV',
    menuJson:'🔗 Mapping JSON', menuNukePy:'▏ Nuke .py',
    searchPlaceholder:'カット名で検索…',
    slEmptyTitle:'カットなし', slEmptyHint:'VFXフォルダーをスキャンしてリストを表示してください。',
    qtHint:'カットを選択してプレビュー', qtNoRef:'QuickTime参照ファイルが見つかりません',
    qtReimport:'フォルダーを再読み込みしてプレビューを有効にしてください', inspEmpty:'カットを選択してください',
    relinkBtn:'ビデオプレビューを再リンク', relinkBusy:'リンク中…',
    toastNoScan:'VFXフォルダーをスキャンしてください。', toastNoAmf:'AMFモジュールが読み込まれていません。',
    progressScanning:'スキャン中…', toastScanFail:'スキャン失敗: ',
    toastScanned:'{n}カット スキャン完了。', toastCopied:'パスをコピーしました!',
    selNone:'{n}カット', selSelected:'{n} / {m}件 選択中', selFiltered:'{n} / {m}カット',
    progressStarting:'開始中…', progressExporting:'エクスポート中…',
    progressDone:'完了', progressError:'エクスポートエラー', progressFail:'エクスポート失敗',
    inspSeqTitle:'シーケンス', inspEdlTitle:'EDL EVENTS',
    inspCamTitle:'カメラ・レンズ', inspLookTitle:'LOOK · CDL',
    inspNoEdl:'EDLイベントなし', inspNoExr:'EXRメタデータなし',
    inspPattern:'パターン', inspRange:'範囲', inspFrames:'フレーム',
    inspExt:'拡張子', inspRes:'解像度', inspCs:'色空間', inspVerify:'確認',
    inspEdlTot:'EDL合計', inspCamera:'カメラ', inspLens:'レンズ',
    inspFocal:'焦点距離', inspTstop:'T-Stop', inspFocus:'フォーカス',
    inspFile:'ファイル', inspType:'タイプ',
    fvMatch:'✓ 一致', fvHdl:'+{n} fr (hdl)', fvShort:'{n} fr 不足',
    evtLabel:'EVT {n}',
    codecErr:'コーデック非対応 — H.264 MP4でエクスポートしてください',
  },
};

import { attachPlayableVideo, releasePlayableVideo, PLAYABLE_STATUS } from '../../core/playableMedia.js';

export function createPlateLinkFeature(deps = {}) {
  const { AMF, tcToFrames, framesToTC } = deps;

  // ── i18n ──────────────────────────────────────────────────────────────────
  let _pl2Lang = 'eng';
  const _t = (key, p = {}) => {
    const d = _PL2_STRINGS[_pl2Lang] || _PL2_STRINGS.eng;
    let s = (d[key] ?? _PL2_STRINGS.eng[key]) ?? key;
    for (const [k, val] of Object.entries(p)) s = s.replaceAll(`{${k}}`, val);
    return s;
  };
  // Preserve img children when updating button text
  const _setBtnText = (btn, text) => {
    if (!btn) return;
    const img = btn.querySelector('img');
    if (img) { [...btn.childNodes].forEach(n => { if (n !== img) n.remove(); }); btn.appendChild(document.createTextNode(text)); }
    else btn.textContent = text;
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let _mounted        = false;
  let _amfResult      = null;
  let _files          = [];
  let _folderName     = '';
  let _fps            = 24;
  let _activeShot     = '';
  let _activeRowEl    = null;  // direct ref to active row element (avoids O(n) scan)
  let _filterText     = '';
  let _filterStatus   = 'all';
  // _qtObjectUrl removed — lifecycle now managed by attachPlayableVideo / releasePlayableVideo
  let _wasRestored    = false; // true when result loaded from localStorage (no File refs)
  let _shotMap        = new Map(); // shotName → shot object; rebuilt on each render
  let _restoring      = false; // guard: prevent concurrent _primeAndRestore calls
  let _relinking      = false; // guard: prevent concurrent _tryRelinkFromHandle walks

  const v = {};              // DOM refs

  const _LS_RESULT_KEY = 'pfx.platelink2.lastResult.v1';

  // ── Public API ────────────────────────────────────────────────────────────
  function mount() {
    if (_mounted) return;
    _mounted = true;
    _queryDOM();
    _wireEvents();
    _pl2Lang = localStorage.getItem('pfx.pl2.lang') || 'eng';
    if (v.langSel) v.langSel.value = _pl2Lang;
    _pl2ApplyStrings();
  }

  function onTabActivated() {
    if (!_mounted) mount();
    if (!_amfResult) _primeAndRestore();
  }

  // Called within the tab-click user gesture — requests file permission BEFORE deferring.
  // requestPermission() requires a user gesture; setTimeout/async breaks that chain.
  async function _primeAndRestore() {
    if (_restoring) return; // already in progress — rapid tab switching guard
    _restoring = true;
    try {
      // Step 1: request permission while user gesture (tab click) is still active.
      // IDB read + queryPermission are fast enough (<20ms) to stay within the gesture window.
      try {
        const handle = await _loadDirHandle();
        if (handle) {
          const perm = await handle.queryPermission({ mode: 'read' });
          if (perm !== 'granted') {
            // requestPermission needs user gesture — this is the right place to call it
            await handle.requestPermission({ mode: 'read' });
          }
        }
      } catch {}
      // Step 2: now restore result (permission is granted or we have no handle)
      _tryRestoreResult();
    } finally {
      _restoring = false;
    }
  }

  // ── Persist scan result ───────────────────────────────────────────────────
  function _saveResult() {
    // Defer completely off the scan critical path — never block the UI thread.
    setTimeout(() => {
      try {
        if (!_amfResult) return;
        // Build a minimal snapshot: only the fields the shot list + inspector need.
        // Deliberately excludes File/Blob refs and large binary metadata.
        const shots = (_amfResult.shots || []).map(s => ({
          shotName: s.shotName || s.name || s.shot || '',
          flags: s.flags || {},
          seq: s.seq ? {
            patternRel: s.seq.patternRel,
            start: s.seq.start,
            end: s.seq.end,
            count: s.seq.count,
            ext: s.seq.ext,
            resolution: s.seq.resolution || s.seq.res,
            colorSpace: s.seq.colorSpace || s.seq.colorspace,
          } : null,
          edl: s.edl ? {
            relPath: s.edl.relPath,
            hits: (s.edl.hits || []).map(h => ({
              num: h.num, recIn: h.recIn, recOut: h.recOut,
              comments: h.comments,
              speedPct: h.speedPct, speedIsDynamic: h.speedIsDynamic,
            })),
          } : null,
          look: s.look ? { relPath: s.look.relPath, type: s.look.type } : null,
          // qt.file is a File object — excluded; relPath kept for auto-relink
          qt: s.qt ? { relPath: s.qt.relPath, ext: s.qt.ext, kind: s.qt.kind } : null,
        }));
        const payload = JSON.stringify({
          result: { shots, stats: _amfResult.stats, rootName: _amfResult.rootName },
          folderName: _folderName,
          fps: _fps,
        });
        // Skip if still too large for localStorage (quota ~5 MB; guard at 800 KB)
        if (payload.length > 800_000) return;
        localStorage.setItem(_LS_RESULT_KEY, payload);
        try { window.MPS_markProjectDirty?.('plate link'); } catch {}
      } catch(e) { console.warn('[PL2] save result failed:', e); }
    }, 300);
  }

  function _tryRestoreResult() {
    // Also defer — avoid blocking the tab-switch paint with a large JSON.parse
    setTimeout(() => {
      try {
        if (_amfResult) return; // scan already loaded since defer started
        const raw = localStorage.getItem(_LS_RESULT_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved?.result) return;
        _amfResult  = saved.result;
        _folderName = saved.folderName || 'VFX Root';
        _fps        = saved.fps || 24;
        _wasRestored = true;
        _renderResult();
        _tryRelinkFromHandle(); // async — silently re-links qt.file for each shot
      } catch(e) { console.warn('[PL2] restore result failed:', e); }
    }, 0);
  }

  // ── IndexedDB dir-handle store (for auto-relink after refresh) ────────────
  const _IDB_NAME  = 'pfx_pl2_handles';
  const _IDB_STORE = 'dirHandles';
  const _IDB_KEY   = 'root';

  function _idbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(_IDB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(_IDB_STORE);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _saveDirHandle(handle) {
    try {
      const db = await _idbOpen();
      const tx = db.transaction(_IDB_STORE, 'readwrite');
      tx.objectStore(_IDB_STORE).put(handle, _IDB_KEY);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      db.close();
    } catch(e) { console.warn('[PL2] saveDirHandle failed:', e); }
  }

  async function _loadDirHandle() {
    try {
      const db = await _idbOpen();
      return await new Promise((res, rej) => {
        const req = db.transaction(_IDB_STORE, 'readonly')
                      .objectStore(_IDB_STORE).get(_IDB_KEY);
        req.onsuccess = () => { db.close(); res(req.result || null); };
        req.onerror   = () => { db.close(); rej(req.error); };
      });
    } catch { return null; }
  }

  // Walk a FileSystemDirectoryHandle recursively, building relPath→FileHandle map
  async function _walkDirHandle(dirHandle, prefix, map) {
    try {
      for await (const [name, handle] of dirHandle.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'file')      map.set(path, handle);
        else if (handle.kind === 'directory') await _walkDirHandle(handle, path, map);
      }
    } catch {}
  }

  async function _tryRelinkFromHandle() {
    if (_relinking) return; // already walking the directory — don't start another walk
    _relinking = true;
    try {
      // Collect shots that actually need relinking
      const needsLink = (_amfResult?.shots || []).filter(
        s => s.qt?.relPath && !s.qt?.file
      );
      if (!needsLink.length) return;

      const handle = await _loadDirHandle();

      if (!handle) {
        // No saved handle — user scanned via button (not drag-drop).
        // Show re-link button; clicking it will prompt for folder via showDirectoryPicker.
        _showRelinkButton(null);
        return;
      }

      // Check permission — _primeAndRestore() should have granted it already.
      // Try requestPermission() as a fallback (only works if called with user gesture).
      let perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        try { perm = await handle.requestPermission({ mode: 'read' }); } catch {}
      }

      if (perm !== 'granted') {
        // Permission denied or not available without gesture — show re-link button
        _showRelinkButton(handle);
        return;
      }

      await _doRelinkWalk(handle, needsLink);
    } catch(e) { console.warn('[PL2] relinkFromHandle failed:', e); }
    finally { _relinking = false; }
  }

  // Walk handle and hydrate shot.qt.file for shots in needsLink array
  async function _doRelinkWalk(handle, needsLink) {
    // Build target path set: stripped-relPath → shot object
    const targetPaths = new Map();
    for (const shot of needsLink) {
      const parts = shot.qt.relPath.split('/');
      // relPath includes root folder name ("VFXRoot/QT_Files/shot.mov") — strip first segment
      const subPath = parts.length > 1 ? parts.slice(1).join('/') : shot.qt.relPath;
      targetPaths.set(subPath, shot);
      // Also register the full path as fallback in case root wasn't stripped
      if (parts.length > 1) targetPaths.set(shot.qt.relPath, shot);
    }

    const MAX_FILES = 8000;
    let fileCount = 0;
    let linked = 0;

    async function walkUntilDone(dirHandle, prefix) {
      if (targetPaths.size === 0 || fileCount >= MAX_FILES) return;
      for await (const [name, h] of dirHandle.entries()) {
        if (targetPaths.size === 0 || fileCount >= MAX_FILES) break;
        const path = prefix ? `${prefix}/${name}` : name;
        if (h.kind === 'file') {
          fileCount++;
          const shot = targetPaths.get(path);
          if (shot) {
            try {
              const f = await h.getFile();
              shot.qt.file = f;
              linked++;
            } catch {}
            // Remove all keys that map to this shot (dedup)
            for (const [k, s] of targetPaths) { if (s === shot) targetPaths.delete(k); }
          }
          // Yield every 50 files to keep the renderer responsive
          if (fileCount % 50 === 0) await new Promise(r => setTimeout(r, 0));
        } else if (h.kind === 'directory') {
          await walkUntilDone(h, path);
        }
      }
    }

    await walkUntilDone(handle, '');

    if (linked > 0) {
      _wasRestored = false;
      _hideRelinkButton();
      // Rebuild shotMap so _setActiveShot picks up the new file refs
      _shotMap.clear();
      for (const shot of (_amfResult?.shots || [])) {
        _shotMap.set(shot.shotName || shot.name || shot.shot || '', shot);
      }
      if (_activeShot) _setActiveShot(_activeShot);
      console.info(`[PL2] Auto-relinked ${linked} QT file(s) (walked ${fileCount} files)`);
    }
  }

  // ── Re-link button (fallback when permission needs explicit user gesture) ──
  function _showRelinkButton(handle) {
    if (!v.qtNoRef) return;
    v.qtNoRef.style.display = '';
    const existing = v.qtNoRef.querySelector('.pl2-relink-btn');
    if (existing) return; // already shown
    const btn = document.createElement('button');
    btn.className = 'pl2-relink-btn';
    btn.textContent = _t('relinkBtn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = _t('relinkBusy');
      try {
        let h = handle;
        if (!h) {
          // No saved handle (e.g. scanned via button, not drag-drop).
          // showDirectoryPicker is valid here because this runs inside a click handler.
          h = await window.showDirectoryPicker?.({ id: 'pl2-vfx-scan', mode: 'read' }) ?? null;
          if (h) await _saveDirHandle(h);
        } else {
          const perm = await h.requestPermission({ mode: 'read' });
          if (perm !== 'granted') { if (btn.parentNode) btn.remove(); return; }
        }
        if (h) {
          const needsLink = (_amfResult?.shots || []).filter(
            s => s.qt?.relPath && !s.qt?.file
          );
          await _doRelinkWalk(h, needsLink);
        }
      } catch {}
      if (btn.parentNode) btn.remove();
    }, { once: true });
    v.qtNoRef.appendChild(btn);
  }

  function _hideRelinkButton() {
    v.qtNoRef?.querySelector('.pl2-relink-btn')?.remove();
  }

  // ── Apply i18n strings to all static DOM elements ────────────────────────
  function _pl2ApplyStrings() {
    // Scan button
    _setBtnText(v.scanBtn, _t('scanBtn'));

    // Filter pills (in DOM order: All, Ready, No Seq, No EDL, No Look)
    const pillKeys = ['filterAll','filterReady','filterNoSeq','filterNoEdl','filterNoLook'];
    document.querySelectorAll('#main-platelink2 .pl2-status-pill')
      .forEach((p, i) => { if (pillKeys[i]) p.textContent = _t(pillKeys[i]); });

    // Export buttons
    _setBtnText(v.aeBtn, _t('aeBtn'));
    _setBtnText(v.nukeNkBtn, _t('nukeBtn'));
    if (v.shotsListBtn) v.shotsListBtn.textContent = _t('shotsListBtn');
    if (v.exportBtn)    v.exportBtn.textContent    = _t('exportBtn');

    // Export menu items
    const slBtns = v.shotsListMenu?.querySelectorAll('button[data-act]') || [];
    const slKeys = ['menuXlsx','menuPdf','menuCsv'];
    slBtns.forEach((b, i) => { if (slKeys[i]) b.textContent = _t(slKeys[i]); });
    const exBtns = v.exportMenu?.querySelectorAll('button[data-fmt]') || [];
    const exKeys = ['menuJson','menuNukePy'];
    exBtns.forEach((b, i) => { if (exKeys[i]) b.textContent = _t(exKeys[i]); });

    // Search placeholder
    if (v.searchInput) v.searchInput.placeholder = _t('searchPlaceholder');

    // Empty state (left panel)
    const emptyTitle = v.slEmpty?.querySelector('.pl2-sl-empty-title');
    const emptyHint  = v.slEmpty?.querySelector('.pl2-sl-empty-hint');
    if (emptyTitle) emptyTitle.textContent = _t('slEmptyTitle');
    if (emptyHint)  emptyHint.textContent  = _t('slEmptyHint');

    // QT hint
    const qtHintP = v.qtHint?.querySelector('p');
    if (qtHintP) qtHintP.textContent = _t('qtHint');

    // Inspector empty
    const inspEmptyP = v.inspEmpty?.querySelector('p');
    if (inspEmptyP) inspEmptyP.textContent = _t('inspEmpty');

    // Context bar + sel meta (re-render from current state)
    _updateCtxBar();
    _updateSelMeta();

    // Re-render inspector for active shot (row labels change with language)
    if (_activeShot && _shotMap.has(_activeShot)) _renderInspector(_shotMap.get(_activeShot));
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function _queryDOM() {
    const q = id => document.getElementById(id);
    v.scanBtn       = q('pl2ScanBtn');
    v.scanInput     = q('pl2ScanInput');
    v.aeBtn         = q('pl2AeBtn');
    v.nukeNkBtn     = q('pl2NukeNkBtn');
    v.shotsListBtn  = q('pl2ShotsListBtn');
    v.shotsListMenu = q('pl2ShotsListMenu');
    v.exportBtn     = q('pl2ExportBtn');
    v.exportMenu    = q('pl2ExportMenu');
    v.ctxFolder     = q('pl2CtxFolder');
    v.ctxShots      = q('pl2CtxShots');
    v.ctxReady      = q('pl2CtxReady');
    v.ctxMissing    = q('pl2CtxMissing');
    v.progressBar   = q('pl2ProgressBar');
    v.progressWrap  = q('pl2ProgressWrap');
    v.progressLabel = q('pl2ProgressLabel');
    v.progressPct   = q('pl2ProgressPct');
    v.searchInput   = q('pl2SearchInput');
    v.shotList      = q('pl2ShotList');
    v.slEmpty       = q('pl2SlEmpty');
    v.inspector     = q('pl2InspDetail');
    v.inspEmpty     = q('pl2InspEmpty');
    v.selectAllCb   = q('pl2SelectAll');
    v.selMeta       = q('pl2SelMeta');
    v.qtWrap        = q('pl2QtWrap');
    v.qtPreview     = q('pl2QtPreview');
    // Resolve-style transport (replaces the native <video controls> bar).
    if (v.qtPreview) import('../../core/resolveVideoTransport.js')
      .then(m => m.attachResolveTransport(v.qtPreview, {
        onPreviousItem: () => _navActiveShot(-1),
        onCurrentItem:  () => _navActiveShot(0),
        onNextItem:     () => _navActiveShot(1),
      })).catch(() => {});
    v.qtHint        = q('pl2QtHint');
    v.qtNoRef       = q('pl2QtNoRef');
    v.langSel       = q('pl2LangSel');
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  function _wireEvents() {
    // Scan button uses native <input webkitdirectory> — fast, browser-native file walk.
    // After scan completes, _doScan() tries showDirectoryPicker to save the handle
    // for auto-relink (no file-walk needed — just the handle itself).
    v.scanBtn?.addEventListener('click', () => v.scanInput?.click());
    v.scanInput?.addEventListener('change', () => {
      const files = Array.from(v.scanInput.files || []);
      if (files.length) _doScan(files);
      v.scanInput.value = '';
    });

    v.aeBtn?.addEventListener('click', async () => {
      if (!_amfResult) return _showToast(_t('toastNoScan'), 'warn');
      await _ensureExportHandle();
      await _runExport(() => AMF?.exportAEJSX?.(_getSelectedResult()));
    });

    v.nukeNkBtn?.addEventListener('click', async () => {
      if (!_amfResult) return _showToast(_t('toastNoScan'), 'warn');
      await _ensureExportHandle();
      await _runExport(() => AMF?.exportNukeNK?.(_getSelectedResult()));
    });

    v.shotsListBtn?.addEventListener('click', e => {
      e.stopPropagation();
      if (v.shotsListMenu)
        v.shotsListMenu.style.display = v.shotsListMenu.style.display === 'none' ? 'block' : 'none';
    });
    v.shotsListMenu?.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!_amfResult) return _showToast(_t('toastNoScan'), 'warn');
        const sel = _getSelectedResult();
        const act = btn.dataset.act;
        if (act === 'xlsx') await _runExport(() => AMF?.exportShotsListXlsxV5?.(sel));
        if (act === 'pdf')  await _runExport(() => AMF?.exportShotsListPDFLightLayout2?.(sel));
        if (act === 'csv')  await _runExport(() => AMF?.exportShotsListCSV?.(sel));
        if (v.shotsListMenu) v.shotsListMenu.style.display = 'none';
      });
    });

    v.exportBtn?.addEventListener('click', e => {
      e.stopPropagation();
      if (v.exportMenu)
        v.exportMenu.style.display = v.exportMenu.style.display === 'none' ? 'block' : 'none';
    });
    v.exportMenu?.querySelectorAll('button[data-fmt]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!_amfResult) return _showToast(_t('toastNoScan'), 'warn');
        const fmt = btn.dataset.fmt;
        const sel = _getSelectedResult();
        if (fmt === 'json')   _runExport(() => AMF?.exportMappingJSON?.(sel));
        if (fmt === 'nukepy') _runExport(() => AMF?.exportNukePY?.(sel));
        if (v.exportMenu) v.exportMenu.style.display = 'none';
      });
    });

    document.addEventListener('click', () => {
      if (v.shotsListMenu) v.shotsListMenu.style.display = 'none';
      if (v.exportMenu)    v.exportMenu.style.display    = 'none';
    }, { passive: true });

    // Status filter pills
    document.querySelectorAll('#main-platelink2 .pl2-status-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        _filterStatus = btn.dataset.status || 'all';
        document.querySelectorAll('#main-platelink2 .pl2-status-pill')
          .forEach(b => b.classList.toggle('pl2-filter-active', b === btn));
        _applyVisibility();
      });
    });

    // Search
    let _st;
    v.searchInput?.addEventListener('input', () => {
      clearTimeout(_st);
      _st = setTimeout(() => {
        _filterText = (v.searchInput.value || '').toLowerCase().trim();
        _applyVisibility();
      }, 300);
    });

    // Select-all checkbox
    v.selectAllCb?.addEventListener('change', () => {
      v.shotList?.querySelectorAll('input.pl2-sl-check:not(:disabled)')
        .forEach(cb => { cb.checked = v.selectAllCb.checked; });
      _updateSelMeta();
    });

    // Drag-drop folder
    const pane = document.getElementById('main-platelink2');
    if (pane) {
      pane.addEventListener('dragover', e => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        pane.classList.add('pl2-drag-over');
      }, { passive: false });
      pane.addEventListener('dragleave', e => {
        if (!pane.contains(e.relatedTarget)) pane.classList.remove('pl2-drag-over');
      }, { passive: true });
      pane.addEventListener('drop', e => {
        e.preventDefault();
        pane.classList.remove('pl2-drag-over');
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        // Capture the directory handle SYNCHRONOUSLY before the event ends.
        // DataTransferItem is only valid during event dispatch; getAsFileSystemHandle()
        // starts a microtask chain that still has access to the item.
        // Must call this before _doScan to avoid any async interleaving.
        let _dirHandlePromise = null;
        const item = e.dataTransfer.items?.[0];
        if (item?.getAsFileSystemHandle) {
          _dirHandlePromise = item.getAsFileSystemHandle().catch(() => null);
        }
        _doScan(files);
        // Save after scan starts (non-blocking) — promise was already started synchronously
        if (_dirHandlePromise) {
          _dirHandlePromise.then(h => {
            if (h?.kind === 'directory') _saveDirHandle(h);
          }).catch(() => {});
        }
      }, { passive: false });
    }

    // Delegated shot list click — one listener instead of one per row
    v.shotList?.addEventListener('click', e => {
      const hdr  = e.target.closest('.pl2-sl-ghdr');
      if (hdr)  { _toggleSLGroup(hdr.dataset.group); return; }
      const row  = e.target.closest('.pl2-sl-shot');
      if (!row) return;
      if (e.target.matches('input.pl2-sl-check')) { _updateSelMeta(); return; }
      _setActiveShot(row.dataset.shot || '');
    }, { passive: true });

    // ── Video pipeline management ─────────────────────────────────────────────
    // Codec errors and ProRes fallback are handled inside attachPlayableVideo →
    // loadVideoWithProxyFallback. The old hard-coded 'codecErr' error listener is
    // replaced by the onProxyFail callback in _loadQtVideo below.

    if (v.qtPreview) {

      // Fully abort (not just pause) when browser tab is hidden — stops background buffering.
      // Chrome keeps decoding/buffering a paused video; abort + load() releases the pipeline.
      // Re-arm the video when the tab becomes visible again.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          _videoAbort();
        } else if (_activeShot) {
          const shot = _shotMap.get(_activeShot);
          if (shot?.qt?.file && !v.qtPreview?._pfxPlayableMode) _loadQtVideo(shot);
        }
      }, { passive: true });
    }

    // Fully abort when switching away from the Plate Link tab; re-arm on return.
    document.addEventListener('mps:mainTabChanged', e => {
      if (e.detail?.key !== 'platelink2') {
        _videoAbort();
      } else if (_activeShot) {
        const shot = _shotMap.get(_activeShot);
        if (shot?.qt?.file && !v.qtPreview?._pfxPlayableMode) _loadQtVideo(shot);
      }
    }, { passive: true });

    // Language selector
    v.langSel?.addEventListener('change', () => {
      _pl2Lang = v.langSel.value || 'eng';
      try { localStorage.setItem('pfx.pl2.lang', _pl2Lang); } catch {}
      _pl2ApplyStrings();
    });
  }

  // ── Scan ──────────────────────────────────────────────────────────────────
  async function _doScan(files) {
    if (!AMF?.scanVFXFolder) {
      _showToast(_t('toastNoAmf'), 'warn');
      return;
    }
    _files      = files;
    _folderName = (files[0]?.webkitRelativePath || files[0]?.name || '').split('/')[0] || 'VFX Root';
    _fps        = window.__MPS_EDL_RAW?.fps || 24;

    _showProgress(10, _t('progressScanning'));
    try {
      _amfResult = await AMF.scanVFXFolder(files);
      _wasRestored = false;
    } catch (e) {
      _hideProgress();
      _showToast(_t('toastScanFail') + (e?.message || e), 'warn');
      return;
    }
    _hideProgress();
    _renderResult();
    _saveResult();
    _showToast(_t('toastScanned', {n: _amfResult?.stats?.shots || 0}));
    window.MPS_auditAdd?.({ type: 'Scan', intent: 'platelink2-scan', count: _amfResult?.stats?.shots || 0 });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function _renderResult() {
    _updateCtxBar();
    _renderShotList();
    _applyVisibility();
    _updateSelMeta();
    // Clear active shot / inspector when re-scanning
    _activeShot = '';
    _qtReset();
    if (v.inspector)  v.inspector.style.display = 'none';
    if (v.inspEmpty)  v.inspEmpty.style.display  = '';
  }

  // ── Shot list (left panel) ────────────────────────────────────────────────
  function _groupKey(shotName) {
    const parts = String(shotName || '').split(/[_\s]+/).filter(Boolean);
    if (parts.length >= 3) return `${parts[0]}_${parts[1]}_${parts[2]}`;
    if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
    return shotName;
  }

  function _shotTail(shotName, groupKey) {
    const prefix = groupKey + '_';
    return shotName.startsWith(prefix) ? shotName.slice(prefix.length) : shotName;
  }

  function _renderShotList() {
    if (!v.shotList) return;
    const shots = _amfResult?.shots || [];

    if (!shots.length) {
      v.shotList.innerHTML = '';
      if (v.slEmpty) { v.slEmpty.style.display = ''; v.shotList.appendChild(v.slEmpty); }
      return;
    }
    if (v.slEmpty) v.slEmpty.style.display = 'none';

    // Rebuild O(1) shot lookup map
    _shotMap.clear();
    for (const shot of shots) {
      _shotMap.set(shot.shotName || shot.name || shot.shot || '', shot);
    }

    // Group shots
    const groups = new Map();
    for (const shot of shots) {
      const name = shot.shotName || shot.name || shot.shot || '';
      const gk   = _groupKey(name);
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(shot);
    }

    let html = '';
    for (const [g, gShots] of groups) {
      const gE    = _he(g);
      const total = gShots.length;
      const ready = gShots.filter(s => s.flags?.hasSeq && s.flags?.hasEDL).length;
      const pct   = total ? Math.round((ready / total) * 100) : 0;
      const progCol = (ready === total) ? '#4caf80' : ready > 0 ? '#e5c07b' : '#e06c75';

      html += `<div class="pl2-sl-group" data-group="${gE}">`;
      html += `<div class="pl2-sl-ghdr" data-group="${gE}">`;
      html += `<span class="pl2-sl-caret"></span>`;
      html += `<span class="pl2-sl-gname">${gE}</span>`;
      html += `<div class="pl2-sl-ginfo">`;
      html += `<div class="pl2-sl-gprog"><div class="pl2-sl-gprog-fill" style="width:${pct}%;background:${progCol}"></div></div>`;
      html += `<span class="pl2-sl-gstat">${ready}/${total}</span>`;
      html += `</div></div>`;

      for (const shot of gShots) {
        const name   = shot.shotName || shot.name || shot.shot || '';
        const nameE  = _he(name);
        const tail   = _he(_shotTail(name, g));
        const hasSeq  = !!(shot.flags?.hasSeq);
        const hasEDL  = !!(shot.flags?.hasEDL);
        const hasLook = !!(shot.flags?.hasLook);
        const borderCol = (hasSeq && hasEDL) ? '#4caf80' : hasSeq ? '#e5c07b' : '#e06c75';
        const frames = shot.seq?.count || '';

        html += `<div class="pl2-sl-shot" data-shot="${nameE}" data-group="${gE}" style="display:none;border-left-color:${borderCol}">`;
        html += `<input type="checkbox" class="pl2-sl-check" data-shot="${nameE}" checked>`;
        html += `<span class="pl2-sl-tail">${tail}</span>`;
        html += `<div class="pl2-sl-chips">`;
        html += `<span class="pl2-sl-chip ${hasSeq?'ok':'miss'}">SEQ</span>`;
        html += `<span class="pl2-sl-chip ${hasEDL?'ok':'miss'}">EDL</span>`;
        html += `<span class="pl2-sl-chip ${hasLook?'ok':'none'}">CDL</span>`;
        html += `</div>`;
        if (frames) html += `<span class="pl2-sl-fr">${frames}f</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    v.shotList.innerHTML = html;
    if (v.slEmpty) v.shotList.appendChild(v.slEmpty);
    // No per-row listeners — delegated to v.shotList in _wireEvents()
  }

  function _toggleSLGroup(g) {
    const hdr  = v.shotList?.querySelector(`.pl2-sl-ghdr[data-group="${CSS.escape(g)}"]`);
    if (!hdr) return;
    const grp  = hdr.closest('.pl2-sl-group');
    const open = grp?.classList.toggle('pl2-sl-open');
    // Use literal attribute value (not CSS.escape) when filtering by attribute value in quotes
    v.shotList?.querySelectorAll('.pl2-sl-shot')
      .filter ? null : void 0; // querySelectorAll returns NodeList, iterate with forEach
    v.shotList?.querySelectorAll('.pl2-sl-shot').forEach(row => {
      if (row.dataset.group !== g) return;
      row.style.display = (open && row.dataset.visible !== '0') ? '' : 'none';
    });
  }

  // ── Active shot + QT player ───────────────────────────────────────────────
  function _setActiveShot(shotName) {
    _activeShot = shotName;
    // O(1): deactivate previous row, activate new row — no full scan
    if (_activeRowEl) _activeRowEl.classList.remove('pl2-sl-active');
    const escaped = CSS.escape(shotName);
    _activeRowEl = v.shotList?.querySelector(`.pl2-sl-shot[data-shot="${escaped}"]`) || null;
    if (_activeRowEl) {
      const grp = _activeRowEl.closest('.pl2-sl-group');
      grp?.classList.add('pl2-sl-open');
      grp?.querySelectorAll('.pl2-sl-shot').forEach(row => {
        if (row.dataset.visible !== '0') row.style.display = '';
      });
      _activeRowEl.classList.add('pl2-sl-active');
    }
    const shot = _shotMap.get(shotName) || null;
    _loadQtVideo(shot);
    _renderInspector(shot);
  }

  function _visibleShotNames() {
    return Array.from(v.shotList?.querySelectorAll('.pl2-sl-shot') || [])
      .filter(row => row.dataset.visible !== '0' && row.closest('.pl2-sl-group')?.style.display !== 'none')
      .map(row => row.dataset.shot)
      .filter(Boolean);
  }

  function _navActiveShot(delta) {
    const names = _visibleShotNames();
    if (!names.length) return false;
    let idx = _activeShot ? names.indexOf(_activeShot) : -1;
    if (delta === 0) {
      if (idx >= 0) {
        const vid = v.qtPreview;
        try { if (vid && Number.isFinite(vid.duration)) { vid.pause(); vid.currentTime = 0; } } catch {}
        _setActiveShot(names[idx]);
        return true;
      }
      _setActiveShot(names[0]);
      return true;
    }
    if (idx < 0) idx = delta > 0 ? -1 : names.length;
    idx = Math.max(0, Math.min(names.length - 1, idx + delta));
    _setActiveShot(names[idx]);
    _activeRowEl?.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  // Fully abort the video decode pipeline and release media resources.
  // releasePlayableVideo tears down blob URL ref, aborts pipeline, and clears element state.
  function _videoAbort() {
    if (!v.qtPreview) return;
    releasePlayableVideo(v.qtPreview);
  }

  function _loadQtVideo(shot) {
    _videoAbort(); // releases previous element state via releasePlayableVideo
    if (v.qtHint) v.qtHint.style.display = 'none';
    if (!v.qtPreview) return;

    const qtFile = shot?.qt?.file;
    if (!qtFile) {
      v.qtPreview.style.display = 'none';
      if (v.qtNoRef) {
        v.qtNoRef.style.display = '';
        const span = v.qtNoRef.querySelector('span');
        if (span) {
          const hadFile = !!(shot?.qt?.relPath);
          span.textContent = hadFile ? _t('qtReimport') : _t('qtNoRef');
          if (!hadFile) _hideRelinkButton();
        }
      }
      return;
    }

    // Show the player area optimistically; hide no-ref overlay.
    v.qtPreview.style.display = '';
    if (v.qtNoRef) v.qtNoRef.style.display = 'none';

    // Capture the file for stale-callback guard (shot may change while proxy transcodes).
    const captureFile = qtFile;

    attachPlayableVideo(v.qtPreview, qtFile, {
      onStatus: (label) => {
        // Show proxy progress in the no-ref overlay span so the user can see status.
        if (v.qtPreview._pfxPlayableOriginalMeta?.name !== captureFile.name) return;
        if (label === PLAYABLE_STATUS.direct || label === PLAYABLE_STATUS.proxy) return;
        if (v.qtNoRef) {
          v.qtNoRef.style.display = '';
          const span = v.qtNoRef.querySelector('span');
          if (span) span.textContent = label;
        }
      },
      onMode: (mode) => {
        if (v.qtPreview._pfxPlayableOriginalMeta?.name !== captureFile.name) return;
        // Playback confirmed (direct or proxy) — hide the overlay.
        if (v.qtNoRef) v.qtNoRef.style.display = 'none';
      },
      onProxyFail: (hint) => {
        if (v.qtPreview._pfxPlayableOriginalMeta?.name !== captureFile.name) return;
        v.qtPreview.style.display = 'none';
        if (v.qtNoRef) {
          v.qtNoRef.style.display = '';
          const span = v.qtNoRef.querySelector('span');
          if (span) span.textContent = hint;
        }
      },
      onNoOutputDir: () => {
        if (v.qtNoRef) {
          v.qtNoRef.style.display = '';
          const span = v.qtNoRef.querySelector('span');
          if (span) span.textContent = 'Set Media Root in Settings to enable ProRes proxy';
        }
      },
    });
  }

  function _qtReset() {
    _videoAbort();
    if (v.qtPreview) v.qtPreview.style.display = 'none';
    if (v.qtHint)    v.qtHint.style.display    = '';
    if (v.qtNoRef)   v.qtNoRef.style.display   = 'none';
  }

  // ── Camera/lens from localStorage (written by amf_convert EXR scan) ──────
  function _getCamLens(shotName) {
    const rootName = _amfResult?.rootName || _folderName || 'VFX_ROOT';
    const rn = String(rootName || '').trim() || 'VFX_ROOT';
    const sn = String(shotName || '').trim() || 'SHOT';
    try {
      const raw = localStorage.getItem(`mps.vfx.camlens.${rn}.${sn}`);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const any = Object.values(obj).some(v => String(v || '').trim());
      return any ? { cam: obj.cam||'', lens: obj.lens||'', focal: obj.focal||'', tstop: obj.tstop||'', focus: obj.focus||'' } : null;
    } catch { return null; }
  }

  // ── Inspector (right panel detail) ────────────────────────────────────────
  function _renderInspector(shot) {
    if (!v.inspector || !v.inspEmpty) return;
    if (!shot) {
      v.inspector.style.display = 'none';
      v.inspEmpty.style.display = '';
      return;
    }
    v.inspector.style.display = '';
    v.inspEmpty.style.display = 'none';

    const name    = shot.shotName || shot.name || shot.shot || '—';
    const hasSeq  = !!(shot?.flags?.hasSeq  || shot?.seq?.patternRel);
    const hasEDL  = !!(shot?.flags?.hasEDL  || shot?.edl?.relPath);
    const hasLook = !!(shot?.flags?.hasLook || shot?.look?.relPath);

    // ── helpers ──
    const _cmntClass = line => {
      const l = (line || '').toLowerCase();
      if (l.includes('from clip name') || l.includes('clip name')) return 'cmnt-clip';
      if (l.includes('asc_sop') || l.includes('asc_sat'))         return 'cmnt-asc';
      if (l.includes('asc_cdl') || l.includes('cdl'))             return 'cmnt-cdl';
      if (l.includes('speed') || l.includes('%'))                 return 'cmnt-speed';
      if (l.includes('vfx') || l.includes('effect'))              return 'cmnt-vfx';
      return '';
    };
    const _row = (k, v, cls = '') =>
      `<div class="pl2-insp-row"><span class="k">${k}</span><span class="v${cls?' '+cls:''}" title="${_he(v)}">${_he(v||'—')}</span></div>`;

    // ── col 1: sequence ──
    const seqPat   = shot?.seq?.patternRel || '';
    const seqStart = shot?.seq?.start ?? null;
    const seqEnd   = shot?.seq?.end   ?? null;
    const seqCount = shot?.seq?.count ?? 0;
    const seqExt   = shot?.seq?.ext   || '';
    const seqRes   = shot?.seq?.resolution || shot?.seq?.res || '';
    const seqCS    = shot?.seq?.colorSpace || shot?.seq?.colorspace || '';

    // ── frame verify ──
    const hits      = Array.isArray(shot?.edl?.hits) ? shot.edl.hits : [];
    const edlFrames = hits.reduce((s, h) => s + Math.max(0, (h.recOut||0)-(h.recIn||0)), 0);
    const frameDiff = seqCount - edlFrames;
    const fvText    = (!seqCount || !edlFrames) ? '—'
      : frameDiff === 0 ? _t('fvMatch')
      : frameDiff > 0   ? _t('fvHdl', {n: frameDiff})
      : _t('fvShort', {n: Math.abs(frameDiff)});
    const fvCls     = (!seqCount || !edlFrames) ? '' : frameDiff === 0 ? 'good' : frameDiff > 0 ? '' : 'bad';

    // ── col 2: EDL events with ALL comments ──
    const edlHtml = hits.length ? hits.map((h, i) => {
      const dur   = Math.max(0, (h.recOut||0) - (h.recIn||0));
      const speed = (h.speedPct != null && h.speedPct !== 100) ? `${h.speedIsDynamic?'~':''}${h.speedPct}%${h.speedIsDynamic?' RAMP':''}` : '';
      const cmts  = Array.isArray(h.comments) ? h.comments.filter(Boolean) : [];
      return `<div class="pl2-insp-evt">
        <div class="pl2-insp-evt-hdr">
          <span class="pl2-insp-evt-num">${_t('evtLabel', {n: h.num ?? i+1})}</span>
          <span class="pl2-insp-evt-tc">${_f2tc(h.recIn||0)} → ${_f2tc(h.recOut||0)}</span>
          <span class="pl2-insp-evt-dur">${dur}fr</span>
          ${speed ? `<span class="pl2-insp-evt-speed">${_he(speed)}</span>` : ''}
        </div>
        ${cmts.map(c => `<div class="pl2-insp-cmnt ${_cmntClass(c)}">${_he(c)}</div>`).join('')}
      </div>`;
    }).join('') : `<div class="pl2-insp-row"><span class="v" style="color:#282840">${_he(_t('inspNoEdl'))}</span></div>`;

    // ── col 3: camera/lens + look ──
    const cl = _getCamLens(name);

    v.inspector.innerHTML = `
      <div class="pl2-insp-shotname" title="${_he(name)}">${_he(name)}</div>
      <div class="pl2-insp-3col">

        <!-- COL 1: SEQUENCE -->
        <div class="pl2-insp-col">
          <div class="pl2-insp-col-title">${_t('inspSeqTitle')}</div>
          <div class="pl2-insp-status-chips">
            <span class="pl2-insp-chip ${hasSeq?'ok':'miss'}">SEQ</span>
            <span class="pl2-insp-chip ${hasEDL?'ok':'miss'}">EDL</span>
            <span class="pl2-insp-chip ${hasLook?'ok':'none'}">CDL</span>
          </div>
          ${seqPat  ? `<div class="pl2-insp-row"><span class="k">${_t('inspPattern')}</span><span class="v" title="${_he(seqPat)}">${_he(seqPat.split('/').pop())}</span></div>` : ''}
          ${(seqStart != null && seqEnd != null) ? _row(_t('inspRange'), `${seqStart} – ${seqEnd}`) : ''}
          ${seqCount  ? _row(_t('inspFrames'), seqCount + ' fr') : ''}
          ${seqExt    ? _row(_t('inspExt'),    seqExt.toUpperCase()) : ''}
          ${seqRes    ? _row(_t('inspRes'),    seqRes) : ''}
          ${seqCS     ? _row(_t('inspCs'),     seqCS) : ''}
          ${_row(_t('inspVerify'), fvText, fvCls)}
          ${edlFrames ? _row(_t('inspEdlTot'), edlFrames + ' fr') : ''}
        </div>

        <!-- COL 2: EDL EVENTS -->
        <div class="pl2-insp-col">
          <div class="pl2-insp-col-title">${_t('inspEdlTitle')}
            <span style="float:right;font-weight:400;opacity:.5">${_he(shot?.edl?.relPath ? shot.edl.relPath.split('/').pop() : '')}</span>
          </div>
          ${edlHtml}
        </div>

        <!-- COL 3: CAMERA / LENS / LOOK -->
        <div class="pl2-insp-col">
          <div class="pl2-insp-col-title">${_t('inspCamTitle')}</div>
          ${cl ? `
            ${cl.cam   ? _row(_t('inspCamera'), cl.cam)   : ''}
            ${cl.lens  ? _row(_t('inspLens'),   cl.lens)  : ''}
            ${cl.focal ? _row(_t('inspFocal'),  cl.focal) : ''}
            ${cl.tstop ? _row(_t('inspTstop'),  cl.tstop) : ''}
            ${cl.focus ? _row(_t('inspFocus'),  cl.focus) : ''}
          ` : `<div class="pl2-insp-row"><span class="v" style="color:#282840">${_he(_t('inspNoExr'))}</span></div>`}
          ${hasLook ? `
            <div class="pl2-insp-col-title" style="margin-top:6px">${_t('inspLookTitle')}</div>
            ${_row(_t('inspFile'), (shot?.look?.relPath || '').split('/').pop() || '—')}
            ${_row(_t('inspType'), shot?.look?.type || '—')}
          ` : ''}
        </div>

      </div>`;

    // Copy on pattern click
    if (seqPat) {
      const el = v.inspector.querySelector(`.pl2-insp-row .v[title="${CSS.escape(seqPat)}"]`);
      if (el) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', e => {
          e.stopPropagation();
          const folder = seqPat.slice(0, Math.max(seqPat.lastIndexOf('/'), seqPat.lastIndexOf('\\')) + 1) || seqPat;
          navigator.clipboard?.writeText(folder).then(() => _showToast(_t('toastCopied')));
        });
      }
    }
  }

  // ── Visibility filter ──────────────────────────────────────────────────────
  function _applyVisibility() {
    if (!v.shotList) return;
    const q           = _filterText;
    const status      = _filterStatus;
    const isFiltering = (status !== 'all' || !!q);
    let matched = 0;

    // Iterate group → shots within the group to avoid per-shot .closest() traversal.
    // _shotMap is already maintained by _renderShotList(); no need to rebuild here.
    v.shotList.querySelectorAll('.pl2-sl-group').forEach(grp => {
      const isOpen = grp.classList.contains('pl2-sl-open');
      let groupHasMatch = false;

      grp.querySelectorAll('.pl2-sl-shot').forEach(row => {
        const shotName = row.dataset.shot || '';
        const shot     = _shotMap.get(shotName);
        let show = true;

        if      (status === 'ready')        show = !!(shot?.flags?.hasSeq && shot?.flags?.hasEDL);
        else if (status === 'missing-seq')  show = !(shot?.flags?.hasSeq);
        else if (status === 'missing-edl')  show = !(shot?.flags?.hasEDL);
        else if (status === 'no-look')      show = !(shot?.flags?.hasLook);

        if (show && q) show = shotName.toLowerCase().includes(q);

        row.dataset.visible = show ? '1' : '0';
        row.style.display   = (isFiltering ? show : (show && isOpen)) ? '' : 'none';
        if (show) { matched++; groupHasMatch = true; }
      });

      grp.style.display = groupHasMatch ? '' : 'none';
      // Auto-expand when a filter is active so matching shots are visible
      if (groupHasMatch && isFiltering) grp.classList.add('pl2-sl-open');
    });

    // Show empty state when filtering produces no results
    if (v.slEmpty) {
      v.slEmpty.style.display = (isFiltering && matched === 0) ? '' : 'none';
    }

    const total = _amfResult?.shots?.length ?? 0;
    if (v.selMeta) {
      v.selMeta.textContent = isFiltering
        ? _t('selFiltered', {n: matched, m: total})
        : _t('selNone', {n: total});
    }
  }

  // ── Context bar ────────────────────────────────────────────────────────────
  function _updateCtxBar() {
    const s = _amfResult?.stats || {};
    if (v.ctxFolder)  v.ctxFolder.textContent  = _folderName || _t('ctxNoFolder');
    if (v.ctxShots)   v.ctxShots.textContent   = _t('ctxShots',   {n: s.shots   ?? 0});
    if (v.ctxReady)   v.ctxReady.textContent   = _t('ctxReady',   {n: s.ready   ?? 0});
    if (v.ctxMissing) {
      v.ctxMissing.textContent   = (s.missing > 0) ? _t('ctxMissing', {n: s.missing}) : '';
      v.ctxMissing.style.display = (s.missing > 0) ? '' : 'none';
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function _updateSelMeta() {
    if (!v.shotList) return;
    const all = v.shotList.querySelectorAll('input.pl2-sl-check');
    const tot = all.length;
    let cnt = 0;
    all.forEach(cb => { if (cb.checked) cnt++; })
    if (v.selMeta) v.selMeta.textContent = cnt > 0 ? _t('selSelected', {n: cnt, m: tot}) : _t('selNone', {n: tot});
    if (v.selectAllCb) {
      v.selectAllCb.checked       = tot > 0 && cnt === tot;
      v.selectAllCb.indeterminate = cnt > 0 && cnt < tot;
    }
  }

  function _getSelectedResult() {
    if (!_amfResult) return null;
    const checked = Array.from(
      v.shotList?.querySelectorAll('input.pl2-sl-check:checked') || []
    );
    if (!checked.length) return _amfResult;
    const names = new Set(checked.map(cb => cb.dataset.shot || ''));
    return {
      ..._amfResult,
      shots: (_amfResult.shots || []).filter(s => names.has(s.shotName || s.name || s.shot || '')),
      stats: { shots: names.size, ready: 0, missing: 0 },
    };
  }

  // ── Progress ───────────────────────────────────────────────────────────────
  function _showProgress(pct, label) {
    if (v.progressWrap) v.progressWrap.style.display = '';
    if (v.progressBar)  v.progressBar.style.width = `${Math.max(2, pct)}%`;
    if (v.progressLabel && label) v.progressLabel.textContent = label;
    if (v.progressPct)  v.progressPct.textContent = `${Math.round(pct)}%`;
  }
  function _hideProgress() {
    if (v.progressWrap) v.progressWrap.style.display = 'none';
    if (v.progressBar)  v.progressBar.style.width = '0%';
  }

  /**
   * Ensure the AMF module has a writable handle for the VFX folder.
   * - Tries the saved IDB handle first (from drag-drop scan); requests readwrite permission.
   * - If unavailable, shows showDirectoryPicker once; saves for future exports.
   * Always sets AMF.setVfxDirHandle so the export writes directly to the folder.
   */
  async function _ensureExportHandle() {
    if (typeof AMF?.setVfxDirHandle !== 'function') return;
    // 1. Try restoring a handle already saved in IDB
    let handle = null;
    try { handle = await _loadDirHandle(); } catch {}
    if (handle) {
      try {
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') { AMF.setVfxDirHandle(handle); return; }
        const req = await handle.requestPermission({ mode: 'readwrite' });
        if (req === 'granted') { AMF.setVfxDirHandle(handle); return; }
      } catch {}
    }
    // 2. No usable handle — ask user to pick the VFX folder once
    if (typeof window.showDirectoryPicker !== 'function') return;
    try {
      handle = await window.showDirectoryPicker({ id: 'pl2-vfx-export', mode: 'readwrite' });
      if (handle) {
        await _saveDirHandle(handle);
        AMF.setVfxDirHandle(handle);
      }
    } catch {} // user cancelled → fall back to browser download
  }

  async function _runExport(fn) {
    _showProgress(0, _t('progressStarting'));

    // Hook MPS_setExportStatus to drive the progress bar
    const _orig = window.MPS_setExportStatus;
    window.MPS_setExportStatus = (state, main, sub) => {
      try { _orig?.(state, main, sub); } catch {}
      if (state === 'work') {
        const m = String(sub || '').match(/(\d+)\s*\/\s*(\d+)/);
        const pct = m && parseInt(m[2]) !== 0 ? Math.round(parseInt(m[1]) / parseInt(m[2]) * 100) : null;
        _showProgress(pct ?? 50, sub || main || _t('progressExporting'));
      } else if (state === 'ok') {
        _showProgress(100, _t('progressDone'));
      } else if (state === 'err') {
        if (v.progressBar) v.progressBar.style.background = '#e06c75';
        _showProgress(100, main || _t('progressError'));
      }
    };

    try {
      await fn();
      _showProgress(100, _t('progressDone'));
      setTimeout(_hideProgress, 1200);
    } catch (e) {
      if (v.progressBar) v.progressBar.style.background = '#e06c75';
      _showProgress(100, _t('progressFail'));
      setTimeout(() => {
        if (v.progressBar) v.progressBar.style.background = '';
        _hideProgress();
      }, 2000);
    } finally {
      window.MPS_setExportStatus = _orig;
      if (v.progressBar) v.progressBar.style.background = '';
    }
  }

  // ── Utils ──────────────────────────────────────────────────────────────────
  function _f2tc(frames) {
    if (typeof framesToTC === 'function') return framesToTC(frames, _fps);
    const f = frames % _fps, t = Math.floor(frames / _fps);
    const s = t % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    return `${_p(h)}:${_p(m)}:${_p(s)}:${_p(f)}`;
  }
  function _p(n) { return String(n).padStart(2, '0'); }
  function _he(s) {
    return String(s ?? '').replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );
  }
  function _showToast(msg, type = 'info') {
    if (msg && /err|error|warn|danger|fail/i.test(String(type || ''))) {
      try { msg = window.pfxFriendlyText ? window.pfxFriendlyText(msg) : msg; } catch (_) {}
    }
    const old = document.getElementById('pl2Toast');
    if (old) old.remove();
    const t = Object.assign(document.createElement('div'), {
      id: 'pl2Toast', className: `pl2-toast pl2-toast-${type}`, textContent: msg,
    });
    document.getElementById('main-platelink2')?.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ── Start Fresh / project reset ───────────────────────────────────────────
  function clear() {
    // 1. Stop + release video
    _videoAbort();

    // 2. Reset all module state
    _amfResult    = null;
    _files        = [];
    _folderName   = '';
    _fps          = 24;
    _activeShot   = '';
    _activeRowEl  = null;
    _filterText   = '';
    _filterStatus = 'all';
    _wasRestored  = false;
    _restoring    = false;
    _relinking    = false;
    _shotMap.clear();

    // 3. Wipe persisted result from localStorage
    try { localStorage.removeItem(_LS_RESULT_KEY); } catch {}

    // 4. Reset UI — shot list
    if (v.shotList) {
      v.shotList.innerHTML = '';
      if (v.slEmpty) {
        v.slEmpty.style.display = '';
        v.shotList.appendChild(v.slEmpty);
      }
    }

    // 5. Reset search input and filter pills
    if (v.searchInput) v.searchInput.value = '';
    document.querySelectorAll('#main-platelink2 .pl2-status-pill').forEach(btn => {
      btn.classList.toggle('pl2-filter-active', btn.dataset.status === 'all');
    });

    // 6. Reset select-all checkbox
    if (v.selectAllCb) { v.selectAllCb.checked = false; v.selectAllCb.indeterminate = false; }
    if (v.selMeta)     v.selMeta.textContent = '';

    // 7. Reset video / no-ref area
    _qtReset();
    _hideRelinkButton();

    // 8. Hide inspector, show empty state
    if (v.inspector) v.inspector.style.display = 'none';
    if (v.inspEmpty) v.inspEmpty.style.display  = '';

    // 9. Reset context bar
    _updateCtxBar();

    // 10. Hide progress bar
    _hideProgress();

    // 11. Close any open menus
    if (v.exportMenu)    v.exportMenu.style.display    = 'none';
    if (v.shotsListMenu) v.shotsListMenu.style.display = 'none';
  }

  return { mount, onTabActivated, clear };
}
