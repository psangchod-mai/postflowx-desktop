const $ = (sel) => document.querySelector(sel);

// Resolve the directory of this page so assetUrl() works whether bwav-inspector
// runs as a standalone extension or embedded under tools/bwav/ in PostFlowX.
function bwavBasePath(){
  try {
    const u = new URL(document.baseURI);
    return u.pathname.replace(/[^/]*$/, '');
  } catch (_) {}
  try {
    return location.pathname.replace(/[^/]*$/, '');
  } catch (_) {}
  return '/tools/bwav/';
}

function assetUrl(relPath){
  const clean = String(relPath || '').replace(/^\/?/, '');
  try {
    if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(bwavBasePath().replace(/^\//, '') + clean);
    if (globalThis.browser?.runtime?.getURL) return browser.runtime.getURL(bwavBasePath().replace(/^\//, '') + clean);
  } catch (_) {}
  try { return new URL(clean, document.baseURI).toString(); } catch (_) {}
  return clean;
}

function bgLog(activityType, meta={}){
  try {
    if (globalThis.chrome?.runtime?.sendMessage) chrome.runtime.sendMessage({ type: 'USERLOG', activityType, meta: meta||{} });
  } catch (_) {}
}


let currentMode = "backlot";
let report = {};
let simpleExpanded = false;
let lastFile = null;
let lastResult = null;
let lastExtracted = null;
let rulesCache = null;
let _kpiActiveStatus = "ALL";

// ---- i18n / Localization ----
const I18N = {
  en: {
    "ui.subtitle": "ADM label & metadata checks • Full-page inspector",
    "ui.mode": "Mode",
    "mode.backlot": "Backlot",
    "mode.dubbing": "Dubbing/AD",
    "mode.dme": "DME Extraction",
    "status.ready": "Ready.",
    "btn.clear": "Clear",
    "btn.copyJson": "Copy JSON",
    "btn.exportPdf": "Export PDF",
    "btn.exportJson": "Export JSON",
    "file.dropTitle": "Drop BWAV/BW64 or MXF here",
    "file.dropHint": "or click to browse",
    "ui.reportDetails": "Report details",
    "btn.runScan": "Run scan",
    "scan.quickFast": "Quick (fast)",
    "scan.fullSlow": "Full duration (slow)",
    "btn.cancel": "Cancel",
    "scan.quickNote": "Quick scans start+end. Full scans entire duration (slow).",
    "scan.notRun": "Not run",
    "simple.title": "Fix this first",
    "simple.sub": "Red = must fix. Yellow = check. Green = OK.",
    "btn.showAll": "Show all",
    "simple.emptyNoScan": "Run <b>Run scan</b> to see audio issues.",
    "ui.techDetails": "Technical details (advanced)",
    "labels.title": "Labels",
    "labels.sub": "Mapped group labels extracted from ADM (AXML).",
    "labels.search": "Search labels…",
    "labels.filter.all": "All",
    "labels.filter.allGroups": "All groups",
    "labels.th.status": "Status",
    "labels.th.raw": "Raw label",
    "labels.th.mapped": "Mapped",
    "labels.th.source": "Source",
    "labels.th.fix": "Fix",
    "labels.empty.noFile": "No file loaded.",
    "btn.showLess": "Show less",
    "btn.showAllCount": "Show all ({count})",
    "simple.moreNote": "Showing top {limit}. Click “Show all” for the full list.",
    "simple.allOk": "All checks look OK.",
    "labels.count": "{shown} shown / {total}",
    "labels.empty.none": "No label entries (AXML structure may be nonstandard / namespace).",
    "issue.wrongFileFormat": "Wrong file format",
    "issue.wrongFileFormat.detailFallback": "Format check failed",
    "issue.wrongFileFormat.fixWithAllowed": "Fix: Deliver the correct file. Expected channels: {allowed}.",
    "issue.wrongFileFormat.fixGeneric": "Fix: Deliver the correct file (codec / sample rate / channels).",
    "issue.tooLoudPeak": "Too loud (peak)",
    "issue.tooLoudPeak.detail": "Peak {peak} dBFS (limit {limit} dBFS)",
    "issue.tooLoudPeak.fix": "Fix: Turn down master / limiter and re-render.",
    "issue.clipping": "Clipping",
    "issue.clipping.detail": "{count} clipped samples found",
    "issue.clipping.fix": "Fix: Reduce level or repair clipping, then re-render.",
    "issue.digitalPops": "Digital pops / clicks",
    "issue.digitalPops.detail": "{count} possible pop(s)",
    "issue.digitalPops.fix": "Fix: Listen and repair pops/clicks (de-click / re-render).",
    "issue.channelTooSilent": "Channel is too silent",
    "issue.channelTooSilent.fix": "Fix: Check routing / missing stems (center, surrounds).",
    "issue.audioScanNotRun": "Audio scan not run",
    "issue.audioScanNotRun.detail": "Click “Run scan” to check peaks / clipping / pops / silence",
    "issue.labelingErrors": "Labeling errors",
    "issue.labelingErrors.detail": "{count} label(s) are REJECT",
    "issue.labelingErrors.fix": "Fix: Rename labels to the approved list (see Labels table).",
    "fmt.issue.codecNotAllowed": "Codec {codec} not allowed",
    "fmt.issue.floatNotAllowed": "Floating point not allowed",
    "fmt.issue.sampleRateNotAllowed": "Sample rate {rate} not allowed",
    "fmt.issue.bitDepthNotAllowed": "Bit depth {depth} not allowed",
    "fmt.issue.channelCountNotAllowed": "Channel count {count} not allowed",
    "fmt.issue.bitrateTooLow": "Bitrate {kbps} kbps < {min}",
    "silence.note.nearTotal": "Near-total silence (~{pct}%)",
    "silence.note.lr": "LR silence {pct}% > {limit}%",
    "silence.note.c": "C silence {pct}% > {limit}%",
    "silence.note.sur": "Surround silence {pct}% > {limit}%",
    "labels.fix.programmeNotGroup": "Not a bed/object group label. Fix: ignore audioProgrammeName in label QC (validate audioObject/audioContent only).",
    "labels.fix.packTechnical": "Technical pack name. Fix: ignore audioPackFormatName in label QC.",
    "labels.fix.channelIdentifier": "Channel identifier (not group). Fix: exclude audioTrackFormat/UID from group label QC.",
    "labels.fix.renameClosest": "Rename to a recognized {group} label (closest: \"{label}\").",
    "labels.fix.renameGeneric": "Rename to a recognized group label (Dialogue/Music/Effects/Narration).",

    "issue.atmosir.duplicateInputChannel": "Duplicate input channel",
    "issue.atmosir.duplicateInputChannel.detail": "Input channel {ch} is defined more than once.",
    "issue.atmosir.duplicateInputChannel.fix": "Fix: Ensure each input_channel is unique.",

    "issue.atmosir.badBedChannel": "Invalid bed channel mapping",
    "issue.atmosir.badBedChannel.detail": "Input channel {ch}: format {fmt} cannot use bed_channel_id \"{id}\".",
    "issue.atmosir.badBedChannel.fix": "Fix: Use valid IDs for {fmt}: {allowed}.",

    "issue.atmosir.invalidBrm": "Unknown binaural setting",
    "issue.atmosir.invalidBrm.detail": "Input channel {ch}: brm \"{brm}\" is not Off/Near/Mid/Far.",
    "issue.atmosir.invalidBrm.fix": "Fix: Set brm to off / near / mid / far.",

    "issue.atmosir.rerenderNoGroups": "Re-render has no groups",
    "issue.atmosir.rerenderNoGroups.detail": "Rerender \"{name}\" has an empty groups list.",
    "issue.atmosir.rerenderNoGroups.fix": "Fix: Assign one or more groups (e.g., All / Dialogue / Music / Effects).",

    "issue.atmosir.missingFullmix": "Missing full mix rerender",
    "issue.atmosir.missingFullmix.detail": "No rerender found that outputs groups: All.",
    "issue.atmosir.missingFullmix.fix": "Fix: Add a rerender with groups: [All].",

    "scan.na.atmosir": "Not applicable for .atmosIR"
  },

  ja: {
    "ui.subtitle": "ADM ラベル＆メタデータチェック • フルページ検査",
    "ui.mode": "モード",
    "mode.backlot": "Backlot",
    "mode.dubbing": "吹替/AD",
    "mode.dme": "DME 抽出",
    "status.ready": "準備完了。",
    "btn.clear": "クリア",
    "btn.copyJson": "JSONをコピー",
    "btn.exportPdf": "PDFを書き出し",
    "btn.exportJson": "JSONを書き出し",
    "file.dropTitle": "ここに BWAV/BW64 をドロップ",
    "file.dropHint": "またはクリックして選択",
    "ui.reportDetails": "レポート詳細",
    "btn.runScan": "スキャン実行",
    "scan.quickFast": "クイック（高速）",
    "scan.fullSlow": "全尺（低速）",
    "btn.cancel": "キャンセル",
    "scan.quickNote": "クイックは開始+終了のみ。全尺は全体（遅い）。",
    "scan.notRun": "未実行",
    "simple.title": "まずこれを修正",
    "simple.sub": "赤＝必須修正。黄＝要確認。緑＝OK。",
    "btn.showAll": "すべて表示",
    "simple.emptyNoScan": "<b>スキャン実行</b> を押して音声問題を表示。",
    "ui.techDetails": "技術詳細（上級）",
    "labels.title": "ラベル",
    "labels.sub": "ADM（AXML）から抽出したグループラベルのマッピング。",
    "labels.search": "ラベル検索…",
    "labels.filter.all": "すべて",
    "labels.filter.allGroups": "全グループ",
    "labels.th.status": "状態",
    "labels.th.raw": "元ラベル",
    "labels.th.mapped": "マップ結果",
    "labels.th.source": "ソース",
    "labels.th.fix": "修正",
    "labels.empty.noFile": "ファイルが読み込まれていません。",
    "btn.showLess": "折りたたむ",
    "btn.showAllCount": "すべて表示（{count}）",
    "simple.moreNote": "上位 {limit} 件を表示中。「すべて表示」で全件を確認できます。",
    "simple.allOk": "すべてのチェックは問題ありません。",
    "labels.count": "{shown} 件表示 / 全 {total} 件",
    "labels.empty.none": "ラベル項目がありません（AXML 構造/namespace が非標準の可能性）。",
    "issue.wrongFileFormat": "ファイル形式が不正",
    "issue.wrongFileFormat.detailFallback": "形式チェックに失敗",
    "issue.wrongFileFormat.fixWithAllowed": "修正: 正しいファイルを納品。想定チャンネル: {allowed}。",
    "issue.wrongFileFormat.fixGeneric": "修正: 正しいファイルを納品（コーデック/サンプルレート/チャンネル）。",
    "issue.tooLoudPeak": "音量が高すぎ（ピーク）",
    "issue.tooLoudPeak.detail": "Peak {peak} dBFS（上限 {limit} dBFS）",
    "issue.tooLoudPeak.fix": "修正: マスター/リミッターを下げて再レンダー。",
    "issue.clipping": "クリッピング",
    "issue.clipping.detail": "クリップしたサンプル {count} 件",
    "issue.clipping.fix": "修正: レベルを下げる/修復して再レンダー。",
    "issue.digitalPops": "デジタルポップ/クリック",
    "issue.digitalPops.detail": "{count} 件の可能性",
    "issue.digitalPops.fix": "修正: 聴取して pops/clicks を修復（de-click / 再レンダー）。",
    "issue.channelTooSilent": "チャンネルが静かすぎる",
    "issue.channelTooSilent.fix": "修正: ルーティング/欠落ステム（センター、サラウンド）を確認。",
    "issue.audioScanNotRun": "音声スキャン未実行",
    "issue.audioScanNotRun.detail": "「スキャン実行」で peak / clipping / pops / silence を確認",
    "issue.labelingErrors": "ラベル不備",
    "issue.labelingErrors.detail": "REJECT のラベル {count} 件",
    "issue.labelingErrors.fix": "修正: 承認リストに合わせてラベルを変更（Labels 表参照）。",
    "fmt.issue.codecNotAllowed": "コーデック {codec} は許可されていません",
    "fmt.issue.floatNotAllowed": "浮動小数点は許可されていません",
    "fmt.issue.sampleRateNotAllowed": "サンプルレート {rate} は許可されていません",
    "fmt.issue.bitDepthNotAllowed": "ビット深度 {depth} は許可されていません",
    "fmt.issue.channelCountNotAllowed": "チャンネル数 {count} は許可されていません",
    "fmt.issue.bitrateTooLow": "ビットレート {kbps} kbps < {min}",
    "silence.note.nearTotal": "ほぼ無音（約 {pct}%）",
    "silence.note.lr": "LR 無音 {pct}% > {limit}%",
    "silence.note.c": "C 無音 {pct}% > {limit}%",
    "silence.note.sur": "Surround 無音 {pct}% > {limit}%",
    "labels.fix.programmeNotGroup": "bed/object のグループラベルではありません。修正: label QC で audioProgrammeName を無視（audioObject/audioContent のみ検証）。",
    "labels.fix.packTechnical": "技術的な pack 名です。修正: label QC で audioPackFormatName を無視。",
    "labels.fix.channelIdentifier": "チャンネル識別子（グループではない）。修正: group label QC から audioTrackFormat/UID を除外。",
    "labels.fix.renameClosest": "認識される {group} ラベルに変更（最も近い: 「{label}」）。",
    "labels.fix.renameGeneric": "認識されるグループラベルに変更（Dialogue/Music/Effects/Narration）。",

    "issue.atmosir.duplicateInputChannel": "入力チャンネルが重複",
    "issue.atmosir.duplicateInputChannel.detail": "input_channel {ch} が複数回定義されています。",
    "issue.atmosir.duplicateInputChannel.fix": "修正: input_channel が一意になるようにしてください。",

    "issue.atmosir.badBedChannel": "Bed チャンネル割り当てが不正",
    "issue.atmosir.badBedChannel.detail": "input_channel {ch}: format {fmt} では bed_channel_id「{id}」は使用できません。",
    "issue.atmosir.badBedChannel.fix": "修正: {fmt} の有効ID: {allowed}。",

    "issue.atmosir.invalidBrm": "バイノーラル設定が不明",
    "issue.atmosir.invalidBrm.detail": "input_channel {ch}: brm「{brm}」は off/near/mid/far ではありません。",
    "issue.atmosir.invalidBrm.fix": "修正: brm を off / near / mid / far に設定。",

    "issue.atmosir.rerenderNoGroups": "Re-render にグループがありません",
    "issue.atmosir.rerenderNoGroups.detail": "Rerender「{name}」の groups が空です。",
    "issue.atmosir.rerenderNoGroups.fix": "修正: グループを割り当て（例: All / Dialogue / Music / Effects）。",

    "issue.atmosir.missingFullmix": "フルミックスの rerender がありません",
    "issue.atmosir.missingFullmix.detail": "groups: All を出力する rerender が見つかりません。",
    "issue.atmosir.missingFullmix.fix": "修正: groups: [All] の rerender を追加。",

    "scan.na.atmosir": ".atmosIR では使用不可"
  },

  ko: {
    "ui.subtitle": "ADM 라벨 및 메타데이터 검사 • 전체 페이지",
    "ui.mode": "모드",
    "mode.backlot": "Backlot",
    "mode.dubbing": "더빙/AD",
    "mode.dme": "DME 추출",
    "status.ready": "준비됨.",
    "btn.clear": "지우기",
    "btn.copyJson": "JSON 복사",
    "btn.exportPdf": "PDF 내보내기",
    "btn.exportJson": "JSON 내보내기",
    "file.dropTitle": "여기에 BWAV/BW64 드롭",
    "file.dropHint": "또는 클릭하여 선택",
    "ui.reportDetails": "보고서 상세",
    "btn.runScan": "스캔 실행",
    "scan.quickFast": "퀵(빠름)",
    "scan.fullSlow": "전체 길이(느림)",
    "btn.cancel": "취소",
    "scan.quickNote": "퀵 스캔은 시작+끝만. 전체 스캔은 전체 길이(느림).",
    "scan.notRun": "미실행",
    "simple.title": "먼저 이것부터 수정",
    "simple.sub": "빨강=반드시 수정. 노랑=확인. 초록=OK.",
    "btn.showAll": "모두 보기",
    "simple.emptyNoScan": "<b>스캔 실행</b>을 눌러 오디오 이슈를 확인하세요.",
    "ui.techDetails": "기술 상세(고급)",
    "labels.title": "라벨",
    "labels.sub": "ADM(AXML)에서 추출된 그룹 라벨 매핑.",
    "labels.search": "라벨 검색…",
    "labels.filter.all": "전체",
    "labels.filter.allGroups": "전체 그룹",
    "labels.th.status": "상태",
    "labels.th.raw": "원본 라벨",
    "labels.th.mapped": "매핑",
    "labels.th.source": "소스",
    "labels.th.fix": "수정",
    "labels.empty.noFile": "파일이 로드되지 않았습니다.",
    "btn.showLess": "접기",
    "btn.showAllCount": "모두 보기({count})",
    "simple.moreNote": "상위 {limit}개만 표시 중입니다. 전체를 보려면 “모두 보기”를 누르세요.",
    "simple.allOk": "모든 검사가 정상입니다.",
    "labels.count": "{shown}개 표시 / 전체 {total}개",
    "labels.empty.none": "라벨 항목이 없습니다(AXML 구조/namespace 비표준 가능).",
    "issue.wrongFileFormat": "파일 형식 오류",
    "issue.wrongFileFormat.detailFallback": "형식 검사 실패",
    "issue.wrongFileFormat.fixWithAllowed": "해결: 올바른 파일로 재납품. 예상 채널: {allowed}.",
    "issue.wrongFileFormat.fixGeneric": "해결: 올바른 파일로 재납품(코덱/샘플레이트/채널).",
    "issue.tooLoudPeak": "너무 큼(피크)",
    "issue.tooLoudPeak.detail": "Peak {peak} dBFS(한도 {limit} dBFS)",
    "issue.tooLoudPeak.fix": "해결: 마스터/리미터를 낮추고 재렌더.",
    "issue.clipping": "클리핑",
    "issue.clipping.detail": "클리핑 샘플 {count}개 발견",
    "issue.clipping.fix": "해결: 레벨을 낮추거나 클리핑을 복구 후 재렌더.",
    "issue.digitalPops": "디지털 팝/클릭",
    "issue.digitalPops.detail": "{count}개 가능",
    "issue.digitalPops.fix": "해결: 청취 후 pops/clicks 복구(de-click / 재렌더).",
    "issue.channelTooSilent": "채널이 너무 조용함",
    "issue.channelTooSilent.fix": "해결: 라우팅/누락 스템(센터, 서라운드) 확인.",
    "issue.audioScanNotRun": "오디오 스캔 미실행",
    "issue.audioScanNotRun.detail": "“스캔 실행”을 눌러 peak / clipping / pops / silence 확인",
    "issue.labelingErrors": "라벨 오류",
    "issue.labelingErrors.detail": "REJECT 라벨 {count}개",
    "issue.labelingErrors.fix": "해결: 승인된 목록으로 라벨 이름 변경(Labels 표 참조).",
    "fmt.issue.codecNotAllowed": "코덱 {codec} 허용 안 됨",
    "fmt.issue.floatNotAllowed": "부동소수점 허용 안 됨",
    "fmt.issue.sampleRateNotAllowed": "샘플레이트 {rate} 허용 안 됨",
    "fmt.issue.bitDepthNotAllowed": "비트뎁스 {depth} 허용 안 됨",
    "fmt.issue.channelCountNotAllowed": "채널 수 {count} 허용 안 됨",
    "fmt.issue.bitrateTooLow": "비트레이트 {kbps} kbps < {min}",
    "silence.note.nearTotal": "거의 무음(약 {pct}%)",
    "silence.note.lr": "LR 무음 {pct}% > {limit}%",
    "silence.note.c": "C 무음 {pct}% > {limit}%",
    "silence.note.sur": "Surround 무음 {pct}% > {limit}%",
    "labels.fix.programmeNotGroup": "bed/object 그룹 라벨이 아닙니다. 해결: label QC에서 audioProgrammeName 무시(audioObject/audioContent만 검증).",
    "labels.fix.packTechnical": "기술적 pack 이름입니다. 해결: label QC에서 audioPackFormatName 무시.",
    "labels.fix.channelIdentifier": "채널 식별자(그룹 아님). 해결: group label QC에서 audioTrackFormat/UID 제외.",
    "labels.fix.renameClosest": "인식되는 {group} 라벨로 변경(가장 가까움: \"{label}\").",
    "labels.fix.renameGeneric": "인식되는 그룹 라벨로 변경(Dialogue/Music/Effects/Narration).",

    "issue.atmosir.duplicateInputChannel": "입력 채널 중복",
    "issue.atmosir.duplicateInputChannel.detail": "input_channel {ch} 이(가) 두 번 이상 정의되었습니다.",
    "issue.atmosir.duplicateInputChannel.fix": "해결: input_channel이 고유하도록 수정하세요.",

    "issue.atmosir.badBedChannel": "Bed 채널 매핑 오류",
    "issue.atmosir.badBedChannel.detail": "input_channel {ch}: format {fmt}에서 bed_channel_id \"{id}\" 사용 불가.",
    "issue.atmosir.badBedChannel.fix": "해결: {fmt}의 유효 ID 사용: {allowed}.",

    "issue.atmosir.invalidBrm": "바이노럴 설정 알 수 없음",
    "issue.atmosir.invalidBrm.detail": "input_channel {ch}: brm \"{brm}\"은 off/near/mid/far 값이 아닙니다.",
    "issue.atmosir.invalidBrm.fix": "해결: brm을 off / near / mid / far로 설정.",

    "issue.atmosir.rerenderNoGroups": "리렌더 그룹 없음",
    "issue.atmosir.rerenderNoGroups.detail": "Rerender \"{name}\"의 groups가 비어 있습니다.",
    "issue.atmosir.rerenderNoGroups.fix": "해결: 그룹을 하나 이상 지정(예: All / Dialogue / Music / Effects).",

    "issue.atmosir.missingFullmix": "풀믹스 리렌더 없음",
    "issue.atmosir.missingFullmix.detail": "groups: All을 출력하는 rerender를 찾을 수 없습니다.",
    "issue.atmosir.missingFullmix.fix": "해결: groups: [All] rerender를 추가.",

    "scan.na.atmosir": ".atmosIR에는 해당 없음"
  },

  "zh-TW": {
    "ui.subtitle": "ADM 標籤與中繼資料檢查 • 全頁檢查器",
    "ui.mode": "模式",
    "mode.backlot": "Backlot",
    "mode.dubbing": "配音/口述",
    "mode.dme": "DME 擷取",
    "status.ready": "就緒。",
    "btn.clear": "清除",
    "btn.copyJson": "複製 JSON",
    "btn.exportPdf": "匯出 PDF",
    "btn.exportJson": "匯出 JSON",
    "file.dropTitle": "將 BWAV/BW64 拖放到這裡",
    "file.dropHint": "或點擊以選取",
    "ui.reportDetails": "報告詳細",
    "btn.runScan": "執行掃描",
    "scan.quickFast": "快速（快）",
    "scan.fullSlow": "全長（慢）",
    "btn.cancel": "取消",
    "scan.quickNote": "快速掃描只檢查開頭+結尾。全長掃描會跑完整段（較慢）。",
    "scan.notRun": "未執行",
    "simple.title": "先修這些",
    "simple.sub": "紅＝必須修正。黃＝需檢查。綠＝OK。",
    "btn.showAll": "顯示全部",
    "simple.emptyNoScan": "按 <b>執行掃描</b> 以查看音訊問題。",
    "ui.techDetails": "技術細節（進階）",
    "labels.title": "標籤",
    "labels.sub": "從 ADM（AXML）擷取並映射的群組標籤。",
    "labels.search": "搜尋標籤…",
    "labels.filter.all": "全部",
    "labels.filter.allGroups": "所有群組",
    "labels.th.status": "狀態",
    "labels.th.raw": "原始標籤",
    "labels.th.mapped": "映射",
    "labels.th.source": "來源",
    "labels.th.fix": "修正",
    "labels.empty.noFile": "尚未載入檔案。",
    "btn.showLess": "收合",
    "btn.showAllCount": "顯示全部（{count}）",
    "simple.moreNote": "目前只顯示前 {limit} 筆。按「顯示全部」查看完整清單。",
    "simple.allOk": "所有檢查皆正常。",
    "labels.count": "顯示 {shown} / 共 {total}",
    "labels.empty.none": "沒有標籤項目（AXML 結構/namespace 可能不標準）。",
    "issue.wrongFileFormat": "檔案格式錯誤",
    "issue.wrongFileFormat.detailFallback": "格式檢查失敗",
    "issue.wrongFileFormat.fixWithAllowed": "修正: 交付正確的檔案。預期聲道: {allowed}。",
    "issue.wrongFileFormat.fixGeneric": "修正: 交付正確的檔案（codec / sample rate / channels）。",
    "issue.tooLoudPeak": "過大（Peak）",
    "issue.tooLoudPeak.detail": "Peak {peak} dBFS（限制 {limit} dBFS）",
    "issue.tooLoudPeak.fix": "修正: 降低 master/limiter 後重新 render。",
    "issue.clipping": "Clipping",
    "issue.clipping.detail": "發現 {count} 個 clipping sample",
    "issue.clipping.fix": "修正: 降低電平或修復 clipping 後重新 render。",
    "issue.digitalPops": "數位爆音/點擊",
    "issue.digitalPops.detail": "可能有 {count} 個",
    "issue.digitalPops.fix": "修正: 聆聽並修復 pops/clicks（de-click / 重新 render）。",
    "issue.channelTooSilent": "聲道過於安靜",
    "issue.channelTooSilent.fix": "修正: 檢查 routing / 缺少 stems（center, surrounds）。",
    "issue.audioScanNotRun": "尚未執行音訊掃描",
    "issue.audioScanNotRun.detail": "按「執行掃描」檢查 peak / clipping / pops / silence",
    "issue.labelingErrors": "標籤錯誤",
    "issue.labelingErrors.detail": "{count} 個標籤為 REJECT",
    "issue.labelingErrors.fix": "修正: 將標籤名稱改為核准清單（見 Labels 表）。",
    "fmt.issue.codecNotAllowed": "不允許的 codec：{codec}",
    "fmt.issue.floatNotAllowed": "不允許浮點格式",
    "fmt.issue.sampleRateNotAllowed": "不允許的 sample rate：{rate}",
    "fmt.issue.bitDepthNotAllowed": "不允許的 bit depth：{depth}",
    "fmt.issue.channelCountNotAllowed": "不允許的聲道數：{count}",
    "fmt.issue.bitrateTooLow": "Bitrate {kbps} kbps < {min}",
    "silence.note.nearTotal": "幾乎全程無聲（約 {pct}%）",
    "silence.note.lr": "LR 無聲 {pct}% > {limit}%",
    "silence.note.c": "C 無聲 {pct}% > {limit}%",
    "silence.note.sur": "Surround 無聲 {pct}% > {limit}%",
    "labels.fix.programmeNotGroup": "這不是 bed/object 群組標籤。修正: 在 label QC 忽略 audioProgrammeName（只驗證 audioObject/audioContent）。",
    "labels.fix.packTechnical": "技術性 pack 名稱。修正: 在 label QC 忽略 audioPackFormatName。",
    "labels.fix.channelIdentifier": "聲道識別（不是群組）。修正: 從 group label QC 排除 audioTrackFormat/UID。",
    "labels.fix.renameClosest": "改名為可識別的 {group} 標籤（最接近：\"{label}\"）。",
    "labels.fix.renameGeneric": "改名為可識別的群組標籤（Dialogue/Music/Effects/Narration）。",

    "issue.atmosir.duplicateInputChannel": "輸入通道重複",
    "issue.atmosir.duplicateInputChannel.detail": "input_channel {ch} 被定義了多次。",
    "issue.atmosir.duplicateInputChannel.fix": "修正：確保每個 input_channel 都是唯一的。",

    "issue.atmosir.badBedChannel": "Bed 聲道對應不正確",
    "issue.atmosir.badBedChannel.detail": "input_channel {ch}：format {fmt} 不能使用 bed_channel_id「{id}」。",
    "issue.atmosir.badBedChannel.fix": "修正：{fmt} 可用的 ID：{allowed}。",

    "issue.atmosir.invalidBrm": "雙耳設定未知",
    "issue.atmosir.invalidBrm.detail": "input_channel {ch}：brm「{brm}」不是 off/near/mid/far。",
    "issue.atmosir.invalidBrm.fix": "修正：將 brm 設為 off / near / mid / far。",

    "issue.atmosir.rerenderNoGroups": "Re-render 未指定群組",
    "issue.atmosir.rerenderNoGroups.detail": "Rerender「{name}」的 groups 為空。",
    "issue.atmosir.rerenderNoGroups.fix": "修正：指定一個或多個群組（例如 All / Dialogue / Music / Effects）。",

    "issue.atmosir.missingFullmix": "缺少全混 rerender",
    "issue.atmosir.missingFullmix.detail": "找不到輸出 groups: All 的 rerender。",
    "issue.atmosir.missingFullmix.fix": "修正：新增 groups: [All] 的 rerender。",

    "scan.na.atmosir": "不適用於 .atmosIR"
  },

  id: {
    "ui.subtitle": "Pemeriksaan label & metadata ADM • Inspektor halaman penuh",
    "ui.mode": "Mode",
    "mode.backlot": "Backlot",
    "mode.dubbing": "Dubbing/AD",
    "mode.dme": "Ekstraksi DME",
    "status.ready": "Siap.",
    "btn.clear": "Hapus",
    "btn.copyJson": "Salin JSON",
    "btn.exportPdf": "Ekspor PDF",
    "btn.exportJson": "Ekspor JSON",
    "file.dropTitle": "Taruh BWAV/BW64 di sini",
    "file.dropHint": "atau klik untuk memilih",
    "ui.reportDetails": "Rincian laporan",
    "btn.runScan": "Jalankan pemindaian",
    "scan.quickFast": "Cepat",
    "scan.fullSlow": "Durasi penuh (lambat)",
    "btn.cancel": "Batal",
    "scan.quickNote": "Pemindaian cepat cek awal+akhir. Pemindaian penuh cek durasi penuh (lambat).",
    "scan.notRun": "Belum dijalankan",
    "simple.title": "Perbaiki ini dulu",
    "simple.sub": "Merah = harus diperbaiki. Kuning = periksa. Hijau = OK.",
    "btn.showAll": "Tampilkan semua",
    "simple.emptyNoScan": "Klik <b>Jalankan pemindaian</b> untuk melihat masalah audio.",
    "ui.techDetails": "Rincian teknis (lanjutan)",
    "labels.title": "Label",
    "labels.sub": "Pemetaan label grup yang diekstrak dari ADM (AXML).",
    "labels.search": "Cari label…",
    "labels.filter.all": "Semua",
    "labels.filter.allGroups": "Semua grup",
    "labels.th.status": "Status",
    "labels.th.raw": "Label asli",
    "labels.th.mapped": "Dipetakan",
    "labels.th.source": "Sumber",
    "labels.th.fix": "Perbaikan",
    "labels.empty.noFile": "Belum ada file dimuat.",
    "btn.showLess": "Tampilkan lebih sedikit",
    "btn.showAllCount": "Tampilkan semua ({count})",
    "simple.moreNote": "Menampilkan {limit} teratas. Klik “Tampilkan semua” untuk melihat semuanya.",
    "simple.allOk": "Semua pemeriksaan OK.",
    "labels.count": "{shown} ditampilkan / {total}",
    "labels.empty.none": "Tidak ada entri label (struktur AXML/namespace mungkin tidak standar).",
    "issue.wrongFileFormat": "Format file salah",
    "issue.wrongFileFormat.detailFallback": "Pemeriksaan format gagal",
    "issue.wrongFileFormat.fixWithAllowed": "Perbaikan: Kirim file yang benar. Kanal yang diharapkan: {allowed}.",
    "issue.wrongFileFormat.fixGeneric": "Perbaikan: Kirim file yang benar (codec / sample rate / channels).",
    "issue.tooLoudPeak": "Terlalu keras (peak)",
    "issue.tooLoudPeak.detail": "Peak {peak} dBFS (batas {limit} dBFS)",
    "issue.tooLoudPeak.fix": "Perbaikan: Turunkan master/limiter lalu render ulang.",
    "issue.clipping": "Clipping",
    "issue.clipping.detail": "Ditemukan {count} sample clipping",
    "issue.clipping.fix": "Perbaikan: Turunkan level atau perbaiki clipping, lalu render ulang.",
    "issue.digitalPops": "Pop/klik digital",
    "issue.digitalPops.detail": "{count} kemungkinan",
    "issue.digitalPops.fix": "Perbaikan: Dengarkan dan perbaiki pops/clicks (de-click / render ulang).",
    "issue.channelTooSilent": "Channel terlalu senyap",
    "issue.channelTooSilent.fix": "Perbaikan: Cek routing / stem hilang (center, surrounds).",
    "issue.audioScanNotRun": "Pemindaian audio belum dijalankan",
    "issue.audioScanNotRun.detail": "Klik “Jalankan pemindaian” untuk cek peak / clipping / pops / silence",
    "issue.labelingErrors": "Kesalahan label",
    "issue.labelingErrors.detail": "{count} label berstatus REJECT",
    "issue.labelingErrors.fix": "Perbaikan: Ganti nama label sesuai daftar yang disetujui (lihat tabel Labels).",
    "fmt.issue.codecNotAllowed": "Codec {codec} tidak diizinkan",
    "fmt.issue.floatNotAllowed": "Floating point tidak diizinkan",
    "fmt.issue.sampleRateNotAllowed": "Sample rate {rate} tidak diizinkan",
    "fmt.issue.bitDepthNotAllowed": "Bit depth {depth} tidak diizinkan",
    "fmt.issue.channelCountNotAllowed": "Jumlah channel {count} tidak diizinkan",
    "fmt.issue.bitrateTooLow": "Bitrate {kbps} kbps < {min}",
    "silence.note.nearTotal": "Hampir senyap total (~{pct}%)",
    "silence.note.lr": "LR senyap {pct}% > {limit}%",
    "silence.note.c": "C senyap {pct}% > {limit}%",
    "silence.note.sur": "Surround senyap {pct}% > {limit}%",
    "labels.fix.programmeNotGroup": "Bukan label grup bed/object. Perbaikan: abaikan audioProgrammeName pada QC label (validasi audioObject/audioContent saja).",
    "labels.fix.packTechnical": "Nama pack teknis. Perbaikan: abaikan audioPackFormatName pada QC label.",
    "labels.fix.channelIdentifier": "Identifier channel (bukan grup). Perbaikan: keluarkan audioTrackFormat/UID dari QC group label.",
    "labels.fix.renameClosest": "Ubah ke label {group} yang dikenali (terdekat: \"{label}\").",
    "labels.fix.renameGeneric": "Ubah ke label grup yang dikenali (Dialogue/Music/Effects/Narration).",

    "issue.atmosir.duplicateInputChannel": "Input channel duplikat",
    "issue.atmosir.duplicateInputChannel.detail": "input_channel {ch} didefinisikan lebih dari sekali.",
    "issue.atmosir.duplicateInputChannel.fix": "Perbaikan: Pastikan setiap input_channel unik.",

    "issue.atmosir.badBedChannel": "Pemetaan bed channel tidak valid",
    "issue.atmosir.badBedChannel.detail": "input_channel {ch}: format {fmt} tidak dapat memakai bed_channel_id \"{id}\".",
    "issue.atmosir.badBedChannel.fix": "Perbaikan: Gunakan ID valid untuk {fmt}: {allowed}.",

    "issue.atmosir.invalidBrm": "Setelan binaural tidak dikenali",
    "issue.atmosir.invalidBrm.detail": "input_channel {ch}: brm \"{brm}\" bukan off/near/mid/far.",
    "issue.atmosir.invalidBrm.fix": "Perbaikan: Set brm ke off / near / mid / far.",

    "issue.atmosir.rerenderNoGroups": "Re-render tanpa grup",
    "issue.atmosir.rerenderNoGroups.detail": "Rerender \"{name}\" memiliki daftar groups kosong.",
    "issue.atmosir.rerenderNoGroups.fix": "Perbaikan: Tetapkan satu atau lebih grup (mis. All / Dialogue / Music / Effects).",

    "issue.atmosir.missingFullmix": "Rerender full mix hilang",
    "issue.atmosir.missingFullmix.detail": "Tidak ada rerender yang mengeluarkan groups: All.",
    "issue.atmosir.missingFullmix.fix": "Perbaikan: Tambahkan rerender dengan groups: [All].",

    "scan.na.atmosir": "Tidak berlaku untuk .atmosIR"
  },

  th: {
    "ui.subtitle": "ตรวจ label และ metadata ของ ADM • หน้าตรวจแบบเต็ม",
    "ui.mode": "โหมด",
    "mode.backlot": "Backlot",
    "mode.dubbing": "พากย์/AD",
    "mode.dme": "ดึง DME",
    "status.ready": "พร้อมใช้งาน",
    "btn.clear": "ล้าง",
    "btn.copyJson": "คัดลอก JSON",
    "btn.exportPdf": "ส่งออก PDF",
    "btn.exportJson": "ส่งออก JSON",
    "file.dropTitle": "วาง BWAV/BW64 ที่นี่",
    "file.dropHint": "หรือคลิกเพื่อเลือกไฟล์",
    "ui.reportDetails": "รายละเอียดรายงาน",
    "btn.runScan": "เริ่มสแกน",
    "scan.quickFast": "ด่วน (เร็ว)",
    "scan.fullSlow": "ทั้งไฟล์ (ช้า)",
    "btn.cancel": "ยกเลิก",
    "scan.quickNote": "แบบด่วนสแกนแค่ต้น+ท้าย แบบเต็มสแกนทั้งไฟล์ (ช้า).",
    "scan.notRun": "ยังไม่รัน",
    "simple.title": "แก้สิ่งนี้ก่อน",
    "simple.sub": "แดง = ต้องแก้. เหลือง = ตรวจสอบ. เขียว = OK.",
    "btn.showAll": "แสดงทั้งหมด",
    "simple.emptyNoScan": "กด <b>เริ่มสแกน</b> เพื่อดูปัญหาเสียง",
    "ui.techDetails": "รายละเอียดเทคนิค (ขั้นสูง)",
    "labels.title": "Labels",
    "labels.sub": "ตาราง mapping group label ที่อ่านจาก ADM (AXML).",
    "labels.search": "ค้นหา labels…",
    "labels.filter.all": "ทั้งหมด",
    "labels.filter.allGroups": "ทุกกลุ่ม",
    "labels.th.status": "สถานะ",
    "labels.th.raw": "Raw label",
    "labels.th.mapped": "Mapped",
    "labels.th.source": "Source",
    "labels.th.fix": "Fix",
    "labels.empty.noFile": "ยังไม่ได้โหลดไฟล์",
    "btn.showLess": "แสดงน้อยลง",
    "btn.showAllCount": "แสดงทั้งหมด ({count})",
    "simple.moreNote": "แสดง {limit} รายการแรก คลิก “แสดงทั้งหมด” เพื่อดูครบทั้งหมด",
    "simple.allOk": "ผลตรวจทั้งหมดปกติ",
    "labels.count": "แสดง {shown} / {total}",
    "labels.empty.none": "ไม่พบรายการ label (โครงสร้าง AXML อาจไม่มาตรฐาน / namespace)",
    "issue.wrongFileFormat": "ไฟล์ผิดฟอร์แมต",
    "issue.wrongFileFormat.detailFallback": "ตรวจฟอร์แมตไม่ผ่าน",
    "issue.wrongFileFormat.fixWithAllowed": "วิธีแก้: ส่งไฟล์ที่ถูกต้อง ช่องที่รองรับ: {allowed}",
    "issue.wrongFileFormat.fixGeneric": "วิธีแก้: ส่งไฟล์ที่ถูกต้อง (codec / sample rate / จำนวนช่องสัญญาณ)",
    "issue.tooLoudPeak": "ดังเกินไป (Peak)",
    "issue.tooLoudPeak.detail": "Peak {peak} dBFS (จำกัด {limit} dBFS)",
    "issue.tooLoudPeak.fix": "วิธีแก้: ลดระดับ master/limiter แล้ว render ใหม่",
    "issue.clipping": "Clipping",
    "issue.clipping.detail": "พบ sample clipping {count} ตัว",
    "issue.clipping.fix": "วิธีแก้: ลดระดับหรือแก้ clipping แล้ว render ใหม่",
    "issue.digitalPops": "มีเสียงป๊อป/คลิก",
    "issue.digitalPops.detail": "อาจมี {count} จุด",
    "issue.digitalPops.fix": "วิธีแก้: ฟังแล้วแก้ pops/clicks (de-click / render ใหม่)",
    "issue.channelTooSilent": "ช่องสัญญาณเงียบเกินไป",
    "issue.channelTooSilent.fix": "วิธีแก้: เช็ค routing / stem หาย (center, surrounds)",
    "issue.audioScanNotRun": "ยังไม่ได้สแกนออดิโอ",
    "issue.audioScanNotRun.detail": "กด “เริ่มสแกน” เพื่อเช็ค peak / clipping / pops / silence",
    "issue.labelingErrors": "ชื่อ Label ไม่ถูกต้อง",
    "issue.labelingErrors.detail": "{count} label เป็น REJECT",
    "issue.labelingErrors.fix": "วิธีแก้: เปลี่ยนชื่อ label ให้ตรงรายการที่อนุมัติ (ดูตาราง Labels)",
    "fmt.issue.codecNotAllowed": "Codec {codec} ไม่อนุญาต",
    "fmt.issue.floatNotAllowed": "ไม่อนุญาต Floating point",
    "fmt.issue.sampleRateNotAllowed": "Sample rate {rate} ไม่อนุญาต",
    "fmt.issue.bitDepthNotAllowed": "Bit depth {depth} ไม่อนุญาต",
    "fmt.issue.channelCountNotAllowed": "จำนวนช่อง {count} ไม่อนุญาต",
    "fmt.issue.bitrateTooLow": "Bitrate {kbps} kbps < {min}",
    "silence.note.nearTotal": "เงียบเกือบทั้งไฟล์ (~{pct}%)",
    "silence.note.lr": "LR เงียบ {pct}% > {limit}%",
    "silence.note.c": "C เงียบ {pct}% > {limit}%",
    "silence.note.sur": "Surround เงียบ {pct}% > {limit}%",
    "labels.fix.programmeNotGroup": "ไม่ใช่ชื่อกลุ่ม bed/object. วิธีแก้: ไม่ต้องเช็ค audioProgrammeName ใน label QC (เช็คเฉพาะ audioObject/audioContent)",
    "labels.fix.packTechnical": "ชื่อ technical pack. วิธีแก้: ไม่ต้องเช็ค audioPackFormatName ใน label QC",
    "labels.fix.channelIdentifier": "เป็นชื่อ channel (ไม่ใช่กลุ่ม). วิธีแก้: ตัด audioTrackFormat/UID ออกจากการเช็ค group label",
    "labels.fix.renameClosest": "เปลี่ยนชื่อให้เป็น label ที่ยอมรับในกลุ่ม {group} (ใกล้เคียง: \"{label}\")",
    "labels.fix.renameGeneric": "เปลี่ยนชื่อให้เป็น label ที่ยอมรับ (Dialogue/Music/Effects/Narration)",

    "issue.atmosir.duplicateInputChannel": "ช่องอินพุตซ้ำ",
    "issue.atmosir.duplicateInputChannel.detail": "input_channel {ch} ถูกกำหนดซ้ำมากกว่า 1 ครั้ง",
    "issue.atmosir.duplicateInputChannel.fix": "วิธีแก้: ให้แต่ละ input_channel ไม่ซ้ำกัน",

    "issue.atmosir.badBedChannel": "การแมป bed channel ไม่ถูกต้อง",
    "issue.atmosir.badBedChannel.detail": "input_channel {ch}: format {fmt} ใช้ bed_channel_id \"{id}\" ไม่ได้",
    "issue.atmosir.badBedChannel.fix": "วิธีแก้: ใช้ ID ที่ถูกต้องสำหรับ {fmt}: {allowed}",

    "issue.atmosir.invalidBrm": "ค่า binaural ไม่รู้จัก",
    "issue.atmosir.invalidBrm.detail": "input_channel {ch}: brm \"{brm}\" ไม่ใช่ off/near/mid/far",
    "issue.atmosir.invalidBrm.fix": "วิธีแก้: ตั้ง brm เป็น off / near / mid / far",

    "issue.atmosir.rerenderNoGroups": "Re-render ไม่มีการเลือกกลุ่ม",
    "issue.atmosir.rerenderNoGroups.detail": "Rerender \"{name}\" มี groups ว่าง",
    "issue.atmosir.rerenderNoGroups.fix": "วิธีแก้: เลือกอย่างน้อย 1 กลุ่ม (เช่น All / Dialogue / Music / Effects)",

    "issue.atmosir.missingFullmix": "ไม่มี rerender แบบ Full mix",
    "issue.atmosir.missingFullmix.detail": "ไม่พบ rerender ที่ outputs groups: All",
    "issue.atmosir.missingFullmix.fix": "วิธีแก้: เพิ่ม rerender ที่ groups: [All]",

    "scan.na.atmosir": "ใช้ไม่ได้กับ .atmosIR"
  }
};

const SUPPORTED_LOCALES = ["en","ja","ko","zh-TW","id","th"];
let currentLocale = "en";

function normalizeLocale(raw){
  if (!raw) return "en";
  const s = String(raw).toLowerCase();
  if (s.startsWith("ja")) return "ja";
  if (s.startsWith("ko")) return "ko";
  if (s.startsWith("th")) return "th";
  if (s.startsWith("id")) return "id";
  if (s.startsWith("zh")) return "zh-TW";
  return "en";
}

function t(key){
  return (I18N[currentLocale] && I18N[currentLocale][key])
    || (I18N.en && I18N.en[key])
    || key;
}

function tWithLocale(locale, key){
  return (I18N[locale] && I18N[locale][key])
    || (I18N.en && I18N.en[key])
    || key;
}

function tFmt(key, vars){
  let s = t(key);
  if (vars) {
    for (const [k,v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

function tFmtWithLocale(locale, key, vars){
  let s = tWithLocale(locale, key);
  if (vars) {
    for (const [k,v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

function applyLocale(locale){
  currentLocale = SUPPORTED_LOCALES.includes(locale) ? locale : "en";
  try { localStorage.setItem("bwav_locale", currentLocale); } catch {}
  document.documentElement.lang = currentLocale;

  // data-i18n (text)
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const k = el.getAttribute("data-i18n");
    el.textContent = t(k);
  });

  // data-i18n-html (innerHTML)
  document.querySelectorAll("[data-i18n-html]").forEach(el => {
    const k = el.getAttribute("data-i18n-html");
    el.innerHTML = t(k);
  });

  // data-i18n-placeholder
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const k = el.getAttribute("data-i18n-placeholder");
    el.setAttribute("placeholder", t(k));
  });

  // Re-render dynamic UI that isn't covered by data-i18n
  try {
    if (lastResult) {
      try { applyLabelFilters(); } catch {}
    }
  } catch {}

}

function initLocaleUI(){
  const sel = document.getElementById("localeSelect");
  let saved = null;
  try { saved = localStorage.getItem("bwav_locale"); } catch {}
  const guess = normalizeLocale((navigator.languages && navigator.languages[0]) || navigator.language);
  const initial = saved || guess || "en";

  if (sel){
    sel.value = SUPPORTED_LOCALES.includes(initial) ? initial : "en";
    sel.addEventListener("change", ()=> applyLocale(sel.value));
  }
  applyLocale(SUPPORTED_LOCALES.includes(initial) ? initial : "en");
}
// ---- end i18n ----


async function loadRules() {
  // Label-only build: load only label mapping rules.
  const [atmResp, labelsResp] = await Promise.all([
    fetch(assetUrl("data/atmosLabelConfiguration.json")),
    fetch(assetUrl("data/netflix_recognized_group_labels.json")),
  ]);
  const atm = await atmResp.json();
  let labelsFallback = await labelsResp.json();
  // Optional override synced from Sheet
  try {
    const st = await chrome.storage.local.get({ groupLabelsOverride: null });
    if (st && st.groupLabelsOverride && typeof st.groupLabelsOverride === 'object') {
      labelsFallback = st.groupLabelsOverride;
    }
  } catch {}
  const labels = (atm && Array.isArray(atm.validAudioContentGroups)) ? atm : labelsFallback;
  return { labels };
}



function dbfsFromAmp(a){
  if (!a || a <= 0) return -Infinity;
  return 20 * Math.log10(a);
}

function evalMediaFormat(fmtInfo, cfg){
  const issues = [];
  const issueInfo = [];
  if (!fmtInfo) return { pass:false, issues:["Missing fmt chunk"], issueInfo:[], summary:"Missing fmt" };
  const audioFormat = fmtInfo.audioFormat;
  const codec = (audioFormat === 1) ? "LPCM" : (audioFormat === 3 ? "FLOAT" : `WAV(${audioFormat})`);
  const ch = fmtInfo.numChannels || 0;
  const sr = fmtInfo.sampleRate || 0;
  const bd = fmtInfo.bitsPerSample || 0;

  const kbps = (sr && bd && ch) ? (sr * bd * ch / 1000) : 0;

  const allowedCodec = (cfg?.allowedCodecs || []).map(String);
  if (allowedCodec.length && !allowedCodec.includes(codec)) {
    issues.push(`Codec ${codec} not allowed`);
    issueInfo.push({ key: "fmt.issue.codecNotAllowed", vars: { codec } });
  }

  if (audioFormat === 3 && cfg?.floatingPointAllowed === false) {
    issues.push("Floating point not allowed");
    issueInfo.push({ key: "fmt.issue.floatNotAllowed", vars: {} });
  }

  const allowedSR = cfg?.allowedSampleRate || [];
  if (allowedSR.length && !allowedSR.includes(sr)) {
    issues.push(`Sample rate ${sr} not allowed`);
    issueInfo.push({ key: "fmt.issue.sampleRateNotAllowed", vars: { rate: sr } });
  }

  const allowedBD = cfg?.allowedPCMBitDepth || [];
  if (allowedBD.length && !allowedBD.includes(bd)) {
    issues.push(`Bit depth ${bd} not allowed`);
    issueInfo.push({ key: "fmt.issue.bitDepthNotAllowed", vars: { depth: bd } });
  }

  const allowedCh = new Set([...(cfg?.allowedChannelCount||[]), ...((cfg?.extraSupportedChannelMappings)||[])]);
  if (allowedCh.size && !allowedCh.has(ch)) {
    issues.push(`Channel count ${ch} not allowed`);
    issueInfo.push({ key: "fmt.issue.channelCountNotAllowed", vars: { count: ch } });
  }

  if (cfg?.minBitRate && kbps && kbps < cfg.minBitRate) {
    issues.push(`Bitrate ${kbps.toFixed(0)} kbps < ${cfg.minBitRate}`);
    issueInfo.push({ key: "fmt.issue.bitrateTooLow", vars: { kbps: kbps.toFixed(0), min: cfg.minBitRate } });
  }

  const pass = issues.length === 0;
  const summary = pass ? `PASS • ${codec} • ${ch}ch @ ${sr}Hz • ${bd}-bit` : `FAIL • ${issues[0]}`;
  return { pass, codec, channels: ch, sampleRate: sr, bitDepth: bd, bitRateKbps: kbps, issues, issueInfo, summary };
}

function channelLayoutGroups(ch){
  // Approx standard order for 2/6/8. For others, best-effort.
  if (ch === 2) return { LR:[0,1], C:[], LFE:[], Surround:[] };
  if (ch === 6) return { LR:[0,1], C:[2], LFE:[3], Surround:[4,5] };
  if (ch === 8) return { LR:[0,1], C:[2], LFE:[3], Surround:[4,5,6,7] };
  if (ch === 10) return { LR:[0,1], C:[2], LFE:[3], Surround:[4,5,6,7], Height:[8,9] };
  return { LR:[0,1].filter(i=>i<ch), C:[2].filter(i=>i<ch), LFE:[3].filter(i=>i<ch), Surround:Array.from({length:Math.max(0,ch-4)},(_,i)=>i+4) };
}

async function runAudioScanQuick(file, extracted, cfgs, onMsg){
  const loudCfg = cfgs?.loudness || {};
  const clipCfg = cfgs?.clipping || {};
  const hitCfg = cfgs?.digitalHits || {};
  const silCfg = cfgs?.silence || {};

  const fmtInfo = extracted?.fmtInfo;
  const dataChunk = extracted?.dataChunk;
  if (!fmtInfo || !dataChunk) return { error: "No audio data chunk info available." };

  if (fmtInfo.audioFormat !== 1) {
    return { error: `AudioFormat ${fmtInfo.audioFormat} not supported for scan (PCM only).` };
  }

  const ch = fmtInfo.numChannels || 0;
  const sr = fmtInfo.sampleRate || 0;
  const bd = fmtInfo.bitsPerSample || 0;
  const bps = bd / 8;
  if (![2,3,4].includes(bps)) return { error: `Unsupported bit depth ${bd}` };
  const frameSize = ch * bps;
  if (!frameSize || !sr) return { error: "Invalid PCM format" };

  const MAX_BYTES = 40 * 1024 * 1024;
  const half = Math.floor(MAX_BYTES / 2);

  const windows = [];
  const startOff = dataChunk.offset;
  const startSize = Math.min(half, dataChunk.size);
  windows.push({ off: startOff, size: startSize, label: "start" });

  if (dataChunk.size > startSize + 1024) {
    const endSize = Math.min(half, dataChunk.size - startSize);
    const endOff = dataChunk.offset + dataChunk.size - endSize;
    if (endOff > startOff) windows.push({ off: endOff, size: endSize, label: "end" });
  }

  const absMax = new Array(ch).fill(0);
  const prev = new Array(ch).fill(0);
  const silentCount = new Array(ch).fill(0);
  const totalCount = new Array(ch).fill(0);

  const clipThr = (typeof clipCfg.repeatedClippingNearFullscaleThreshold === "number") ? clipCfg.repeatedClippingNearFullscaleThreshold : 0.95;
  const clipSamples = new Array(ch).fill(0);
  const clipRuns = new Array(ch).fill(0);
  const clipRunStart = new Array(ch).fill(0);
  const clipSegments = Array.from({length:ch}, ()=>[]);
  const maxSeg = clipCfg.maxClippedSegmentsToReportPerChannel || 3;

  const hits = [];
  const maxHits = hitCfg.maximumNumberHitsReported || 10;
  const silenceThr = 0.0005; // ~ -66 dBFS

  let scannedBytes = 0;
  let scannedFrames = 0;

  const decodeSample = (u8, i) => {
    if (bd === 16) {
      const v = (u8[i] | (u8[i+1] << 8));
      const s = (v & 0x8000) ? v - 0x10000 : v;
      return s / 32768;
    }
    if (bd === 24) {
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16));
      if (v & 0x800000) v = v - 0x1000000;
      return v / 8388608;
    }
    if (bd === 32) {
      // PCM 32-bit int
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16) | (u8[i+3] << 24));
      return v / 2147483648;
    }
    return 0;
  };

  for (const w of windows) {
    onMsg?.(`Scanning audio (${w.label})…`);
    const buf = await file.slice(w.off, w.off + w.size).arrayBuffer();
    const u8 = new Uint8Array(buf);
    scannedBytes += u8.byteLength;

    const frames = Math.floor(u8.length / frameSize);
    for (let f = 0; f < frames; f++) {
      const base = f * frameSize;
      scannedFrames += 1;
      for (let c = 0; c < ch; c++) {
        const si = base + c * bps;
        const s = decodeSample(u8, si);
        const a = Math.abs(s);
        if (a > absMax[c]) absMax[c] = a;

        // silence
        totalCount[c] += 1;
        if (a < silenceThr) silentCount[c] += 1;

        // clipping samples + segments
        if (a >= clipThr) {
          clipSamples[c] += 1;
          if (clipRuns[c] === 0) clipRunStart[c] = scannedFrames;
          clipRuns[c] += 1;
        } else if (clipRuns[c] > 0) {
          if (clipSegments[c].length < maxSeg) {
            clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
          }
          clipRuns[c] = 0;
        }

        // digital hits heuristic
        const d = Math.abs(s - prev[c]);
        if (hits.length < maxHits && d > 0.8 && a > 0.6 && Math.abs(prev[c]) < 0.2) {
          hits.push({ channel: c+1, frame: scannedFrames, timeSec: scannedFrames / sr, delta: d });
        }
        prev[c] = s;
      }
    }
  }

  // flush clip runs
  for (let c = 0; c < ch; c++) {
    if (clipRuns[c] > 0 && clipSegments[c].length < maxSeg) {
      clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
    }
  }

  const overallMax = Math.max(...absMax);
  const samplePeakDb = dbfsFromAmp(overallMax);
  const truePeakDbEst = samplePeakDb; // MVP
  const scannedSeconds = scannedFrames / sr;

  const clipTotal = clipSamples.reduce((a,b)=>a+b,0);
  const clipError = (clipCfg.statisticalClippingErrorThreshold != null) ? (clipTotal > clipCfg.statisticalClippingErrorThreshold) : false;

  const layout = channelLayoutGroups(ch);
  const pct = (arrIdx) => {
    if (!arrIdx.length) return null;
    let s=0,t=0;
    for (const i of arrIdx) { s += silentCount[i] || 0; t += totalCount[i] || 0; }
    return t ? (100*s/t) : null;
  };
  const lrPct = pct(layout.LR);
  const cPct = pct(layout.C);
  const surPct = pct(layout.Surround);
  const overallPct = (totalCount.reduce((a,b)=>a+b,0)) ? (100*silentCount.reduce((a,b)=>a+b,0)/totalCount.reduce((a,b)=>a+b,0)) : null;

  const silenceNotes = [];
  const silenceNoteInfo = [];
  if (overallPct != null && overallPct >= (silCfg.nearTotalSilence ?? 99)) {
    silenceNotes.push(`Near-total silence (~${overallPct.toFixed(1)}%)`);
    silenceNoteInfo.push({ key: "silence.note.nearTotal", vars: { pct: overallPct.toFixed(1) } });
  }
  if (lrPct != null && silCfg.allowedLRChannelSilencePercent != null && lrPct > silCfg.allowedLRChannelSilencePercent) {
    silenceNotes.push(`LR silence ${lrPct.toFixed(1)}% > ${silCfg.allowedLRChannelSilencePercent}%`);
    silenceNoteInfo.push({ key: "silence.note.lr", vars: { pct: lrPct.toFixed(1), limit: silCfg.allowedLRChannelSilencePercent } });
  }
  if (cPct != null && silCfg.allowedCenterChannelSilencePercent != null && cPct > silCfg.allowedCenterChannelSilencePercent) {
    silenceNotes.push(`C silence ${cPct.toFixed(1)}% > ${silCfg.allowedCenterChannelSilencePercent}%`);
    silenceNoteInfo.push({ key: "silence.note.c", vars: { pct: cPct.toFixed(1), limit: silCfg.allowedCenterChannelSilencePercent } });
  }
  if (surPct != null && silCfg.allowedSurroundChannelSilencePercent != null && surPct > silCfg.allowedSurroundChannelSilencePercent) {
    silenceNotes.push(`Surround silence ${surPct.toFixed(1)}% > ${silCfg.allowedSurroundChannelSilencePercent}%`);
    silenceNoteInfo.push({ key: "silence.note.sur", vars: { pct: surPct.toFixed(1), limit: silCfg.allowedSurroundChannelSilencePercent } });
  }

  const peakViol = (isFinite(samplePeakDb) && loudCfg.maxSamplePeakDBFS != null) ? (samplePeakDb > loudCfg.maxSamplePeakDBFS) : false;
  const tpViol = (isFinite(truePeakDbEst) && loudCfg.maxTruePeakDBFS != null) ? (truePeakDbEst > loudCfg.maxTruePeakDBFS) : false;

  return {
    scannedSeconds,
    scannedBytes,
    samplePeakDbfs: samplePeakDb,
    truePeakDbfsEst: truePeakDbEst,
    peakViolation: peakViol,
    truePeakViolation: tpViol,
    clipping: { clippedSamples: clipTotal, error: clipError, threshold: clipCfg.statisticalClippingErrorThreshold ?? null, segmentsPerChannel: clipSegments },
    digitalHits: { count: hits.length, examples: hits },
    silence: { overallPercent: overallPct, lrPercent: lrPct, cPercent: cPct, surroundPercent: surPct, notes: silenceNotes, noteInfo: silenceNoteInfo },
  };
}


async function runAudioScanFull(file, extracted, cfgs, onMsg, onProgress, isCancelled){
  const loudCfg = cfgs?.loudness || {};
  const clipCfg = cfgs?.clipping || {};
  const hitCfg = cfgs?.digitalHits || {};
  const silCfg = cfgs?.silence || {};

  const fmtInfo = extracted?.fmtInfo;
  const dataChunk = extracted?.dataChunk;
  if (!fmtInfo || !dataChunk) return { error: "No audio data chunk info available." };

  if (fmtInfo.audioFormat !== 1) {
    return { error: `AudioFormat ${fmtInfo.audioFormat} not supported for scan (PCM only).` };
  }

  const ch = fmtInfo.numChannels || 0;
  const sr = fmtInfo.sampleRate || 0;
  const bd = fmtInfo.bitsPerSample || 0;
  const bps = bd / 8;
  if (![2,3,4].includes(bps)) return { error: `Unsupported bit depth ${bd}` };
  const frameSize = ch * bps;
  if (!frameSize || !sr) return { error: "Invalid PCM format" };

  // Accumulators (same as quick)
  const absMax = new Array(ch).fill(0);
  const prev = new Array(ch).fill(0);
  const silentCount = new Array(ch).fill(0);
  const totalCount = new Array(ch).fill(0);

  const clipThr = (typeof clipCfg.repeatedClippingNearFullscaleThreshold === "number") ? clipCfg.repeatedClippingNearFullscaleThreshold : 0.95;
  const clipSamples = new Array(ch).fill(0);
  const clipRuns = new Array(ch).fill(0);
  const clipRunStart = new Array(ch).fill(0);
  const clipSegments = Array.from({length:ch}, ()=>[]);
  const maxSeg = clipCfg.maxClippedSegmentsToReportPerChannel || 3;

  const hits = [];
  const maxHits = hitCfg.maximumNumberHitsReported || 10;
  const silenceThr = 0.0005; // ~ -66 dBFS

  let scannedBytes = 0;
  let scannedFrames = 0;

  const decodeSample = (u8, i) => {
    if (bd === 16) {
      const v = (u8[i] | (u8[i+1] << 8));
      const s = (v & 0x8000) ? v - 0x10000 : v;
      return s / 32768;
    }
    if (bd === 24) {
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16));
      if (v & 0x800000) v = v - 0x1000000;
      return v / 8388608;
    }
    if (bd === 32) {
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16) | (u8[i+3] << 24));
      return v / 2147483648;
    }
    return 0;
  };

  // Stream over entire data chunk in manageable blocks
  const totalBytes = Number(dataChunk.size || 0);
  const startOff = Number(dataChunk.offset || 0);
  const BLOCK = 8 * 1024 * 1024; // 8 MB
  let off = 0;

  let carry = new Uint8Array(0);

  onMsg?.("Scanning audio (full) …");

  while (off < totalBytes) {
    if (isCancelled?.()) return { cancelled: true, scannedSeconds: scannedFrames / sr, scannedBytes };

    const take = Math.min(BLOCK, totalBytes - off);
    const buf = await file.slice(startOff + off, startOff + off + take).arrayBuffer();
    let u8 = new Uint8Array(buf);
    scannedBytes += u8.byteLength;

    // Prepend carry if we had leftover bytes from last block
    if (carry.length) {
      const merged = new Uint8Array(carry.length + u8.length);
      merged.set(carry, 0);
      merged.set(u8, carry.length);
      u8 = merged;
      carry = new Uint8Array(0);
    }

    const frames = Math.floor(u8.length / frameSize);
    const usable = frames * frameSize;
    if (usable < u8.length) carry = u8.slice(usable);

    for (let f = 0; f < frames; f++) {
      const base = f * frameSize;
      scannedFrames += 1;
      for (let c = 0; c < ch; c++) {
        const si = base + c * bps;
        const s = decodeSample(u8, si);
        const a = Math.abs(s);
        if (a > absMax[c]) absMax[c] = a;

        totalCount[c] += 1;
        if (a < silenceThr) silentCount[c] += 1;

        if (a >= clipThr) {
          clipSamples[c] += 1;
          if (clipRuns[c] === 0) clipRunStart[c] = scannedFrames;
          clipRuns[c] += 1;
        } else if (clipRuns[c] > 0) {
          if (clipSegments[c].length < maxSeg) {
            clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
          }
          clipRuns[c] = 0;
        }

        const d = Math.abs(s - prev[c]);
        if (hits.length < maxHits && d > 0.8 && a > 0.6 && Math.abs(prev[c]) < 0.2) {
          hits.push({ channel: c+1, frame: scannedFrames, timeSec: scannedFrames / sr, delta: d });
        }
        prev[c] = s;
      }
    }

    off += take;

    if (typeof onProgress === "function") {
      const pct = totalBytes ? Math.min(100, (100 * off / totalBytes)) : 0;
      onProgress(pct, scannedFrames / sr);
    }
    // Yield to UI
    await new Promise(r => setTimeout(r, 0));
  }

  // flush clip runs
  for (let c = 0; c < ch; c++) {
    if (clipRuns[c] > 0 && clipSegments[c].length < maxSeg) {
      clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
    }
  }

  const overallMax = Math.max(...absMax);
  const samplePeakDb = dbfsFromAmp(overallMax);
  const truePeakDbEst = samplePeakDb; // MVP
  const scannedSeconds = scannedFrames / sr;

  const clipTotal = clipSamples.reduce((a,b)=>a+b,0);
  const clipError = (clipCfg.statisticalClippingErrorThreshold != null) ? (clipTotal > clipCfg.statisticalClippingErrorThreshold) : false;

  const layout = channelLayoutGroups(ch);
  const pct = (arrIdx) => {
    if (!arrIdx.length) return null;
    let s=0,t=0;
    for (const i of arrIdx) { s += silentCount[i] || 0; t += totalCount[i] || 0; }
    return t ? (100*s/t) : null;
  };
  const lrPct = pct(layout.LR);
  const cPct = pct(layout.C);
  const surPct = pct(layout.Surround);
  const overallPct = (totalCount.reduce((a,b)=>a+b,0)) ? (100*silentCount.reduce((a,b)=>a+b,0)/totalCount.reduce((a,b)=>a+b,0)) : null;

  const silenceNotes = [];
  const silenceNoteInfo = [];
  if (overallPct != null && overallPct >= (silCfg.nearTotalSilence ?? 99)) {
    silenceNotes.push(`Near-total silence (~${overallPct.toFixed(1)}%)`);
    silenceNoteInfo.push({ key: "silence.note.nearTotal", vars: { pct: overallPct.toFixed(1) } });
  }
  if (lrPct != null && silCfg.allowedLRChannelSilencePercent != null && lrPct > silCfg.allowedLRChannelSilencePercent) {
    silenceNotes.push(`LR silence ${lrPct.toFixed(1)}% > ${silCfg.allowedLRChannelSilencePercent}%`);
    silenceNoteInfo.push({ key: "silence.note.lr", vars: { pct: lrPct.toFixed(1), limit: silCfg.allowedLRChannelSilencePercent } });
  }
  if (cPct != null && silCfg.allowedCenterChannelSilencePercent != null && cPct > silCfg.allowedCenterChannelSilencePercent) {
    silenceNotes.push(`C silence ${cPct.toFixed(1)}% > ${silCfg.allowedCenterChannelSilencePercent}%`);
    silenceNoteInfo.push({ key: "silence.note.c", vars: { pct: cPct.toFixed(1), limit: silCfg.allowedCenterChannelSilencePercent } });
  }
  if (surPct != null && silCfg.allowedSurroundChannelSilencePercent != null && surPct > silCfg.allowedSurroundChannelSilencePercent) {
    silenceNotes.push(`Surround silence ${surPct.toFixed(1)}% > ${silCfg.allowedSurroundChannelSilencePercent}%`);
    silenceNoteInfo.push({ key: "silence.note.sur", vars: { pct: surPct.toFixed(1), limit: silCfg.allowedSurroundChannelSilencePercent } });
  }

  const peakViol = (isFinite(samplePeakDb) && loudCfg.maxSamplePeakDBFS != null) ? (samplePeakDb > loudCfg.maxSamplePeakDBFS) : false;
  const tpViol = (isFinite(truePeakDbEst) && loudCfg.maxTruePeakDBFS != null) ? (truePeakDbEst > loudCfg.maxTruePeakDBFS) : false;

  return {
    scannedSeconds,
    scannedBytes,
    samplePeakDbfs: samplePeakDb,
    truePeakDbfsEst: truePeakDbEst,
    peakViolation: peakViol,
    truePeakViolation: tpViol,
    clipping: { clippedSamples: clipTotal, error: clipError, threshold: clipCfg.statisticalClippingErrorThreshold ?? null, segmentsPerChannel: clipSegments },
    digitalHits: { count: hits.length, examples: hits },
    silence: { overallPercent: overallPct, lrPercent: lrPct, cPercent: cPct, surroundPercent: surPct, notes: silenceNotes, noteInfo: silenceNoteInfo },
  };
}

function levenshtein(a, b) {
  a = a || ""; b = b || "";
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

function sourceCategory(source) {
  const s = (source || "").toLowerCase();
  if (s.includes("audioprogramme")) return "programme";
  if (s.includes("audiopackformat")) return "pack";
  if (s.includes("audiotrackformat")) return "trackformat";
  if (s.includes("audiotrackuid")) return "trackuid";
  if (s.includes("audioobject")) return "object";
  if (s.includes("audiocontent")) return "content";
  return "other";
}

function bestGroupSuggestion(normLabel, normLists) {
  let best = { group: null, label: null, dist: Infinity };
  for (const [group, arr] of Object.entries(normLists || {})) {
    for (const s of arr) {
      const d = levenshtein(normLabel, s);
      if (d < best.dist) best = { group, label: s, dist: d };
      if (best.dist === 0) return best;
    }
  }
  return best.group ? best : null;
}

function fixForReject(rawLabel, source, normLists) {
  const cat = sourceCategory(source);
  const norm = normalizeLabel(rawLabel);

  if (cat === "programme") {
    return "Not a bed/object group label. Fix: ignore audioProgrammeName in label QC (validate audioObject/audioContent only).";
  }
  if (cat === "pack") {
    return "Technical pack name. Fix: ignore audioPackFormatName in label QC.";
  }
  if (cat === "trackformat" || cat === "trackuid") {
    return "Channel identifier (not group). Fix: exclude audioTrackFormat/UID from group label QC.";
  }

  const sug = bestGroupSuggestion(norm, normLists);
  if (sug) return `Rename to a recognized ${sug.group} label (closest: "${sug.label}").`;
  return "Rename to a recognized group label (Dialogue/Music/Effects/Narration).";
}

// Structured fix info (for localization)
// Returns: { key: string, vars?: object }
function fixForRejectInfo(rawLabel, source, normLists) {
  const cat = sourceCategory(source);
  const norm = normalizeLabel(rawLabel);

  if (cat === "programme") {
    return { key: "labels.fix.programmeNotGroup", vars: {} };
  }
  if (cat === "pack") {
    return { key: "labels.fix.packTechnical", vars: {} };
  }
  if (cat === "trackformat" || cat === "trackuid") {
    return { key: "labels.fix.channelIdentifier", vars: {} };
  }

  const sug = bestGroupSuggestion(norm, normLists);
  if (sug) {
    return { key: "labels.fix.renameClosest", vars: { group: sug.group, label: sug.label } };
  }
  return { key: "labels.fix.renameGeneric", vars: {} };
}

function fixTextFromInfo(info, locale) {
  if (!info || !info.key) return "";
  const loc = locale || currentLocale || "en";
  return tFmtWithLocale(loc, info.key, info.vars || {});
}

function normalizeLabel(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function setPill(el, text, tone) {
  el.textContent = text;
  el.style.borderColor = "rgba(255,255,255,0.10)";
  el.style.background = "rgba(255,255,255,0.04)";
  if (tone === "good") { el.style.borderColor = "rgba(56,217,150,0.45)"; el.style.background = "rgba(56,217,150,0.10)"; }
  if (tone === "warn") { el.style.borderColor = "rgba(255,204,102,0.50)"; el.style.background = "rgba(255,204,102,0.10)"; }
  if (tone === "bad")  { el.style.borderColor = "rgba(255,92,92,0.55)";  el.style.background = "rgba(255,92,92,0.12)"; }
}

function setStatus(msg) { $("#statusLine").textContent = msg; }

function showLoadError(message){
  const el = document.getElementById("loadError");
  if (!el) return;
  if (message) {
    el.hidden = false;
    el.textContent = String(message);
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}


function setProgress(pct, label){
  const wrap = document.getElementById("progressWrap");
  const bar = document.getElementById("progressBar");
  const text = document.getElementById("progressText");
  if (!wrap || !bar || !text) return;
  if (pct == null) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const p = Math.max(0, Math.min(100, pct));
  bar.style.width = `${p.toFixed(0)}%`;
  text.textContent = label ? label : `${p.toFixed(0)}%`;
}

function setActiveGroup(selector, className, matcher) {
  document.querySelectorAll(selector).forEach(btn => {
    const on = matcher(btn);
    btn.classList.toggle(className, on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
}

// Mode definitions — which groups are required / optional / n/a per workflow
const MODE_GROUPS = {
  backlot: {
    label: "Backlot",
    desc: "Full ADM label QC — all 4 groups validated",
    Dialogue:  "req",
    Music:     "req",
    Effects:   "req",
    Narration: "req",
  },
  dme: {
    label: "DME Extraction",
    desc: "Dialogue · Music · Effects required; Narration not expected in DME stems",
    Dialogue:  "req",
    Music:     "req",
    Effects:   "req",
    Narration: "na",
  },
  me: {
    label: "M&E",
    desc: "Music & Effects only; Dialogue/Narration are optional (re-versioning / dubbing)",
    Dialogue:  "opt",
    Music:     "req",
    Effects:   "req",
    Narration: "na",
  },
};

function renderModeGuide(mode) {
  const guide = document.getElementById("modeGuide");
  if (!guide) return;
  const cfg = MODE_GROUPS[mode] || MODE_GROUPS.backlot;
  const groups = ["Dialogue", "Music", "Effects", "Narration"];
  const typeLabel = { req: "REQ", opt: "OPT", na: "N/A" };
  guide.innerHTML = groups.map(g => {
    const kind = cfg[g] || "na";
    return `<span class="bwav-mg-pill bwav-mg-pill--${kind}" title="${g}: ${kind === "req" ? "Required" : kind === "opt" ? "Optional" : "Not applicable"}">
      <span class="bwav-mg-dot"></span>${g.slice(0,4).toUpperCase()}
    </span>`;
  }).join("");
}

function switchMode(mode) {
  currentMode = mode;
  // Update tab active state
  document.querySelectorAll(".bwav-mode-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  renderModeGuide(mode);
  // Re-apply filters so mode-aware colouring updates on existing results
  if (_allLabelRows && _allLabelRows.length) applyLabelFilters();
}

// Wire mode tab clicks (script is at end of body so DOM is ready)
document.querySelectorAll(".bwav-mode-tab").forEach(btn => {
  btn.addEventListener("click", () => switchMode(btn.dataset.mode));
});
renderModeGuide(currentMode);

function switchTab(tab) {
  // Single-page layout: no tabs.
  return;
}

function resetUI() {
  showLoadError(null);
  $("#fileMeta").hidden = true;
  $("#fileMeta").textContent = "";

  // Label-only UI
  try { $("#mTotal").textContent = "—"; } catch {}
  try { $("#mReject").textContent = "—"; } catch {}
  try { $("#mWarn").textContent = "—"; } catch {}
  try { $("#mPass").textContent = "—"; } catch {}
  try { setPill($("#pOverall"), "Waiting"); } catch {}
  try { setPill($("#pReject"), "—"); } catch {}
  try { setPill($("#pWarn"), "—"); } catch {}
  try { setPill($("#pPass"), "—"); } catch {}
  try { _kpiActiveStatus = "ALL"; setKpiActiveFilter("ALL"); } catch {}

  const tb = $("#labelsTable tbody");
  tb.innerHTML = `<tr class="empty"><td colspan="5">${escapeHtml(t("labels.empty.noFile"))}</td></tr>`;
  _allLabelRows = [];
  lastFilteredRows = null;
  lastBaseRows = null;
  try { const cEl = document.getElementById("labelsCount"); if (cEl) cEl.textContent = "—"; } catch {}
  try { const qEl = document.getElementById("filterText"); if (qEl) qEl.value = ""; } catch {}
  try { const sEl = document.getElementById("filterStatus"); if (sEl) sEl.value = "ALL"; } catch {}
  try { const gEl = document.getElementById("filterGroup"); if (gEl) gEl.value = "ALL"; } catch {}
  (() => { const _st = document.getElementById("structureText"); if (_st) _st.textContent = "No data."; })();

  report = {};
  lastFile = null;
  lastResult = null;
  try { const pre = document.getElementById("reportJson"); if (pre) pre.textContent = JSON.stringify(report, null, 2); } catch {}
  try { setProgress(null); } catch {}
  setStatus("Ready.");
}

function renderLabelsTable(rows) {
  const tb = $("#labelsTable tbody");
  tb.innerHTML = "";
  if (!rows.length) {
    tb.innerHTML = `<tr class="empty"><td colspan="5">${escapeHtml(t("labels.empty.none"))}</td></tr>`;
    return;
  }
  const modeCfg = MODE_GROUPS[currentMode] || MODE_GROUPS.backlot;
  for (const r of rows) {
    const mappedGroup = r.mapped || "";
    const modeKind = modeCfg[mappedGroup]; // "req" | "opt" | "na" | undefined
    let cls = r.status === "PASS" ? "pass" : (r.status === "WARN" ? "warn" : "reject");
    let fixText = (r.fixInfo && r.fixInfo.key) ? fixTextFromInfo(r.fixInfo) : (r.fix || "");

    // Mode-aware override: if a group is N/A or optional in this mode, annotate the fix text
    let modeBadge = "";
    if (modeKind === "na" && mappedGroup) {
      modeBadge = `<span class="badge" style="border-color:rgba(255,255,255,.1);color:var(--txt4);background:transparent;margin-left:4px;font-size:8px;">N/A in ${modeCfg.label}</span>`;
      if (!fixText) fixText = `Group "${mappedGroup}" is not expected in ${modeCfg.label} mode — label is informational only.`;
    } else if (modeKind === "opt" && mappedGroup && r.status === "PASS") {
      modeBadge = `<span class="badge" style="border-color:rgba(245,197,24,.28);color:var(--amber);background:rgba(245,197,24,.05);margin-left:4px;font-size:8px;">OPT</span>`;
      if (!fixText) fixText = `"${mappedGroup}" is optional in ${modeCfg.label} — verify intent.`;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="badge ${cls}">${r.status}</span>${modeBadge}</td>
      <td>${escapeHtml(r.rawLabel || "")}</td>
      <td>${escapeHtml((mappedGroup) + (r.subgroup ? ` / ${r.subgroup}` : ""))}</td>
      <td>${escapeHtml(r.source || "")}</td>
      <td class="fix">${escapeHtml(fixText)}</td>
    `;
    tb.appendChild(tr);
  }
}

let _allLabelRows = [];
let lastFilteredRows = null;
let lastBaseRows = null;

function applyLabelFilters() {
  const qEl = document.getElementById("filterText");
  const sEl = document.getElementById("filterStatus");
  const gEl = document.getElementById("filterGroup");
  const q = (qEl?.value || "").trim().toLowerCase();
  const status = (sEl?.value || "ALL");
  const group = (gEl?.value || "ALL");

  // Base rows ignore Status filter (so KPI always shows all statuses for the current view)
  let base = Array.isArray(_allLabelRows) ? _allLabelRows.slice() : [];
  if (group !== "ALL") {
    if (group === "UNMAPPED") base = base.filter(r => !r.mapped);
    else base = base.filter(r => (r.mapped || "") === group);
  }
  if (q) {
    base = base.filter(r =>
      (r.rawLabel || "").toLowerCase().includes(q) ||
      (r.mapped || "").toLowerCase().includes(q) ||
      (r.source || "").toLowerCase().includes(q)
    );
  }
  lastBaseRows = base;

  // Rows shown in table (apply Status filter last)
  let rows = base;
  if (status !== "ALL") rows = rows.filter(r => r.status === status);

  lastFilteredRows = rows;
  renderLabelsTable(rows);

  const cEl = document.getElementById("labelsCount");
  if (cEl) cEl.textContent = tFmt("labels.count", { shown: rows.length, total: _allLabelRows.length });

  try { updateLabelKpis(); } catch {}
}

function countLabelRows(rows){
  const out = { total: 0, pass: 0, warn: 0, reject: 0, unmapped: 0 };
  if (!Array.isArray(rows) || !rows.length) return out;
  out.total = rows.length;
  for (const r of rows) {
    if (!r?.mapped) out.unmapped++;
    const s = String(r?.status || "").toUpperCase();
    if (s === "PASS") out.pass++;
    else if (s === "WARN") out.warn++;
    else if (s === "REJECT") out.reject++;
  }
  return out;
}

function setKpiActiveFilter(status){
  const map = [
    ["kpiTotal",  "ALL",    "rgba(255,255,255,.22)", "rgba(255,255,255,.08)", "rgba(255,255,255,.35)"],
    ["kpiReject", "REJECT", "rgba(229,9,20,.6)",     "rgba(229,9,20,.14)",    "#E50914"],
    ["kpiWarn",   "WARN",   "rgba(245,197,24,.6)",   "rgba(245,197,24,.12)",  "#F5C518"],
    ["kpiPass",   "PASS",   "rgba(70,211,105,.55)",  "rgba(70,211,105,.12)",  "#46D369"],
  ];
  for (const [id, key, borderActive, bgActive, accentColor] of map){
    const el = document.getElementById(id);
    if (!el) continue;
    const isActive = key === status;
    el.classList.toggle("active", isActive);
    if (isActive) {
      el.style.borderColor  = borderActive;
      el.style.background   = bgActive;
      el.style.outline      = `none`;
      el.style.borderTop    = `2px solid ${accentColor}`;
    } else {
      el.style.borderColor  = "";
      el.style.background   = "";
      el.style.borderTop    = "";
    }
  }
}

function updateLabelKpis(){
  const totalEl = document.getElementById("mTotal");
  const rEl = document.getElementById("mReject");
  const wEl = document.getElementById("mWarn");
  const pEl = document.getElementById("mPass");
  const pillOverall = document.getElementById("pOverall");
  const pillR = document.getElementById("pReject");
  const pillW = document.getElementById("pWarn");
  const pillP = document.getElementById("pPass");

  const hasFile = !!lastFile;
  const status = (document.getElementById("filterStatus")?.value || "ALL");
  setKpiActiveFilter(status);

  if (!hasFile) {
    if (totalEl) totalEl.textContent = "—";
    if (rEl) rEl.textContent = "—";
    if (wEl) wEl.textContent = "—";
    if (pEl) pEl.textContent = "—";
    if (pillOverall) setPill(pillOverall, "Waiting");
    if (pillR) setPill(pillR, "—");
    if (pillW) setPill(pillW, "—");
    if (pillP) setPill(pillP, "—");
    return;
  }

  const base = countLabelRows(lastBaseRows || _allLabelRows || []);
  const shown = countLabelRows(lastFilteredRows || []);

  // Values show counts for the current view (group/text filters), regardless of status filter.
  if (totalEl) totalEl.textContent = String(base.total ?? 0);
  if (rEl) rEl.textContent = String(base.reject ?? 0);
  if (wEl) wEl.textContent = String(base.warn ?? 0);
  if (pEl) pEl.textContent = String(base.pass ?? 0);

  // Overall pill: summarize severity for the current view
  if (pillOverall) {
    if (report?.error) {
      setPill(pillOverall, "Error", "bad");
    } else if (!base.total) {
      // File loaded but no labels in current view (either none found, or filters hide all)
      const msg = (Array.isArray(_allLabelRows) && _allLabelRows.length) ? "No matches" : "No labels found";
      setPill(pillOverall, msg, "warn");
    } else {
      const parts = [];
      if (base.reject) parts.push(`${base.reject} Reject`);
      if (base.warn) parts.push(`${base.warn} Warn`);
      if (!parts.length) parts.push("OK");
      if (shown.total !== base.total) parts.push(`${shown.total}/${base.total} shown`);
      const tone = base.reject ? "bad" : (base.warn ? "warn" : "good");
      setPill(pillOverall, parts.join(" • "), tone);
    }
  }

  // Status pills — show count + checkmark when active, count + arrow when inactive
  if (pillR) {
    if (!base.reject) setPill(pillR, "None");
    else setPill(pillR, status === "REJECT" ? `✓ ${base.reject} shown` : `Filter ${base.reject} ▸`, "bad");
  }
  if (pillW) {
    if (!base.warn) setPill(pillW, "None");
    else setPill(pillW, status === "WARN" ? `✓ ${base.warn} shown` : `Filter ${base.warn} ▸`, "warn");
  }
  if (pillP) {
    if (!base.pass) setPill(pillP, "None");
    else setPill(pillP, status === "PASS" ? `✓ ${base.pass} shown` : `Filter ${base.pass} ▸`, "good");
  }
  // Overall pill: when ALL active show summary, when a filter is active show reset hint
  if (pillOverall && base.total && !report?.error) {
    if (status !== "ALL") {
      setPill(pillOverall, "← Show all", "");
    }
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
}


function fmtSize(bytes){
  if (!Number.isFinite(bytes)) return "—";
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb/1024).toFixed(2)} GB`;
}

function setText(id, val){
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? "—";
}

function setSevByValueId(valueId, sev){
  const v = document.getElementById(valueId);
  const kv = v ? v.closest(".kv") : null;
  if (!kv) return;
  kv.dataset.sev = sev || "info";
}

function setValueWithBadge(valueId, sev, text){
  const v = document.getElementById(valueId);
  if (!v) return;
  const sevLabel = (sev || "info").toUpperCase();
  v.innerHTML = `<span class="sev-badge">${sevLabel}</span>${escapeHtml(text || "—")}`;
  setSevByValueId(valueId, sev);
}

function renderReportSummary(res){
  if (!res) return;

  const name = res.file?.name || "—";
  const size = fmtSize(res.file?.sizeBytes);
  setText("rFile", `${name} • ${size}`);

  const fi = res.fmtInfo;
  if (fi?.numChannels) {
    setText("rPcm", `${fi.numChannels}ch • ${fi.sampleRate} Hz • ${fi.bitsPerSample}-bit`);
  } else {
    setText("rPcm", "—");
  }

  const sf = res.soundfield;
  setText("rFormat", sf?.kind || "—");
  setText("rObjects", sf ? (sf.objects ? "Yes" : "No") : "—");

  setText("rAdm", res.axmlFound ? "Found" : "Missing");
  setText("rAxmlWhere", res.axmlWhere || "—");
  if (res.axmlRoot) {
    const r = res.axmlRoot;
    setText("rAxmlRoot", `${r.localName}${r.ns ? ` • ${r.ns}` : ""}`);
  }
  if (res.admStats) {
    const s = res.admStats;
    setText("rAdmStats", `prog:${s.audioProgramme} • cont:${s.audioContent} • obj:${s.audioObject} • pack:${s.audioPackFormat} • uid:${s.audioTrackUID}`);
  }
  // BXML/SXML flags
  if (typeof res.bxmlFound !== "undefined" || typeof res.sxmlFound !== "undefined") {
    const b = res.bxmlFound ? "BXML present" : "BXML none";
    const s = res.sxmlFound ? "SXML present" : "SXML none";
    setText("rBxml", `${b} • ${s}`);
  }
  // ds64 summary
  if (res.ds64) {
    if (res.ds64.found) setText("rDs64", `ds64 found${res.ds64.rescue ? " (rescue)" : ""} • dataSize:${res.ds64.dataSize ?? "?"}`);
    else setText("rDs64", "ds64 not found");
  }
  // chunk scan count
  if (Array.isArray(res.chunkHeaders)) {
    setText("rChunks", `${res.chunkHeaders.length} headers`);
  }

  // Inspections (with severity)
  // Media format inspection
  if (res.mediaFormat) {
    const sev = res.mediaFormat.pass ? "ok" : "fail";
    const txt = res.mediaFormat.summary || (res.mediaFormat.pass ? "PASS" : "FAIL");
    setValueWithBadge("rMediaFormat", sev, txt);
  } else {
    setValueWithBadge("rMediaFormat", "info", "Not run");
  }

  // Audio scan (Quick) results
  const insp = rulesCache?.inspections || {};
  const loudCfg = insp.audioLoudnessInspection || {};
  const clipCfg = insp.clippingInspection || {};
  const hitCfg = insp.digitalHitInspection || {};
  const silCfg = insp.silenceInspection || {};

  if (res.audioScan) {
    const spVal = res.audioScan.samplePeakDbfs;
    const tpVal = res.audioScan.truePeakDbfsEst;

    const spTxt = (spVal === -Infinity) ? "-inf dBFS" : `${spVal.toFixed(2)} dBFS`;
    const tpTxt = (tpVal === -Infinity) ? "-inf dBFS" : `${tpVal.toFixed(2)} dBFS (est)`;

    const spLimit = (typeof loudCfg.maxSamplePeakDBFS === "number") ? loudCfg.maxSamplePeakDBFS : -2;
    const tpLimit = (typeof loudCfg.maxTruePeakDBFS === "number") ? loudCfg.maxTruePeakDBFS : 0;

    const spSev = (spVal !== -Infinity && spVal > spLimit) ? (loudCfg.treatViolationsAsErrors ? "fail" : "warn") : "ok";
    const tpSev = (tpVal !== -Infinity && tpVal > tpLimit) ? (loudCfg.treatViolationsAsErrors ? "fail" : "warn") : "ok";

    const spExtra = (spSev !== "ok") ? ` • > ${spLimit} dBFS` : "";
    const tpExtra = (tpSev !== "ok") ? ` • > ${tpLimit} dBFS` : "";

    setValueWithBadge("rSamplePeak", spSev, spTxt + spExtra);
    setValueWithBadge("rTruePeak", tpSev, tpTxt + tpExtra);

    const clip = res.audioScan.clipping || { clippedSamples: 0 };
    const clipThresh = (typeof clipCfg.statisticalClippingErrorThreshold === "number") ? clipCfg.statisticalClippingErrorThreshold : 4000;
    let clipSev = "ok";
    if (clip.clippedSamples > 0 && clip.clippedSamples < clipThresh) clipSev = "warn";
    if (clip.clippedSamples >= clipThresh) clipSev = "fail";
    const clipTxt = `${clip.clippedSamples} clipped sample(s)` + (clip.clippedSamples >= clipThresh ? ` • >= ${clipThresh}` : "");
    setValueWithBadge("rClipping", clipSev, clipTxt);

    const hits = res.audioScan.digitalHits || { count: 0 };
    const hitsSev = hits.count > 0 ? "warn" : "ok";
    const hitsTxt = `${hits.count} hit(s)` + (hits.count ? ` • check for digital pops` : "");
    setValueWithBadge("rHits", hitsSev, hitsTxt);

    const sil = res.audioScan.silence || {};
    const o = sil.overallPercent == null ? "—" : `${sil.overallPercent.toFixed(1)}%`;
    let note = "";
    if (sil.noteInfo && sil.noteInfo.length && sil.noteInfo[0]?.key) note = tFmt(sil.noteInfo[0].key, sil.noteInfo[0].vars || {});
    else note = (sil.notes && sil.notes.length) ? (sil.notes[0] || "") : "";
    const silSev = note ? "warn" : "ok";
    const silTxt = note ? `${o} • ${note}` : o;
    setValueWithBadge("rSilence", silSev, silTxt);
  } else {
    setValueWithBadge("rSamplePeak", "info", "Not run");
    setValueWithBadge("rTruePeak", "info", "Not run");
    setValueWithBadge("rClipping", "info", "Not run");
    setValueWithBadge("rHits", "info", "Not run");
    setValueWithBadge("rSilence", "info", "Not run");
  }

  const candidates = (res.labelChecks || []).length;
  const pass = res.totals?.pass ?? 0;
  const reject = res.totals?.reject ?? 0;
  if (!candidates) setText("rLabels", "No label candidates found");
  else setText("rLabels", `${candidates} candidates • ${reject} reject`);

  const warnEl = document.getElementById("rWarning");
  const errEl = document.getElementById("rError");
  if (warnEl) {
    if (res.warning) { warnEl.hidden = false; warnEl.textContent = `Warning: ${res.warning}`; }
    else warnEl.hidden = true;
  }
  if (errEl) {
    if (res.error) { errEl.hidden = false; errEl.textContent = `Error: ${res.error}`; }
    else errEl.hidden = true;
  }
  renderSimpleSummary(res);
}


function sevRank(sev){
  const s = String(sev||"").toLowerCase();
  if (s === "fail" || s === "error" || s === "reject") return 3;
  if (s === "warn" || s === "warning") return 2;
  if (s === "ok" || s === "pass") return 1;
  return 0;
}
function sevLabel(sev){
  const s = String(sev||"").toLowerCase();
  if (s === "fail" || s === "error" || s === "reject") return "FAIL";
  if (s === "warn" || s === "warning") return "WARN";
  if (s === "ok" || s === "pass") return "OK";
  return "INFO";
}
function sevClass2(sev){
  const s = String(sev||"").toLowerCase();
  if (s === "fail" || s === "error" || s === "reject") return "sev-fail";
  if (s === "warn" || s === "warning") return "sev-warn";
  if (s === "ok" || s === "pass") return "sev-ok";
  return "sev-info";
}

function renderSimpleSummary(res){
  const overallEl = document.getElementById("sumOverall");
  const countsEl = document.getElementById("sumCounts");
  const listEl = document.getElementById("sumList");
  if (!overallEl || !countsEl || !listEl) return;

  const issues = [];
  const add = (sev, title, detail, fix) => issues.push({ sev, title, detail, fix });

  const isIr = !!(res && res.kind === "ATMOSIR");

  // 1) Media format
  if (!isIr && res?.mediaFormat && !res.mediaFormat.pass) {
    const cfg = rulesCache?.inspections?.mediaFormatInspection || {};
    const allowed = Array.isArray(cfg.allowedChannelCount) ? cfg.allowedChannelCount.join(", ") : "";

    let detail = t("issue.wrongFileFormat.detailFallback");
    const mi = res.mediaFormat.issueInfo;
    if (Array.isArray(mi) && mi.length && mi[0]?.key) {
      detail = tFmt(mi[0].key, mi[0].vars || {});
    } else if (Array.isArray(res.mediaFormat.issues) && res.mediaFormat.issues.length) {
      detail = res.mediaFormat.issues[0];
    }

    const fix = allowed
      ? tFmt("issue.wrongFileFormat.fixWithAllowed", { allowed })
      : t("issue.wrongFileFormat.fixGeneric");

    add("fail", t("issue.wrongFileFormat"), detail, fix);
  }

  // 2) Audio scan items (ADM only)
  if (!isIr && res?.audioScan) {
    const insp = rulesCache?.inspections || {};
    const loudCfg = insp.audioLoudnessInspection || {};
    const clipCfg = insp.clippingInspection || {};

    const sp = res.audioScan.samplePeakDbfs;
    const spLimit = (typeof loudCfg.maxSamplePeakDBFS === "number") ? loudCfg.maxSamplePeakDBFS : -2;
    if (sp !== -Infinity && sp > spLimit) {
      add(loudCfg.treatViolationsAsErrors ? "fail" : "warn",
        t("issue.tooLoudPeak"),
        tFmt("issue.tooLoudPeak.detail", { peak: sp.toFixed(2), limit: spLimit }),
        t("issue.tooLoudPeak.fix"));
    }

    const clip = res.audioScan.clipping || { clippedSamples: 0 };
    const clipThresh = (typeof clipCfg.statisticalClippingErrorThreshold === "number") ? clipCfg.statisticalClippingErrorThreshold : 4000;
    if (clip.clippedSamples > 0) {
      add(clip.clippedSamples >= clipThresh ? "fail" : "warn",
        t("issue.clipping"),
        tFmt("issue.clipping.detail", { count: clip.clippedSamples }),
        t("issue.clipping.fix"));
    }

    const hits = res.audioScan.digitalHits || { count: 0 };
    if (hits.count > 0) {
      add("warn",
        t("issue.digitalPops"),
        tFmt("issue.digitalPops.detail", { count: hits.count }),
        t("issue.digitalPops.fix"));
    }

    const sil = res.audioScan.silence || {};
    let note = "";
    if (Array.isArray(sil.noteInfo) && sil.noteInfo.length && sil.noteInfo[0]?.key) {
      note = tFmt(sil.noteInfo[0].key, sil.noteInfo[0].vars || {});
    } else if (Array.isArray(sil.notes) && sil.notes.length) {
      note = sil.notes[0] || "";
    }
    if (note) {
      add("warn",
        t("issue.channelTooSilent"),
        note,
        t("issue.channelTooSilent.fix"));
    }
  } else if (!isIr) {
    add("info",
      t("issue.audioScanNotRun"),
      t("issue.audioScanNotRun.detail"),
      "");
  }

  // 2b) AtmosIR setting checks
  if (isIr && Array.isArray(res?.atmosIrIssues) && res.atmosIrIssues.length) {
    for (const it of res.atmosIrIssues) {
      const title = it.titleKey ? t(it.titleKey) : (it.title || "");
      const detail = it.detailKey ? tFmt(it.detailKey, it.detailVars || {}) : (it.detail || "");
      const fix = it.fixKey ? tFmt(it.fixKey, it.fixVars || {}) : (it.fix || "");
      add(it.sev || "warn", title, detail, fix);
    }
  }

  // 3) Label rejects
  const rejects = Array.isArray(res?.labelChecks) ? res.labelChecks.filter(r=>r.status==="REJECT").length : 0;
  if (rejects > 0) {
    add("fail",
      t("issue.labelingErrors"),
      tFmt("issue.labelingErrors.detail", { count: rejects }),
      t("issue.labelingErrors.fix"));
  }

  // Overall + counts
  const hasFail = issues.some(i=>sevRank(i.sev)===3);
  const hasWarn = issues.some(i=>sevRank(i.sev)===2);

  const overall = hasFail ? "FAIL" : (hasWarn ? "WARN" : "OK");
  overallEl.textContent = overall;
  overallEl.className = `badge ${sevClass2(overall.toLowerCase())}`;

  const failCount = issues.filter(i=>sevRank(i.sev)===3).length;
  const warnCount = issues.filter(i=>sevRank(i.sev)===2).length;
  countsEl.textContent = `${failCount} FAIL • ${warnCount} WARN`;
  countsEl.className = `badge ${hasFail ? "sev-fail" : (hasWarn ? "sev-warn" : "sev-ok")}`;

  // Render list (FAIL -> WARN -> INFO)
  const sorted = issues.slice().sort((a,b)=>sevRank(b.sev)-sevRank(a.sev));
  const toggle = document.getElementById("sumToggle");
  const limit = 3;
  const hasMore = sorted.length > limit;
  if (toggle) {
    toggle.hidden = !hasMore;
    toggle.textContent = simpleExpanded ? t("btn.showLess") : tFmt("btn.showAllCount", { count: sorted.length });
    toggle.onclick = () => { simpleExpanded = !simpleExpanded; renderSimpleSummary(res); };
  }
  const view = (!simpleExpanded && hasMore) ? sorted.slice(0, limit) : sorted;

  const items = view.map((it, idx) => {
    const cls = sevClass2(it.sev);
    const fix = it.fix ? `<div class="simple-fix">${escapeHtml(it.fix)}</div>` : "";
    return `
      <div class="simple-item ${cls}">
        <div class="simple-left">
          <div class="simple-idx">${idx+1}</div>
          <span class="badge ${cls}">${sevLabel(it.sev)}</span>
        </div>
        <div class="simple-body">
          <div class="simple-h">${escapeHtml(it.title)}</div>
          <div class="simple-d">${escapeHtml(it.detail)}</div>
          ${fix}
        </div>
      </div>
    `;
  }).join("");

  const moreNote = (!simpleExpanded && hasMore)
    ? `<div class="simple-empty">${escapeHtml(tFmt("simple.moreNote", { limit }))}</div>`
    : "";

  listEl.innerHTML = (items ? (items + moreNote) : `<div class="simple-empty">${escapeHtml(t("simple.allOk"))}</div>`);
}


async function readSlice(file, start, length) {
  const buf = await file.slice(start, start + length).arrayBuffer();
  return new DataView(buf);
}

function fourCC(dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
}

// Simple AXML extraction (best-effort): scan the first 64KB; if not found, scan in 1MB windows for a raw 'axml' marker.
async function extractAxml(file, onProgress) {
  const read = async (offset, length) => {
    const buf = await file.slice(offset, offset + length).arrayBuffer();
    if (buf.byteLength < length) return null;
    return new DataView(buf);
  };
  const fourCC = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
  const u64le = (dv, o) => {
    try { if (typeof dv.getBigUint64 === "function") return Number(dv.getBigUint64(o, true)); } catch {}
    const lo = dv.getUint32(o, true);
    const hi = dv.getUint32(o + 4, true);
    return hi * 4294967296 + lo;
  };

  const update = (off, msg) => {
    if (typeof onProgress === "function") {
      const pct = (off / (file.size || 1)) * 100;
      onProgress(pct, msg || `${pct.toFixed(0)}%`);
    }
  };

  const header = await read(0, 12);
  if (!header) throw new Error("Unexpected EOF reading header.");
  const riff = fourCC(header, 0);
  const wave = fourCC(header, 8);
  if (!["RIFF","RF64","BW64"].includes(riff) || wave !== "WAVE") throw new Error(`Not WAVE/BWAV: ${riff}/${wave}`);

  let ds64 = { riffSize: null, dataSize: null, table: new Map(), found: false, foundAt: null, rescue: false };

  const parseDs64At = async (chunkOff) => {
    const hdr = await read(chunkOff, 8);
    if (!hdr) return false;
    const id = fourCC(hdr, 0);
    if (id !== "ds64") return false;
    const size32 = hdr.getUint32(4, true);
    const dataOff = chunkOff + 8;
    const want = Math.min(size32, 8 + 8 + 8 + 4 + 16384);
    const dv = await read(dataOff, want);
    if (!dv) return false;
    ds64.riffSize = u64le(dv, 0);
    ds64.dataSize = u64le(dv, 8);
    const tableLen = dv.getUint32(24, true);
    let o = 28;
    for (let i = 0; i < tableLen; i++) {
      if (o + 12 > dv.byteLength) break;
      const cid = fourCC(dv, o);
      const csz = u64le(dv, o + 4);
      ds64.table.set(cid, csz);
      o += 12;
    }
    ds64.found = true;
    ds64.foundAt = chunkOff;
    return true;
  };

  const rescueFindDs64 = async () => {
    const limit = Math.min(file.size, 8 * 1024 * 1024);
    const buf = await file.slice(0, limit).arrayBuffer();
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length - 8; i++) {
      if (u8[i] === 0x64 && u8[i+1] === 0x73 && u8[i+2] === 0x36 && u8[i+3] === 0x34) {
        const size32 = new DataView(buf, i + 4, 4).getUint32(0, true);
        if (size32 > 0 && size32 < 1024 * 1024) {
          const ok = await parseDs64At(i);
          if (ok) { ds64.rescue = true; return true; }
        }
      }
    }
    return false;
  };

  let offset = 12;
  let fmtInfo = null;
  let axmlText = null;
  let chnaFound = false;
  let bxmlFound = false;
  let sxmlFound = false;
  let where = null;
  let dataChunk = null;

  const chunks = [];
  const maxChunks = 800;

  while (offset + 8 <= file.size) {
    update(offset, "Scanning…");
    const dv = await read(offset, 8);
    if (!dv) break;

    const idRaw = fourCC(dv, 0);
    const id = idRaw.toLowerCase();
    const size32 = dv.getUint32(4, true);
    const dataOff = offset + 8;

    if (chunks.length < maxChunks) chunks.push({ id: idRaw, size32, offset });

    if (id === "ds64") {
      await parseDs64At(offset);
    }

    let chunkSize = size32;

    if ((riff === "RF64" || riff === "BW64") && size32 === 0xFFFFFFFF) {
      if (!ds64.found) {
        await rescueFindDs64();
      }
      if (id === "data" && Number.isFinite(ds64.dataSize)) {
        chunkSize = ds64.dataSize;
      } else {
        chunkSize = ds64.table.get(idRaw) ?? ds64.table.get(idRaw.toUpperCase()) ?? null;
        if (chunkSize == null) {
          break; // cannot safely skip; fallback to raw scan
        }
      }
    }

    // capture audio data chunk location
    if (id === "data" && !dataChunk) {
      dataChunk = { offset: dataOff, size: Number(chunkSize) };
    }

    if (id === "fmt " && chunkSize >= 16) {
      const fmtDv = await read(dataOff, 16);
      if (fmtDv) {
        fmtInfo = {
          audioFormat: fmtDv.getUint16(0, true),
          numChannels: fmtDv.getUint16(2, true),
          sampleRate: fmtDv.getUint32(4, true),
          bitsPerSample: fmtDv.getUint16(14, true),
        };
      }
    }

    if (id === "chna") chnaFound = true;
    if (id === "bxml") bxmlFound = true;
    if (id === "sxml") sxmlFound = true;

    if (id === "axml") {
      const max = Number(chunkSize);
      const parts = [];
      const step = 4 * 1024 * 1024;
      for (let p = 0; p < max; p += step) {
        update(offset + p, "Reading AXML…");
        const buf = await file.slice(dataOff + p, dataOff + Math.min(max, p + step)).arrayBuffer();
        parts.push(new Uint8Array(buf));
      }
      const total = parts.reduce((s,a)=>s+a.length,0);
      const all = new Uint8Array(total);
      let w = 0;
      for (const a of parts) { all.set(a, w); w += a.length; }
      axmlText = new TextDecoder("utf-8").decode(all);
      where = `chunk@${offset}`;
      update(offset, "AXML found");
      if (chnaFound) break;
    }

    offset = dataOff + Number(chunkSize) + (Number(chunkSize) % 2);
    if (!Number.isFinite(offset) || offset <= dataOff) break;
  }

  if (!axmlText) {
    const step = 8 * 1024 * 1024;
    for (let pos = 0; pos < file.size; pos += step) {
      update(pos, "Searching AXML…");
      const buf = await file.slice(pos, Math.min(file.size, pos + step)).arrayBuffer();
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length - 8; i++) {
        if (u8[i] === 0x61 && u8[i+1] === 0x78 && u8[i+2] === 0x6d && u8[i+3] === 0x6c) {
          const size32 = new DataView(buf, i + 4, 4).getUint32(0, true);
          if (size32 > 0 && size32 < 256 * 1024 * 1024) {
            const dataOff = pos + i + 8;
            update(dataOff, "Reading AXML…");
            const axBuf = await file.slice(dataOff, dataOff + size32).arrayBuffer();
            axmlText = new TextDecoder("utf-8").decode(new Uint8Array(axBuf));
            where = `scan@${pos + i}`;
            break;
          }
        }
      }
      if (axmlText) break;
    }
  }

  update(file.size, "Done");
  return { riff, wave, axmlText, found: where, fmtInfo, chnaFound, bxmlFound, sxmlFound, chunks, ds64, dataChunk };
}


function textOfFirst(node) { return (node && (node.textContent || "")).trim(); }

function detectSoundfield(xmlDoc, fmtInfo) {
  // Clarified detection:
  // - "Atmos" ONLY when we have real object evidence:
  //   * audioBlockFormatObjects present OR audioPackFormat typeDefinition="Objects"
  // - Otherwise we show channel/bed layout (e.g., 5.1, 7.1, 7.1.4 bed)
  // - We also keep an "atmosHint" if names include "Atmos" (profile/template), but it won't force Atmos.
  const packs = [];
  try { packs.push(...Array.from(xmlDoc.getElementsByTagNameNS("*", "audioPackFormat"))); } catch {}
  try { packs.push(...Array.from(xmlDoc.getElementsByTagName("audioPackFormat"))); } catch {}

  const seen = new Set();
  const uniq = [];
  for (const p of packs) { if (p && !seen.has(p)) { seen.add(p); uniq.push(p); } }

  const countTag = (ln) => {
    try { return xmlDoc.getElementsByTagNameNS("*", ln).length; } catch {}
    try { return xmlDoc.getElementsByTagName(ln).length; } catch {}
    return 0;
  };

  const objBlocks = countTag("audioBlockFormatObjects");
  const hasObjBlocks = objBlocks > 0;

  let objectsPacks = 0;
  let atmosHint = false;

  let maxDirectCh = 0;
  let maxAnyCh = 0;

  for (const p of uniq) {
    const typeDef = (p.getAttribute("typeDefinition") || "").toLowerCase();
    const packName = (p.getAttribute("audioPackFormatName") || "").toLowerCase();

    if (typeDef.includes("objects")) objectsPacks += 1;
    if (packName.includes("atmos")) atmosHint = true;

    const refs = [];
    try { refs.push(...Array.from(p.getElementsByTagNameNS("*", "audioChannelFormatIDRef"))); } catch {}
    try { refs.push(...Array.from(p.getElementsByTagName("audioChannelFormatIDRef"))); } catch {}
    const chCount = refs.length;

    if (chCount > maxAnyCh) maxAnyCh = chCount;
    if (typeDef.includes("directspeakers") && chCount > maxDirectCh) maxDirectCh = chCount;
  }

  const pcmCh = fmtInfo?.numChannels || 0;

  const bedLabel = (ch) => {
    if (!ch) return null;
    if (ch === 2) return "Stereo";
    if (ch === 6) return "5.1";
    if (ch === 8) return "7.1";
    if (ch === 10) return "7.1.2";
    if (ch === 12) return "7.1.4";
    return `${ch}ch`;
  };

  const bedCh = maxDirectCh || (pcmCh && pcmCh <= 12 ? pcmCh : 0) || maxAnyCh || 0;
  const bed = bedLabel(bedCh);

  const objects = hasObjBlocks || objectsPacks > 0;

  if (objects) {
    let detail = "";
    if (hasObjBlocks) detail = `Objects present (audioBlockFormatObjects=${objBlocks})`;
    else detail = `Objects present (typeDefinition Objects packs=${objectsPacks})`;
    if (bed) detail += ` • bed ${bed}`;
    if (pcmCh) detail += ` • ${pcmCh}ch PCM`;
    return { kind: "Atmos", detail, bedLabel: bed, bedChannels: bedCh || null, objects: true, atmosHint };
  }

  let kind = bed || (pcmCh ? `${pcmCh}ch` : "Unknown");
  let detail = "Channel-based (no objects detected)";
  if (bed) detail += ` • bed ${bed}`;
  if (pcmCh) detail += ` • ${pcmCh}ch PCM`;
  if (atmosHint) detail += " • Atmos-named packs (template/profile)";
  return { kind, detail, bedLabel: bed, bedChannels: bedCh || null, objects: false, atmosHint };
}
function buildSynonymSets(labels) {
  const toArr = (arr) => (arr || []).map(normalizeLabel);
  const toSet = (arr) => new Set(toArr(arr));

  // Support both:
  // 1) legacy {Dialogue:[], Music:[], Effects:[], Narration:[]}
  // 2) atmosLabelConfiguration { validAudioContentGroups:[{groupName, labels, validContentLabelSubGroups:[{subGroupName, labels}]}], ... }
  let buckets = { Dialogue: [], Music: [], Effects: [], Narration: [] };
  let subgroupBuckets = { Dialogue: {}, Music: {}, Effects: {}, Narration: {} };

  const mapGroup = (g) => {
    const k = String(g || "").toLowerCase();
    if (k === "dialogue") return "Dialogue";
    if (k === "music") return "Music";
    if (k === "effects") return "Effects";
    if (k === "narration") return "Narration";
    return k ? (k[0].toUpperCase() + k.slice(1)) : "Other";
  };

  if (labels && Array.isArray(labels.validAudioContentGroups)) {
    for (const g of labels.validAudioContentGroups) {
      const key = mapGroup(g.groupName);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(...(g.labels || []));

      // subgroups
      for (const sg of (g.validContentLabelSubGroups || [])) {
        const sgName = String(sg.subGroupName || "").trim() || "subgroup";
        if (!subgroupBuckets[key]) subgroupBuckets[key] = {};
        if (!subgroupBuckets[key][sgName]) subgroupBuckets[key][sgName] = [];
        subgroupBuckets[key][sgName].push(...(sg.labels || []));
        // also consider subgroup labels valid for the parent group
        buckets[key].push(...(sg.labels || []));
      }
    }
  } else {
    buckets = {
      Dialogue: labels.Dialogue || [],
      Music: labels.Music || [],
      Effects: labels.Effects || [],
      Narration: labels.Narration || [],
    };
  }

  const sets = {
    Dialogue: toSet(buckets.Dialogue),
    Music: toSet(buckets.Music),
    Effects: toSet(buckets.Effects),
    Narration: toSet(buckets.Narration),
  };

  // arrays (for suggestions)
  sets.__normLists = {
    Dialogue: toArr(buckets.Dialogue),
    Music: toArr(buckets.Music),
    Effects: toArr(buckets.Effects),
    Narration: toArr(buckets.Narration),
  };

  // subgroup sets + quick lookup
  sets.__subgroups = {};
  sets.__subgroupLookup = new Map(); // normLabel -> {group, subgroup}
  for (const group of Object.keys(subgroupBuckets || {})) {
    const gObj = subgroupBuckets[group] || {};
    sets.__subgroups[group] = {};
    for (const [sgName, arr] of Object.entries(gObj)) {
      const normArr = toArr(arr);
      sets.__subgroups[group][sgName] = new Set(normArr);
      for (const n of normArr) {
        // first hit wins
        if (!sets.__subgroupLookup.has(n)) sets.__subgroupLookup.set(n, { group, subgroup: sgName });
      }
    }
  }

  // expose enforcement flags when provided
  sets.__enforce = {
    labelValidityEnforced: !!labels?.labelValidityEnforced,
    labelExistenceEnforced: !!labels?.labelExistenceEnforced,
  };

  return sets;
}
function mapLabel(norm, sets) {
  // Return {group, subgroup?} when we can.
  // 1) subgroup hit (if configured)
  try {
    const hit = sets?.__subgroupLookup?.get(norm);
    if (hit) return hit;
  } catch {}

  // 2) group-level hit
  for (const k of ["Dialogue","Music","Effects","Narration"]) {
    if (sets[k]?.has(norm)) return { group: k, subgroup: "" };
  }
  return null;
}

function extractCandidates(xmlDoc) {
  // Extract label candidates from BOTH attributes and sub-elements.
  // In BS.2076 ADM, names like audioObjectName/audioContentName are commonly ATTRIBUTES:
  // https://mediaarea.net/Specs/ITU-R_BS.2076/audioObject
  const out = [];

  const uniqPush = (rawLabel, source) => {
    const t = (rawLabel || "").trim();
    if (!t) return;
    out.push({ rawLabel: t, source });
  };

  const byLocalName = (localName) => {
    const nodes = [];
    try { nodes.push(...Array.from(xmlDoc.getElementsByTagNameNS("*", localName))); } catch {}
    try { nodes.push(...Array.from(xmlDoc.getElementsByTagName(localName))); } catch {}
    const seen = new Set();
    const uniq = [];
    for (const n of nodes) { if (n && !seen.has(n)) { seen.add(n); uniq.push(n); } }
    return uniq;
  };

  const pullAttr = (elemLocalName, attrName, source) => {
    for (const n of byLocalName(elemLocalName)) {
      try {
        const v = n.getAttribute(attrName);
        if (v) uniqPush(v, source);
      } catch {}
    }
  };

  const pullText = (nameLocalName, source) => {
    for (const n of byLocalName(nameLocalName)) uniqPush(n.textContent, source);
  };

  // Attribute-based names (common)
  pullAttr("audioProgramme", "audioProgrammeName", "audioProgramme@audioProgrammeName");
  pullAttr("audioContent", "audioContentName", "audioContent@audioContentName");
  pullAttr("audioObject", "audioObjectName", "audioObject@audioObjectName");
  pullAttr("audioPackFormat", "audioPackFormatName", "audioPackFormat@audioPackFormatName");
  pullAttr("audioTrackUID", "audioTrackUIDName", "audioTrackUID@audioTrackUIDName");
  pullAttr("audioTrackFormat", "audioTrackFormatName", "audioTrackFormat@audioTrackFormatName");

  // Element-based names (some tools export these)
  pullText("audioProgrammeName", "audioProgrammeName");
  pullText("audioContentName", "audioContentName");
  pullText("audioObjectName", "audioObjectName");
  pullText("audioPackFormatName", "audioPackFormatName");
  pullText("audioTrackUIDName", "audioTrackUIDName");
  pullText("audioTrackFormatName", "audioTrackFormatName");

  const seen = new Set();
  const dedup = [];
  for (const r of out) {
    const k = `${r.source}::${r.rawLabel}`;
    if (!seen.has(k)) { seen.add(k); dedup.push(r); }
  }
  return dedup;
}

// ---- .atmosIR support (Dolby Atmos Renderer input/binaural/re-render config) ----
function isAtmosIrFile(file){
  const n = (file && file.name) ? String(file.name).toLowerCase() : "";
  return n.endsWith(".atmosir");
}

function _yamlScalar(raw){
  const s0 = String(raw ?? "").trim();
  if (!s0) return "";
  const s = s0;
  // quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // bool/null
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  // inline list
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map(x => _yamlScalar(x.trim()));
  }
  // number
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseAtmosIrYaml(text){
  // Best-effort YAML subset parser (enough for Dolby Renderer .atmosIR files we see in the field)
  const lines = String(text || "").replace(/\t/g, "  ").split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, type: "object", value: root }];

  const nextNonEmpty = (startIdx) => {
    for (let j = startIdx; j < lines.length; j++) {
      const l = lines[j];
      if (!l) continue;
      if (/^\s*$/.test(l)) continue;
      const t = l.trim();
      if (t.startsWith("#")) continue;
      return l;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s*$/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = (line.match(/^ */) || [""])[0].length;

    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const ctx = stack[stack.length - 1];

    // Array item
    if (trimmed.startsWith("- ")) {
      if (ctx.type !== "array") {
        // Unexpected, but try to recover by turning it into an array if possible
        if (ctx.type === "object") {
          // can't safely recover without knowing the key; ignore
          continue;
        }
      }
      const itemStr = trimmed.slice(2).trim();
      let item;
      const m = itemStr.match(/^([^:]+):\s*(.*)$/);
      if (m) {
        item = {};
        item[m[1].trim()] = _yamlScalar(m[2]);
      } else {
        item = _yamlScalar(itemStr);
      }
      ctx.value.push(item);
      if (item && typeof item === "object" && !Array.isArray(item)) {
        stack.push({ indent, type: "object", value: item });
      }
      continue;
    }

    // Key/value
    const kv = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const rest = kv[2];

    if (rest === "" || rest == null) {
      const nl = nextNonEmpty(i + 1);
      const isArr = !!(nl && nl.trim().startsWith("-"));
      const child = isArr ? [] : {};
      if (ctx.type === "object") ctx.value[key] = child;
      else if (ctx.type === "array") {
        // Uncommon: mapping inside array item scalar — ignore
      }
      stack.push({ indent, type: isArr ? "array" : "object", value: child });
    } else {
      if (ctx.type === "object") ctx.value[key] = _yamlScalar(rest);
    }
  }
  return root;
}

function validateAtmosIrParsed(y){
  const issues = [];
  const addIssue = (sev, titleKey, detailKey, detailVars, fixKey, fixVars) => {
    issues.push({ sev, titleKey, detailKey, detailVars, fixKey, fixVars });
  };

  const inputs = Array.isArray(y?.input_configuration) ? y.input_configuration : [];
  const rerenders = Array.isArray(y?.rerender_configuration) ? y.rerender_configuration : [];

  // 1) Duplicate input_channel
  const seen = new Map();
  for (const it of inputs) {
    const ch = it?.input_channel;
    if (typeof ch !== "number") continue;
    seen.set(ch, (seen.get(ch) || 0) + 1);
  }
  for (const [ch, count] of seen.entries()) {
    if (count > 1) {
      addIssue("fail",
        "issue.atmosir.duplicateInputChannel",
        "issue.atmosir.duplicateInputChannel.detail",
        { ch },
        "issue.atmosir.duplicateInputChannel.fix",
        {});
    }
  }

  // 2) Bed channel ids per format (best-effort)
  const allowedByFmt = {
    "5.1": ["L","R","C","LFE","Ls","Rs"],
    "7.1": ["L","R","C","LFE","Lss","Rss","Lrs","Rrs"],
    "7.1.2": ["L","R","C","LFE","Lss","Rss","Lrs","Rrs","Lts","Rts"],
  };

  for (const it of inputs) {
    const ch = it?.input_channel;
    const fmt = String(it?.format ?? "").trim();
    const fmtKey = fmt.toLowerCase();
    const id = String(it?.bed_channel_id ?? "").trim();
    if (!fmt) continue;
    if (fmtKey === "none") {
      // object entry; ignore bed_channel_id (should be empty)
      continue;
    }
    const allowed = allowedByFmt[fmt];
    if (allowed && id && !allowed.includes(id)) {
      addIssue("fail",
        "issue.atmosir.badBedChannel",
        "issue.atmosir.badBedChannel.detail",
        { ch, fmt, id },
        "issue.atmosir.badBedChannel.fix",
        { fmt, allowed: allowed.join(", ") });
    }
  }

  // 3) brm values
  const brmAllowed = new Set(["off","near","mid","far"]);
  for (const it of inputs) {
    const ch = it?.input_channel;
    const brm = String(it?.brm ?? "").trim();
    if (!brm) continue;
    if (!brmAllowed.has(brm.toLowerCase())) {
      addIssue("warn",
        "issue.atmosir.invalidBrm",
        "issue.atmosir.invalidBrm.detail",
        { ch, brm },
        "issue.atmosir.invalidBrm.fix",
        {});
    }
  }

  // 4) Rerender sanity
  let hasAll = false;
  for (const r of rerenders) {
    const groups = Array.isArray(r?.groups) ? r.groups : [];
    if (!groups.length) {
      addIssue("warn",
        "issue.atmosir.rerenderNoGroups",
        "issue.atmosir.rerenderNoGroups.detail",
        { name: String(r?.name ?? "") },
        "issue.atmosir.rerenderNoGroups.fix",
        {});
    }
    if (groups.includes("All")) hasAll = true;
  }
  if (!hasAll && rerenders.length) {
    addIssue("fail",
      "issue.atmosir.missingFullmix",
      "issue.atmosir.missingFullmix.detail",
      {},
      "issue.atmosir.missingFullmix.fix",
      {});
  }

  return issues;
}

async function validateAtmosIr(file, sets){
  const text = await file.text();
  const y = parseAtmosIrYaml(text);
  const inputs = Array.isArray(y?.input_configuration) ? y.input_configuration : [];
  const groups = Array.isArray(y?.group_list) ? y.group_list : [];
  const rerenders = Array.isArray(y?.rerender_configuration) ? y.rerender_configuration : [];

  const bedEntries = inputs.filter(it => String(it?.format ?? "").toLowerCase() !== "none" && String(it?.format ?? "").trim());
  const objEntries = inputs.filter(it => String(it?.format ?? "").toLowerCase() === "none");

  // Most common bed format
  const fmtCounts = new Map();
  for (const b of bedEntries) {
    const f = String(b?.format ?? "").trim();
    if (!f) continue;
    fmtCounts.set(f, (fmtCounts.get(f) || 0) + 1);
  }
  let bedFmt = "";
  let best = 0;
  for (const [f, c] of fmtCounts.entries()) {
    if (c > best) { best = c; bedFmt = f; }
  }

  const res = {
    app: "BWAV Inspector",
    version: "0.1.7",
    kind: "ATMOSIR",
    mode: currentMode,
    file: { name: file.name, sizeBytes: file.size },
    fmtInfo: null,
    mediaFormat: null,
    audioScan: null,
    chnaFound: false,
    bxmlFound: false,
    sxmlFound: false,
    chunkHeaders: [],
    ds64: null,
    axmlFound: false,
    axmlWhere: "—",
    labelChecks: [],
    totals: { pass: 0, reject: 0 },
    soundfield: { kind: "AtmosIR", objects: objEntries.length > 0, bedLabel: bedFmt || "" },
    atmosIr: {
      version: y?.version ?? "",
      inputsCount: inputs.length,
      bedCount: bedEntries.length,
      objectCount: objEntries.length,
      groupsTotal: groups.length,
      groupsCustom: groups.filter(g => g && g.custom === true).map(g => String(g.name || "")).filter(Boolean),
      rerendersCount: rerenders.length
    },
    atmosIrIssues: validateAtmosIrParsed(y)
  };

  // Build label checks from custom groups + custom_group in input config
  const rawSet = new Set();
  for (const it of inputs) {
    if (it && it.custom_group) rawSet.add(String(it.custom_group));
  }
  for (const g of groups) {
    if (g && g.custom === true && g.name) rawSet.add(String(g.name));
  }

  const rawList = Array.from(rawSet).sort((a,b)=>a.localeCompare(b));
  for (const raw of rawList) {
    const norm = normalizeLabel(raw);
    const mapped = mapLabel(norm, sets);
    let status = mapped ? "PASS" : "REJECT";
    let fix = "";
    let fixInfo = null;
    if (status === "REJECT") {
      fixInfo = fixForRejectInfo(raw, "atmosIR@group", sets.__normLists || {});
      fix = fixTextFromInfo(fixInfo, currentLocale || "en");
      res.totals.reject += 1;
    } else {
      res.totals.pass += 1;
    }
    res.labelChecks.push({
      status,
      rawLabel: raw,
      normalized: norm,
      mapped: mapped ? (mapped.group || "") : "",
      subgroup: mapped ? (mapped.subgroup || "") : "",
      source: "atmosIR",
      fix,
      fixInfo
    });
  }

  // Helper warning if file seems empty/unparseable
  if (!inputs.length && !groups.length && !rerenders.length) {
    res.warning = "No input_configuration / group_list / rerender_configuration sections found. This .atmosIR may be in an unsupported format.";
  }

  return res;
}

// ── MXF support ──────────────────────────────────────────────────────────────
// SMPTE MXF files begin with the 13-byte header partition pack key prefix.
// We scan the entire file for an ADM XML blob (identified by the opening tag of
// an audioFormatExtended document or an ituADM root) embedded as KLV value
// data inside a Generic Sound Essence Descriptor or a DolbyAtmos MXF partition.
function isMxfFile(file) {
  const n = (file.name || "").toLowerCase();
  return n.endsWith(".mxf");
}

async function extractAxmlFromMxf(file, onProgress) {
  const update = (pct, msg) => {
    if (typeof onProgress === "function") onProgress(pct, msg || `${pct.toFixed(0)}%`);
  };

  // Streaming scan helper — returns absolute file offset of first needle hit, or -1
  const CHUNK = 2 * 1024 * 1024;
  const OVERLAP = 128; // must be >= longest needle

  async function scanFor(needles) {
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK + OVERLAP, file.size);
      const buf = await file.slice(offset, end).arrayBuffer();
      const u8 = new Uint8Array(buf);
      for (const needle of needles) {
        for (let i = 0; i <= u8.length - needle.length; i++) {
          let ok = true;
          for (let j = 0; j < needle.length; j++) {
            if (u8[i + j] !== needle[j]) { ok = false; break; }
          }
          if (ok) return offset + i;
        }
      }
      offset += CHUNK;
      update((offset / file.size) * 55, "Scanning MXF…");
    }
    return -1;
  }

  const enc = new TextEncoder();

  // ADM content markers — used to confirm that a <?xml hit is actually ADM
  const ADM_CONFIRM = [enc.encode("audioFormatExtended"), enc.encode("audioProgramme"), enc.encode("ituADM")];

  // Step 1: find <?xml and verify it leads to ADM content within 8 KB
  update(0, "Scanning MXF for ADM XML…");
  let xmlStart = -1;

  {
    const xmlDecl = enc.encode("<?xml");
    let offset = 0;
    while (offset < file.size && xmlStart === -1) {
      const end = Math.min(offset + CHUNK + OVERLAP, file.size);
      const buf = await file.slice(offset, end).arrayBuffer();
      const u8 = new Uint8Array(buf);
      for (let i = 0; i <= u8.length - xmlDecl.length; i++) {
        let ok = true;
        for (let j = 0; j < xmlDecl.length; j++) {
          if (u8[i + j] !== xmlDecl[j]) { ok = false; break; }
        }
        if (!ok) continue;

        // Found a <?xml — check the next 8 KB for ADM markers
        const absPos = offset + i;
        const previewEnd = Math.min(i + 8192, u8.length);
        const preview = u8.subarray(i, previewEnd);
        let isAdm = false;
        for (const marker of ADM_CONFIRM) {
          for (let k = 0; k <= preview.length - marker.length; k++) {
            let match = true;
            for (let m = 0; m < marker.length; m++) {
              if (preview[k + m] !== marker[m]) { match = false; break; }
            }
            if (match) { isAdm = true; break; }
          }
          if (isAdm) break;
        }
        if (isAdm) { xmlStart = absPos; break; }
      }
      offset += CHUNK;
      update((offset / file.size) * 55, "Scanning MXF…");
    }
  }

  // Step 2: if no <?xml found with ADM, fall back to raw <audioFormatExtended / <ituADM
  // and walk backward up to 2 KB to find the nearest <?xml or wrapping element.
  if (xmlStart === -1) {
    const admPos = await scanFor([enc.encode("<audioFormatExtended"), enc.encode("<ituADM")]);
    if (admPos !== -1) {
      // Walk back up to 2 KB to find <?xml or an opening < that wraps this
      const walkBack = Math.min(admPos, 2048);
      const backBuf = await file.slice(admPos - walkBack, admPos + 32).arrayBuffer();
      const backU8 = new Uint8Array(backBuf);
      const xmlDeclBytes = enc.encode("<?xml");
      let found = -1;
      for (let i = backU8.length - 1; i >= 0; i--) {
        let ok = true;
        for (let j = 0; j < xmlDeclBytes.length && i + j < backU8.length; j++) {
          if (backU8[i + j] !== xmlDeclBytes[j]) { ok = false; break; }
        }
        if (ok) { found = i; break; }
      }
      xmlStart = found !== -1 ? (admPos - walkBack + found) : admPos;
    }
  }

  if (xmlStart === -1) {
    return { axmlText: null, found: null, fmtInfo: null, chnaFound: false, bxmlFound: false, sxmlFound: false, chunks: [], ds64: null, dataChunk: null, riff: "MXF", wave: "" };
  }

  // Step 3: extract up to 16 MB from xmlStart and find the closing boundary
  update(65, "Extracting ADM XML…");
  const MAX_XML = 16 * 1024 * 1024;
  const xmlBuf = await file.slice(xmlStart, Math.min(xmlStart + MAX_XML, file.size)).arrayBuffer();
  const xmlU8 = new Uint8Array(xmlBuf);

  // Walk forward to find end — stop at MXF KLV key (06 0E 2B 34) that appears
  // after we've consumed at least the closing tag. Null bytes should NOT be used
  // as a stop condition since some encoders pad with 0x00 inside the KLV value.
  // Instead trust the MXF key prefix as the only reliable boundary.
  let xmlEnd = xmlU8.length;
  for (let i = 128; i < xmlU8.length - 4; i++) {
    if (xmlU8[i] === 0x06 && xmlU8[i+1] === 0x0E && xmlU8[i+2] === 0x2B && xmlU8[i+3] === 0x34) {
      xmlEnd = i;
      break;
    }
  }

  const dec = new TextDecoder("utf-8", { fatal: false });
  let axmlText = dec.decode(xmlU8.subarray(0, xmlEnd)).trim();

  // Strip any leading binary garbage before the first '<'
  const ltIdx = axmlText.indexOf("<");
  if (ltIdx > 0) axmlText = axmlText.slice(ltIdx);

  update(100, "Done.");

  return {
    riff: "MXF",
    wave: "",
    axmlText: axmlText || null,
    found: `mxf@byte${xmlStart}`,
    fmtInfo: null,
    chnaFound: false,
    bxmlFound: false,
    sxmlFound: false,
    chunks: [],
    ds64: null,
    dataChunk: null
  };
}

async function validate(file) {
  rulesCache = rulesCache || await loadRules();
  const sets = buildSynonymSets(rulesCache.labels);
  const normLists = sets.__normLists || {};

  // Route .atmosIR files through a separate validator.
  if (isAtmosIrFile(file)) {
    return validateAtmosIr(file, sets);
  }

  // Route .mxf files through the MXF AXML extractor.
  let extracted;
  if (isMxfFile(file)) {
    extracted = await extractAxmlFromMxf(file, (pct, label) => setProgress(pct, label));
  } else {
    extracted = await extractAxml(file, (pct, label) => setProgress(pct, label));
  }

  const fmtInfo = extracted.fmtInfo || null;
  const mediaFormatRes = evalMediaFormat(fmtInfo, rulesCache.inspections?.mediaFormat);

  const res = {
    app: "BWAV Inspector",
    version: "0.1.7",
    mode: currentMode,
    file: { name: file.name, sizeBytes: file.size },
    riff: extracted.riff,
    wave: extracted.wave,
    fmtInfo,
    dataChunk: extracted.dataChunk,
    mediaFormat: mediaFormatRes,
    audioScan: null,
    chnaFound: extracted.chnaFound,
    bxmlFound: extracted.bxmlFound,
    sxmlFound: extracted.sxmlFound,
    chunkHeaders: extracted.chunks,
    ds64: extracted.ds64,
    axmlFound: !!extracted.axmlText,
    axmlWhere: extracted.found,
    labelChecks: [],
    totals: { pass: 0, reject: 0 }
  };

  if (!extracted.axmlText) {
    if (extracted.riff === "MXF") {
      res.error = "No ADM XML (audioFormatExtended / ituADM) found in this MXF file. The MXF may not contain an IAB/ADM audio track, or the ADM metadata may be in a format not yet supported (e.g., binary-encoded KLV, not inline XML).";
    } else if (extracted.bxmlFound) {
      res.error = "AXML chunk not found, but BXML (compressed XML) is present. This file may use BW64 BXML instead of AXML. Decoding BXML is not implemented yet.";
    } else {
      res.error = "AXML (ADM XML) chunk not found. This file may not be an ADM BWF/BW64, or it may be malformed. Use a chunk inspector (e.g., BWF MetaEdit) to confirm whether axml/chna exist.";
    }
    res.totals.reject = 1;
    return res;
  }

  const doc = new DOMParser().parseFromString(extracted.axmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    res.error = "Invalid XML in AXML chunk.";
    res.totals.reject = 1;
    return res;
  }

  // AXML root + quick ADM stats (helps explain why some report fields may be empty)
  res.axmlRoot = {
    localName: doc.documentElement?.localName || doc.documentElement?.nodeName || "",
    ns: doc.documentElement?.namespaceURI || ""
  };

  const countTag = (ln) => {
    try { return doc.getElementsByTagNameNS("*", ln).length; } catch {}
    try { return doc.getElementsByTagName(ln).length; } catch {}
    return 0;
  };

  res.admStats = {
    audioProgramme: countTag("audioProgramme"),
    audioContent: countTag("audioContent"),
    audioObject: countTag("audioObject"),
    audioPackFormat: countTag("audioPackFormat"),
    audioTrackUID: countTag("audioTrackUID"),
    audioTrackFormat: countTag("audioTrackFormat"),
  };

  const soundfield = detectSoundfield(doc, fmtInfo);
  res.soundfield = soundfield;

  const candidates = extractCandidates(doc);
  if (!candidates.length) {
    res.warning = "No label candidates were found in AXML (checked both attribute-based and element-based name fields). Validation is inconclusive.";
  }
  for (const c of candidates) {
    const norm = normalizeLabel(c.rawLabel);
    const mapped = mapLabel(norm, sets);
    let status = mapped ? "PASS" : "REJECT";
    let fix = "";
    let fixInfo = null;
    if (status === "REJECT") {
      const cat = sourceCategory(c.source);
      // Non-group sources become WARN (informational) by default
      if (cat === "programme" || cat === "pack" || cat === "trackformat" || cat === "trackuid") {
        status = "WARN";
      }
      fixInfo = fixForRejectInfo(c.rawLabel, c.source, sets.__normLists || {});
      fix = fixTextFromInfo(fixInfo, currentLocale || "en");
    }
    res.labelChecks.push({ status, rawLabel: c.rawLabel, normalized: norm, mapped: mapped ? (mapped.group || "") : "", subgroup: mapped ? (mapped.subgroup || "") : "", source: c.source, fix, fixInfo });
    if (status === "PASS") res.totals.pass += 1;
    else if (status === "REJECT") res.totals.reject += 1;
  }

  return res;
}

// Keep exports focused on labels only (UI no longer shows other inspections).
function makeLabelOnlyReport(res){
  const out = {
    app: res?.app || "BWAV Inspector",
    version: res?.version || "",
    kind: res?.kind || "BWAV",
    mode: res?.mode || currentMode,
    file: res?.file || {},
    axmlFound: !!res?.axmlFound,
    axmlWhere: res?.axmlWhere || "—",
    warning: res?.warning,
    error: res?.error,
    labelChecks: Array.isArray(res?.labelChecks) ? res.labelChecks : [],
    totals: res?.totals || { pass: 0, reject: 0 }
  };
  if (out.kind === "ATMOSIR" && res?.atmosIr) out.atmosIr = res.atmosIr;
  return out;
}

// UI events
try { bgLog('App Loaded', {}); } catch {}

const modeSel = document.getElementById("modeSelect");
if (modeSel) {
  modeSel.value = currentMode;
  modeSel.addEventListener("change", () => switchMode(modeSel.value));
}
/* no tabs in single-page layout */
const _btnSettings = $("#btnSettings");
if (_btnSettings) _btnSettings.addEventListener("click", () => {
  try {
    if (globalThis.chrome?.runtime?.openOptionsPage) return chrome.runtime.openOptionsPage();
  } catch (_) {}
  try {
    window.open(assetUrl("options.html"), "_blank");
  } catch (_) {}
});

const dropzone = $("#dropzone");
function openFilePicker(){
  const fi = $("#fileInput");
  if (!fi) return;
  // Reset so selecting the same file again still triggers change
  fi.value = "";
  fi.click();
}

dropzone.addEventListener("click", openFilePicker);
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") openFilePicker(); });
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.style.borderColor = "rgba(229,9,20,0.65)"; });
dropzone.addEventListener("dragleave", () => { dropzone.style.borderColor = "rgba(255,255,255,0.18)"; });
async function fileFromDataTransfer(dt){
  try {
    const f0 = dt?.files?.[0];
    if (f0) return f0;
  } catch (_) {}
  try {
    const items = Array.from(dt?.items || []);
    for (const it of items) {
      if (it && it.kind === 'file') {
        const f = it.getAsFile && it.getAsFile();
        if (f) return f;
      }
    }
  } catch (_) {}
  return null;
}

dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropzone.style.borderColor = "rgba(255,255,255,0.18)";
  const file = await fileFromDataTransfer(e.dataTransfer);
  if (!file) {
    showLoadError('No file detected. If you dragged from email/Slack/Drive, please download locally and click to browse.');
    return;
  }
  handleFile(file);
});
// Allow dropping a file anywhere on the page (not just the dropzone)
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
    e.preventDefault();
  }
});
document.addEventListener("drop", async (e) => {
  const dt = e.dataTransfer;
  const file = await fileFromDataTransfer(dt);
  if (file) {
    e.preventDefault();
    dropzone.style.borderColor = "rgba(255,255,255,0.18)";
    handleFile(file);
  }
});



$("#fileInput")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  showLoadError(null);
  if (!file) return;
  if (typeof file.size === 'number' && file.size === 0) {
    showLoadError('File size is 0 bytes. This often happens when dragging from email/Slack/Drive placeholders. Please download the file locally and click the drop area to browse.');
    setStatus('Ready.');
    try { bgLog('Load File Failed', { reason: '0_bytes', name: file?.name||'' }); } catch {}
    return;
  }
  $("#fileMeta").hidden = false;
  $("#fileMeta").textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB`;
  // fmt info will be appended after validation
  lastFile = file;
  lastResult = null;

  try {
    setProgress(0, "0%");
    setStatus("Validating…");
    const fullRes = await validate(file);
    const res = makeLabelOnlyReport(fullRes);
    const isIr = !!(res && res.kind === "ATMOSIR");

    if (res.error) showLoadError(res.error);
    else showLoadError(null);
    if (fullRes.fmtInfo?.numChannels) {
      const fi = fullRes.fmtInfo;
      $("#fileMeta").textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB • ${fi.numChannels}ch • ${fi.sampleRate}Hz • ${fi.bitsPerSample}-bit`;
    } else if (isIr) {
      $("#fileMeta").textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB • AtmosIR`;
    }

    report = res;
    lastResult = res;

    _allLabelRows = res.labelChecks || [];
    applyLabelFilters();
    (() => { const _st = document.getElementById("structureText"); if (_st) _st.textContent = res.error
      ? `Error:
${res.error}`
      : `${res.warning ? `Warning:
${res.warning}

` : ""}AXML: ${res.axmlWhere}
Candidates: ${res.labelChecks.length}
Pass: ${res.totals.pass}
Reject: ${res.totals.reject}`; })();
    $("#reportJson").textContent = JSON.stringify(report, null, 2);
    setProgress(100, "Done.");
    setStatus(res.error ? "Completed with warnings." : "Done.");
    setTimeout(() => setProgress(null), 700);

  } catch (e) {
    try { setProgress(null); } catch {}
    const msg = (e && (e.message || e.toString())) || "Unknown error";
    showLoadError(msg);
    setStatus(`Failed: ${msg}`);
    (() => { const _st = document.getElementById("structureText"); if (_st) _st.textContent = String(e?.message || e); })();
    try {
      report = { error: msg, labelChecks: [], totals: { pass: 0, reject: 0 } };
      lastResult = report;
      _allLabelRows = [];
      applyLabelFilters();
    } catch {}
  }
  // Always allow re-selecting the same file
  try { const fi = document.getElementById('fileInput'); if (fi) fi.value = ''; } catch {}
}

$("#btnClear")?.addEventListener("click", () => { try { bgLog('Clear', {}); } catch {} resetUI(); });
$("#btnCopy")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#reportJson")?.textContent ?? ''); try { bgLog('Copy JSON', {}); } catch {} setStatus("Copied JSON."); }
  catch { setStatus("Copy failed."); }
});
$("#btnExport")?.addEventListener("click", () => {
  const blob = new Blob([$("#reportJson")?.textContent ?? ''], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "bwav-inspector-report.json"; a.click();
  URL.revokeObjectURL(url);
  try { bgLog('Export JSON', {}); } catch {}
  setStatus("Exported JSON.");
});

// PDF export (printable report)
// NOTE: The button exists in app.html as #btnPdf.
// If this listener is missing, Export PDF will appear broken.
const _btnPdf = document.getElementById("btnPdf");
if (_btnPdf) _btnPdf.addEventListener("click", exportPdf);

// Audio scan UI/feature removed (label-only build)

// Filters
["filterText","filterStatus","filterGroup"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(id === "filterText" ? "input" : "change", applyLabelFilters);
});

// KPI shortcuts (click to filter by status) — directly render without select intermediary

function kpiFilter(status) {
  _kpiActiveStatus = status;

  // Sync the dropdown so applyLabelFilters stays consistent
  const sEl = document.getElementById("filterStatus");
  if (sEl) sEl.value = status;

  // Visual active state on cards
  setKpiActiveFilter(status);

  // Directly filter and render
  const rows = status === "ALL"
    ? (_allLabelRows || [])
    : (_allLabelRows || []).filter(r => r.status === status);

  renderLabelsTable(rows);

  // Update count
  const cEl = document.getElementById("labelsCount");
  if (cEl) cEl.textContent = `${rows.length} shown / ${(_allLabelRows||[]).length}`;

  // Update KPI pills
  try { lastFilteredRows = rows; updateLabelKpis(); } catch(e) {}

  // Scroll to labels
  try { document.getElementById("labelsPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch {}
}

["kpiTotal","kpiReject","kpiWarn","kpiPass"].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", () => kpiFilter(el.dataset.filter || "ALL"));
});
function exportPdf() {
  try { bgLog('Export PDF', {}); } catch {}
  try {
    const rows = (lastFilteredRows && Array.isArray(lastFilteredRows)) ? lastFilteredRows
      : (Array.isArray(_allLabelRows) ? _allLabelRows : (report?.labelChecks || []));
    const payload = {
      report: report || {},
      rows,
      // Minimal context for pdf.html to compute inspection summaries
      locale: currentLocale || "en",
      rules: {
        inspections: (rulesCache && rulesCache.inspections) ? rulesCache.inspections : {}
      }
    };

    const openPdf = () => {
      const url = assetUrl("pdf.html");
      try {
        if (globalThis.chrome?.tabs?.create) return chrome.tabs.create({ url });
      } catch (_) {}
      try { window.open(url, "_blank"); } catch (_) {}
    };

    try {
      if (globalThis.chrome?.storage?.local?.set) {
        chrome.storage.local.set({ bwavInspector_pdfPayload: payload }, openPdf);
      } else {
        localStorage.setItem("bwavInspector_pdfPayload", JSON.stringify(payload));
        openPdf();
      }
    } catch (_) {
      // last resort fallback
      localStorage.setItem("bwavInspector_pdfPayload", JSON.stringify(payload));
      openPdf();
    }
  } catch (e) {
    console.error("Export PDF failed", e);
    alert("Export PDF failed. See console for details.");
  }
}



// Main report tabs (Labels / Fix / Technical)
function initMainTabs(){
  const root = document.getElementById("mainTabsPanel");
  if (!root) return;

  const tabs = Array.from(root.querySelectorAll(".tab[data-tab]"));
  const panes = Array.from(root.querySelectorAll(".pane[data-pane]"));
  if (!tabs.length || !panes.length) return;

  const key = "bwavInspector_mainTab";

  function setActive(name, opts = {}){
    const exists = tabs.some(t => t.dataset.tab === name);
    const tabName = exists ? name : (tabs[0]?.dataset.tab || "labels");

    for (const t of tabs){
      const on = t.dataset.tab === tabName;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of panes){
      const on = p.dataset.pane === tabName;
      p.classList.toggle("is-active", on);
      p.hidden = !on;
    }

    try { localStorage.setItem(key, tabName); } catch {}

    if (opts.focus){
      const btn = tabs.find(t => t.dataset.tab === tabName);
      if (btn) btn.focus();
    }
  }

  function nextTab(dir){
    const current = tabs.findIndex(t => t.classList.contains("is-active"));
    if (current < 0) return;
    const next = (current + dir + tabs.length) % tabs.length;
    setActive(tabs[next].dataset.tab, { focus: true });
  }

  for (const t of tabs){
    t.addEventListener("click", () => setActive(t.dataset.tab, { focus: false }));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight"){ e.preventDefault(); nextTab(1); }
      else if (e.key === "ArrowLeft"){ e.preventDefault(); nextTab(-1); }
      else if (e.key === "Home"){ e.preventDefault(); setActive(tabs[0].dataset.tab, { focus: true }); }
      else if (e.key === "End"){ e.preventDefault(); setActive(tabs[tabs.length-1].dataset.tab, { focus: true }); }
    });
  }

  const stored = (() => { try { return localStorage.getItem(key); } catch { return null; } })();
  const initial = (stored && tabs.some(t => t.dataset.tab === stored)) ? stored : "labels";
  setActive(initial, { focus: false });
}

initLocaleUI();
initMainTabs();

resetUI();

