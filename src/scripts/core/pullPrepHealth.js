// Pull Prep project-health model.
//
// Keep this file DOM-free. Pull Prep has several visual summaries (workflow
// steps, the VFX Editor ribbon, health text, and the primary action). When each
// surface decides readiness independently they can disagree. This module is the
// single deterministic decision point used by every one of those surfaces.

const count = value => Math.max(0, Math.trunc(Number(value) || 0));

const normalizeLocale = locale => {
  const value = String(locale || 'en').trim().toLowerCase();
  if (value === 'tw' || value === 'zh' || value.startsWith('zh')) return 'zh-TW';
  if (value === 'jp' || value.startsWith('ja')) return 'ja';
  if (value === 'kr' || value.startsWith('ko')) return 'ko';
  if (value.startsWith('th')) return 'th';
  if (value.startsWith('id') || value === 'in') return 'id';
  if (value === 'ph' || value.startsWith('fil') || value.startsWith('tl')) return 'fil';
  return 'en';
};

const plural = (value, singular, pluralForm = `${singular}s`) => value === 1 ? singular : pluralForm;

// Dynamic Project Health copy cannot be translated by the DOM text walker:
// counts are already interpolated when the node appears. Keep the copy beside
// the decision model so every Pull Prep surface receives the same sentence in
// the active language instead of a mix of translated labels and English state.
const COPY = {
  en: {
    timeline: () => ({ title: 'Ready to begin', detail: 'Import an edit timeline and reference video.', kicker: 'START HERE', label: 'Import timeline' }),
    video: () => ({ title: 'Timeline ready', detail: 'Add the reference video to review shots.', kicker: 'NEXT STEP', label: 'Add reference video' }),
    review: c => c.attentionCount ? ({
      title: `${c.attentionCount} editorial ${plural(c.attentionCount, 'change')} to review`,
      detail: `${c.retimeCount} retime · ${c.resizeCount} resize · check these before selecting pulls.`,
      kicker: 'READY TO REVIEW', label: 'Review first shot',
    }) : ({
      title: 'Ready for review', detail: `${c.timelineCount} ${plural(c.timelineCount, 'shot')} available. Start with the first shot.`,
      kicker: 'READY TO REVIEW', label: 'Review first shot',
    }),
    link: c => ({
      title: `${c.orphanCount} ${plural(c.orphanCount, 'marker')} need linking`,
      detail: `${c.linkedCount} linked successfully · ${c.coverage}% shot coverage.`,
      kicker: `${c.orphanCount} NEED ATTENTION`, label: 'Link unmatched markers',
    }),
    'vfx-attention': c => ({
      title: `${c.trackedCount} VFX ${plural(c.trackedCount, 'shot')} · ${c.attentionCount} ${plural(c.attentionCount, 'check')} open`,
      detail: `${c.approvedCount} approved · ${c.overdueCount} overdue · ${c.qcCount} QC ${plural(c.qcCount, 'issue')} · ${c.unmarkedCount} unmarked edits.`,
      kicker: `${c.attentionCount} NEED ATTENTION`, label: 'Review VFX worklist',
    }),
    export: c => ({
      title: `${c.trackedCount} VFX ${plural(c.trackedCount, 'shot')} ready to deliver`,
      detail: `${c.approvedCount} approved · 0 overdue · 0 QC issues · ${c.unmarkedCount} unmarked edits.`,
      kicker: 'READY TO DELIVER', label: 'Export pull package',
    }),
    openItems: n => `${n} open ${plural(n, 'item')}.`,
  },
  th: {
    timeline: () => ({ title: 'พร้อมเริ่มงาน', detail: 'เพิ่มไทม์ไลน์ตัดต่อและวิดีโออ้างอิง', kicker: 'เริ่มตรงนี้', label: 'เพิ่มไทม์ไลน์' }),
    video: () => ({ title: 'ไทม์ไลน์พร้อมแล้ว', detail: 'เพิ่มวิดีโออ้างอิงเพื่อรีวิวช็อต', kicker: 'ขั้นตอนถัดไป', label: 'เพิ่มวิดีโออ้างอิง' }),
    review: c => c.attentionCount ? ({
      title: `มีการเปลี่ยนแปลงจากงานตัดต่อ ${c.attentionCount} รายการที่ต้องตรวจ`,
      detail: `${c.retimeCount} รีไทม์ · ${c.resizeCount} ปรับขนาด · ตรวจรายการเหล่านี้ก่อนเลือกช็อตสำหรับ Pull`,
      kicker: 'พร้อมรีวิว', label: 'ตรวจช็อตแรก',
    }) : ({
      title: 'พร้อมสำหรับการรีวิว', detail: `มี ${c.timelineCount} ช็อต เริ่มตรวจจากช็อตแรก`,
      kicker: 'พร้อมรีวิว', label: 'ตรวจช็อตแรก',
    }),
    link: c => ({
      title: `มี Marker ${c.orphanCount} รายการที่ยังไม่ได้เชื่อม`,
      detail: `เชื่อมแล้ว ${c.linkedCount} รายการ · ครอบคลุมช็อต ${c.coverage}%`,
      kicker: `ต้องตรวจ ${c.orphanCount} รายการ`, label: 'เชื่อม Marker ที่ยังไม่ตรงกัน',
    }),
    'vfx-attention': c => ({
      title: `VFX ${c.trackedCount} ช็อต · ต้องตรวจ ${c.attentionCount} รายการ`,
      detail: `${c.approvedCount} อนุมัติแล้ว · ${c.overdueCount} เกินกำหนด · ${c.qcCount} ปัญหา QC · ${c.unmarkedCount} งานตัดต่อที่ยังไม่ Mark`,
      kicker: `ต้องตรวจ ${c.attentionCount} รายการ`, label: 'ตรวจรายการงาน VFX',
    }),
    export: c => ({
      title: `VFX ${c.trackedCount} ช็อตพร้อมส่งมอบ`,
      detail: `${c.approvedCount} อนุมัติแล้ว · 0 เกินกำหนด · 0 ปัญหา QC · ${c.unmarkedCount} งานตัดต่อที่ยังไม่ Mark`,
      kicker: 'พร้อมส่งมอบ', label: 'ส่งออกแพ็กเกจ Pull',
    }),
    openItems: n => `มีงานค้าง ${n} รายการ`,
  },
  'zh-TW': {
    timeline: () => ({ title: '可以開始', detail: '加入剪輯時間軸和參考影片。', kicker: '從這裡開始', label: '加入時間軸' }),
    video: () => ({ title: '時間軸已就緒', detail: '加入參考影片以檢查鏡頭。', kicker: '下一步', label: '加入參考影片' }),
    review: c => c.attentionCount ? ({ title: `有 ${c.attentionCount} 項剪輯變更需要檢查`, detail: `${c.retimeCount} 項變速 · ${c.resizeCount} 項縮放 · 選擇 Pull 前請先檢查。`, kicker: '可以檢查', label: '檢查第一個鏡頭' }) : ({ title: '可以開始檢查', detail: `共有 ${c.timelineCount} 個鏡頭，請從第一個開始。`, kicker: '可以檢查', label: '檢查第一個鏡頭' }),
    link: c => ({ title: `有 ${c.orphanCount} 個 Marker 尚未連結`, detail: `已成功連結 ${c.linkedCount} 個 · 鏡頭覆蓋率 ${c.coverage}%`, kicker: `${c.orphanCount} 項需要處理`, label: '連結未配對的 Marker' }),
    'vfx-attention': c => ({ title: `${c.trackedCount} 個 VFX 鏡頭 · ${c.attentionCount} 項待檢查`, detail: `${c.approvedCount} 已核准 · ${c.overdueCount} 已逾期 · ${c.qcCount} 項 QC 問題 · ${c.unmarkedCount} 個剪輯尚未標記。`, kicker: `${c.attentionCount} 項需要處理`, label: '檢查 VFX 工作清單' }),
    export: c => ({ title: `${c.trackedCount} 個 VFX 鏡頭可交付`, detail: `${c.approvedCount} 已核准 · 0 已逾期 · 0 項 QC 問題 · ${c.unmarkedCount} 個剪輯尚未標記。`, kicker: '可以交付', label: '匯出 Pull 套件' }),
    openItems: n => `尚有 ${n} 項工作`,
  },
  ja: {
    timeline: () => ({ title: '開始できます', detail: '編集タイムラインとリファレンス映像を追加してください。', kicker: 'ここから開始', label: 'タイムラインを追加' }),
    video: () => ({ title: 'タイムラインの準備完了', detail: 'ショット確認用のリファレンス映像を追加してください。', kicker: '次のステップ', label: 'リファレンス映像を追加' }),
    review: c => c.attentionCount ? ({ title: `確認が必要な編集変更が ${c.attentionCount} 件あります`, detail: `リタイム ${c.retimeCount} 件 · リサイズ ${c.resizeCount} 件 · Pull 選択前に確認してください。`, kicker: 'レビュー可能', label: '最初のショットを確認' }) : ({ title: 'レビューできます', detail: `${c.timelineCount} ショットあります。最初のショットから開始してください。`, kicker: 'レビュー可能', label: '最初のショットを確認' }),
    link: c => ({ title: `${c.orphanCount} 個の Marker が未リンクです`, detail: `${c.linkedCount} 個をリンク済み · ショット網羅率 ${c.coverage}%`, kicker: `${c.orphanCount} 件の要確認`, label: '未一致の Marker をリンク' }),
    'vfx-attention': c => ({ title: `VFX ショット ${c.trackedCount} 件 · 確認待ち ${c.attentionCount} 件`, detail: `承認済み ${c.approvedCount} · 期限超過 ${c.overdueCount} · QC 問題 ${c.qcCount} · 未マーク編集 ${c.unmarkedCount}`, kicker: `${c.attentionCount} 件の要確認`, label: 'VFX 作業リストを確認' }),
    export: c => ({ title: `VFX ショット ${c.trackedCount} 件を納品できます`, detail: `承認済み ${c.approvedCount} · 期限超過 0 · QC 問題 0 · 未マーク編集 ${c.unmarkedCount}`, kicker: '納品可能', label: 'Pull パッケージを書き出す' }),
    openItems: n => `未完了 ${n} 件`,
  },
  ko: {
    timeline: () => ({ title: '시작할 수 있습니다', detail: '편집 타임라인과 레퍼런스 영상을 추가하세요.', kicker: '여기서 시작', label: '타임라인 추가' }),
    video: () => ({ title: '타임라인 준비 완료', detail: '샷 검토용 레퍼런스 영상을 추가하세요.', kicker: '다음 단계', label: '레퍼런스 영상 추가' }),
    review: c => c.attentionCount ? ({ title: `확인할 편집 변경 사항 ${c.attentionCount}개`, detail: `리타임 ${c.retimeCount}개 · 리사이즈 ${c.resizeCount}개 · Pull 선택 전에 확인하세요.`, kicker: '검토 준비 완료', label: '첫 샷 검토' }) : ({ title: '검토 준비 완료', detail: `${c.timelineCount}개 샷이 있습니다. 첫 샷부터 시작하세요.`, kicker: '검토 준비 완료', label: '첫 샷 검토' }),
    link: c => ({ title: `연결되지 않은 Marker ${c.orphanCount}개`, detail: `${c.linkedCount}개 연결 완료 · 샷 커버리지 ${c.coverage}%`, kicker: `${c.orphanCount}개 확인 필요`, label: '일치하지 않는 Marker 연결' }),
    'vfx-attention': c => ({ title: `VFX 샷 ${c.trackedCount}개 · 확인 필요 ${c.attentionCount}개`, detail: `승인 ${c.approvedCount} · 기한 초과 ${c.overdueCount} · QC 문제 ${c.qcCount} · 미표시 편집 ${c.unmarkedCount}`, kicker: `${c.attentionCount}개 확인 필요`, label: 'VFX 작업 목록 검토' }),
    export: c => ({ title: `VFX 샷 ${c.trackedCount}개 납품 준비 완료`, detail: `승인 ${c.approvedCount} · 기한 초과 0 · QC 문제 0 · 미표시 편집 ${c.unmarkedCount}`, kicker: '납품 준비 완료', label: 'Pull 패키지 내보내기' }),
    openItems: n => `미완료 ${n}개`,
  },
  id: {
    timeline: () => ({ title: 'Siap memulai', detail: 'Tambahkan timeline edit dan video referensi.', kicker: 'MULAI DI SINI', label: 'Tambahkan timeline' }),
    video: () => ({ title: 'Timeline siap', detail: 'Tambahkan video referensi untuk meninjau shot.', kicker: 'LANGKAH BERIKUTNYA', label: 'Tambahkan video referensi' }),
    review: c => c.attentionCount ? ({ title: `${c.attentionCount} perubahan editorial perlu ditinjau`, detail: `${c.retimeCount} retime · ${c.resizeCount} resize · periksa sebelum memilih pull.`, kicker: 'SIAP DITINJAU', label: 'Tinjau shot pertama' }) : ({ title: 'Siap ditinjau', detail: `${c.timelineCount} shot tersedia. Mulai dari shot pertama.`, kicker: 'SIAP DITINJAU', label: 'Tinjau shot pertama' }),
    link: c => ({ title: `${c.orphanCount} Marker perlu ditautkan`, detail: `${c.linkedCount} berhasil ditautkan · cakupan shot ${c.coverage}%`, kicker: `${c.orphanCount} PERLU DITANGANI`, label: 'Tautkan Marker yang belum cocok' }),
    'vfx-attention': c => ({ title: `${c.trackedCount} shot VFX · ${c.attentionCount} pemeriksaan terbuka`, detail: `${c.approvedCount} disetujui · ${c.overdueCount} terlambat · ${c.qcCount} masalah QC · ${c.unmarkedCount} edit belum ditandai.`, kicker: `${c.attentionCount} PERLU DITANGANI`, label: 'Tinjau daftar kerja VFX' }),
    export: c => ({ title: `${c.trackedCount} shot VFX siap dikirim`, detail: `${c.approvedCount} disetujui · 0 terlambat · 0 masalah QC · ${c.unmarkedCount} edit belum ditandai.`, kicker: 'SIAP DIKIRIM', label: 'Ekspor paket Pull' }),
    openItems: n => `${n} pekerjaan belum selesai`,
  },
  fil: {
    timeline: () => ({ title: 'Handa nang magsimula', detail: 'Idagdag ang edit timeline at reference video.', kicker: 'MAGSIMULA DITO', label: 'Idagdag ang timeline' }),
    video: () => ({ title: 'Handa na ang timeline', detail: 'Idagdag ang reference video para ma-review ang mga shot.', kicker: 'SUSUNOD NA HAKBANG', label: 'Idagdag ang reference video' }),
    review: c => c.attentionCount ? ({ title: `${c.attentionCount} editorial change ang kailangang i-review`, detail: `${c.retimeCount} retime · ${c.resizeCount} resize · i-check bago pumili ng pulls.`, kicker: 'HANDA NANG I-REVIEW', label: 'I-review ang unang shot' }) : ({ title: 'Handa nang i-review', detail: `May ${c.timelineCount} shot. Magsimula sa unang shot.`, kicker: 'HANDA NANG I-REVIEW', label: 'I-review ang unang shot' }),
    link: c => ({ title: `${c.orphanCount} Marker ang kailangang i-link`, detail: `${c.linkedCount} ang matagumpay na na-link · ${c.coverage}% shot coverage`, kicker: `${c.orphanCount} KAILANGANG AYUSIN`, label: 'I-link ang hindi tugmang Marker' }),
    'vfx-attention': c => ({ title: `${c.trackedCount} VFX shot · ${c.attentionCount} check ang bukas`, detail: `${c.approvedCount} approved · ${c.overdueCount} overdue · ${c.qcCount} QC issue · ${c.unmarkedCount} edit ang hindi pa namarkahan.`, kicker: `${c.attentionCount} KAILANGANG AYUSIN`, label: 'I-review ang VFX worklist' }),
    export: c => ({ title: `${c.trackedCount} VFX shot ang handa nang i-deliver`, detail: `${c.approvedCount} approved · 0 overdue · 0 QC issue · ${c.unmarkedCount} edit ang hindi pa namarkahan.`, kicker: 'HANDA NANG I-DELIVER', label: 'I-export ang Pull package' }),
    openItems: n => `${n} gawain ang bukas`,
  },
};

/**
 * Derive the one next action and the human-readable health summary for Pull Prep.
 * Counts describe open work items, not abstract percentages, so the UI never
 * implies that a technically risky shot is "mostly finished".
 */
export function derivePullPrepHealth(input = {}) {
  const timelineCount = count(input.timelineCount);
  const hasTimeline = timelineCount > 0;
  const hasVideo = Boolean(input.hasVideo);
  const markerCount = count(input.markerCount);
  const linkedCount = Math.min(markerCount, count(input.linkedCount));
  const orphanCount = Math.max(0, markerCount - linkedCount);
  const trackedCount = count(input.trackedCount);
  const attentionCount = count(input.attentionCount);
  const overdueCount = count(input.overdueCount);
  const approvedCount = Math.min(trackedCount, count(input.approvedCount));
  const retimeCount = count(input.retimeCount);
  const resizeCount = count(input.resizeCount);
  const qcCount = count(input.qcCount);
  const unmarkedCount = count(input.unmarkedCount);
  const coverage = hasTimeline
    ? Math.min(100, Math.round((count(input.taggedEventCount) / timelineCount) * 100))
    : 0;

  const blockers = [];
  if (!hasTimeline) blockers.push({ code: 'timeline', count: 1, severity: 'required' });
  else if (!hasVideo) blockers.push({ code: 'reference-video', count: 1, severity: 'required' });
  if (orphanCount) blockers.push({ code: 'unlinked-marker', count: orphanCount, severity: 'required' });
  if (overdueCount) blockers.push({ code: 'overdue', count: overdueCount, severity: 'urgent' });
  if (qcCount) blockers.push({ code: 'qc', count: qcCount, severity: 'review' });
  const otherAttention = Math.max(0, attentionCount - overdueCount - qcCount);
  if (otherAttention) blockers.push({ code: 'review', count: otherAttention, severity: 'review' });

  let stage = 'media';
  let tone = 'neutral';
  let title = 'Ready to begin';
  let detail = 'Import an edit timeline and reference video.';
  let action = { key: 'timeline', kicker: 'START HERE', label: 'Import timeline' };

  if (hasTimeline && !hasVideo) {
    tone = 'warn';
    title = 'Timeline ready';
    detail = 'Add the reference video to review shots.';
    action = { key: 'video', kicker: 'NEXT STEP', label: 'Add reference video' };
  } else if (hasTimeline && hasVideo && markerCount === 0) {
    stage = 'review';
    tone = attentionCount ? 'warn' : 'good';
    title = attentionCount
      ? `${attentionCount} editorial change${attentionCount === 1 ? '' : 's'} to review`
      : 'Ready for review';
    detail = attentionCount
      ? `${retimeCount} retime · ${resizeCount} resize · check these before selecting pulls.`
      : `${timelineCount} shots available. Start with the first shot.`;
    action = { key: 'review', kicker: 'READY TO REVIEW', label: 'Review first shot' };
  } else if (hasTimeline && hasVideo && orphanCount > 0) {
    stage = 'mark';
    tone = 'warn';
    title = `${orphanCount} marker${orphanCount === 1 ? '' : 's'} need linking`;
    detail = `${linkedCount} linked successfully · ${coverage}% shot coverage.`;
    action = {
      key: 'link',
      kicker: `${orphanCount} NEED ATTENTION`,
      label: 'Link unmatched markers',
    };
  } else if (hasTimeline && hasVideo && attentionCount > 0) {
    stage = 'mark';
    tone = 'warn';
    title = `${trackedCount} VFX shot${trackedCount === 1 ? '' : 's'} · ${attentionCount} check${attentionCount === 1 ? '' : 's'} open`;
    detail = `${approvedCount} approved · ${overdueCount} overdue · ${qcCount} QC issue${qcCount === 1 ? '' : 's'} · ${unmarkedCount} unmarked edits.`;
    action = {
      key: 'vfx-attention',
      kicker: `${attentionCount} NEED ATTENTION`,
      label: 'Review VFX worklist',
    };
  } else if (hasTimeline && hasVideo) {
    stage = 'deliver';
    tone = 'good';
    title = `${trackedCount} VFX shot${trackedCount === 1 ? '' : 's'} ready to deliver`;
    detail = `${approvedCount} approved · 0 overdue · 0 QC issues · ${unmarkedCount} unmarked edits.`;
    action = { key: 'export', kicker: 'READY TO DELIVER', label: 'Export pull package' };
  }

  return {
    stage,
    tone,
    title,
    detail,
    action,
    blockers,
    // Category chips may overlap (one shot can be both overdue and fail QC).
    // Count actual open work items once for the primary action/accessibility text.
    blockerCount: (!hasTimeline || !hasVideo ? 1 : 0) + orphanCount + attentionCount,
    counts: {
      timelineCount,
      markerCount,
      linkedCount,
      orphanCount,
      trackedCount,
      attentionCount,
      overdueCount,
      approvedCount,
      retimeCount,
      resizeCount,
      qcCount,
      unmarkedCount,
      coverage,
    },
  };
}

/**
 * Render a derived health model in a supported UI language.
 *
 * This function deliberately accepts the completed model, rather than the raw
 * workspace state. Translation can therefore never change stage priority or
 * blocker counts, and a language switch only replaces presentation copy.
 */
export function localizePullPrepHealth(model, locale = 'en') {
  const safeModel = model && typeof model === 'object' ? model : derivePullPrepHealth();
  const language = normalizeLocale(locale);
  const dictionary = COPY[language] || COPY.en;
  const key = safeModel.action?.key || 'timeline';
  const render = dictionary[key] || COPY.en[key] || COPY.en.timeline;
  const copy = render(safeModel.counts || {});
  return {
    ...safeModel,
    locale: language,
    title: copy.title,
    detail: copy.detail,
    action: {
      ...safeModel.action,
      kicker: copy.kicker,
      label: copy.label,
    },
    openItemsText: dictionary.openItems(safeModel.blockerCount || 0),
  };
}
