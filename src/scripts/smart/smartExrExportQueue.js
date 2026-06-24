// smartExrExportQueue.js — PostFlowX async EXR export queue
// Manages per-shot jobs with progress, pause/resume/cancel/retry.
// Never blocks the UI — all dispatch is async with microtask yields.

import { validateExrResult } from './smartExrQCValidator.js';

export const JOB_STATUS = {
  WAITING:        'Waiting',
  MATCHING:       'Matching',
  READY:          'Ready',
  EXPORTING:      'Exporting',
  QC_RUNNING:     'QC Running',
  QC_PASSED:      'QC Passed',
  QC_WARNING:     'QC Warning',
  QC_FAILED:      'QC Failed',
  MISSING_OCF:    'Missing OCF',
  REVIEW_NEEDED:  'Review Needed',
  FAILED:         'Failed',
  CANCELLED:      'Cancelled',
  PAUSED:         'Paused',
};

export class ExrExportQueue extends EventTarget {
  constructor({ onStatusChange, onProgress, onLog } = {}) {
    super();
    this._jobs = new Map();   // jobId → job state
    this._order = [];         // ordered job IDs
    this._paused = false;
    this._active = false;
    this._onStatusChange = onStatusChange || null;
    this._onProgress = onProgress || null;
    this._onLog = onLog || null;
    this._nativeDispatch = null; // set by caller: async (jobJson) => resultJson
  }

  setNativeDispatch(fn) { this._nativeDispatch = fn; }

  // Add jobs (array of job objects from smartExrPullPlanner).
  addJobs(jobs = []) {
    for (const job of jobs) {
      const id = job.plateName || job.shotId || `job_${Date.now()}_${Math.random()}`;
      if (!this._jobs.has(id)) this._order.push(id);
      this._jobs.set(id, {
        id,
        job: { ...job },
        status: job.status === 'missing_ocf' ? JOB_STATUS.MISSING_OCF
              : job.metadata?.matchStatus === 'REVIEW_NEEDED' ? JOB_STATUS.REVIEW_NEEDED
              : JOB_STATUS.READY,
        progress: 0,
        result: null,
        qc: null,
        log: [],
        retries: 0,
        cancelRequested: false,
      });
    }
    this._notify();
  }

  updateJobMatch(jobId, matchResult = {}) {
    const s = this._jobs.get(jobId);
    if (!s) return;
    s.job.metadata.matchConfidence = matchResult.confidence;
    s.job.metadata.matchStatus = matchResult.status;
    s.job.sourcePath = matchResult.matchedPath || '';
    s.status = matchResult.matchedPath
      ? (matchResult.status === 'REVIEW_NEEDED' ? JOB_STATUS.REVIEW_NEEDED : JOB_STATUS.READY)
      : JOB_STATUS.MISSING_OCF;
    this._notify(jobId);
  }

  // Start/resume processing all READY jobs.
  async start() {
    if (this._active) return;
    this._paused = false;
    this._active = true;
    this._log(null, 'Queue started');
    await this._processNext();
    this._active = false;
    this._log(null, 'Queue finished');
    this._notify();
  }

  pause()  { this._paused = true;  this._log(null, 'Queue paused'); this._notify(); }
  resume() { this._paused = false; if (!this._active) this.start(); }

  cancel(jobId) {
    const s = this._jobs.get(jobId);
    if (s) { s.cancelRequested = true; s.status = JOB_STATUS.CANCELLED; this._notify(jobId); }
  }

  cancelAll() {
    for (const [id] of this._jobs) this.cancel(id);
  }

  retry(jobId) {
    const s = this._jobs.get(jobId);
    if (s && [JOB_STATUS.FAILED, JOB_STATUS.QC_FAILED, JOB_STATUS.CANCELLED].includes(s.status)) {
      if (s.retries >= 3) {
        this._log(jobId, 'Max retries (3) reached — reset job to retry again');
        return;
      }
      s.status = JOB_STATUS.READY;
      s.cancelRequested = false;
      s.retries++;
      s.progress = 0;
      this._notify(jobId);
      if (!this._active) this.start();
    }
  }

  getJobs() {
    return this._order.map(id => this._jobs.get(id)).filter(Boolean);
  }

  getJob(jobId) { return this._jobs.get(jobId); }

  totalProgress() {
    const states = [...this._jobs.values()];
    if (!states.length) return 0;
    const done = states.filter(s => [
      JOB_STATUS.QC_PASSED, JOB_STATUS.QC_WARNING, JOB_STATUS.QC_FAILED,
      JOB_STATUS.CANCELLED, JOB_STATUS.FAILED,
    ].includes(s.status)).length;
    const exporting = states.filter(s => s.status === JOB_STATUS.EXPORTING);
    const partialProgress = exporting.reduce((acc, s) => acc + (s.progress / 100), 0);
    return Math.round(((done + partialProgress) / states.length) * 100);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _processNext() {
    for (const id of this._order) {
      if (this._paused) break;
      const s = this._jobs.get(id);
      if (!s || s.status !== JOB_STATUS.READY || s.cancelRequested) continue;
      await this._runJob(s);
      await this._yield();
    }
  }

  async _runJob(state) {
    if (!this._nativeDispatch) {
      state.status = JOB_STATUS.FAILED;
      this._log(state.id, 'No native dispatch configured');
      this._notify(state.id);
      return;
    }
    state.status = JOB_STATUS.EXPORTING;
    state.progress = 0;
    this._notify(state.id);
    this._log(state.id, `Starting export: ${state.job.plateName}`);

    try {
      const result = await this._nativeDispatch(state.job, (pct) => {
        state.progress = Math.round(pct);
        this._notifyProgress();
      });
      state.result = result;
      this._log(state.id, `Export complete: ${result.framesExported || 0} frames`);

      // QC
      state.status = JOB_STATUS.QC_RUNNING;
      this._notify(state.id);
      await this._yield();
      const qc = validateExrResult(state.job, result);
      state.qc = qc;
      state.status = qc.qcStatus === 'QC_PASSED' ? JOB_STATUS.QC_PASSED
                   : qc.qcStatus === 'QC_WARNING' ? JOB_STATUS.QC_WARNING
                   : JOB_STATUS.QC_FAILED;
      this._log(state.id, `QC: ${state.status} — ${qc.issues.length} issue(s)`);
    } catch (err) {
      state.status = JOB_STATUS.FAILED;
      state.result = { status: 'error', error: String(err?.message || err) };
      this._log(state.id, `FAILED: ${err?.message || err}`);
    }

    state.progress = 100;
    this._notify(state.id);
  }

  _log(jobId, msg) {
    const entry = { t: Date.now(), msg };
    if (jobId) {
      const s = this._jobs.get(jobId);
      if (s) s.log.push(entry);
    }
    if (this._onLog) try { this._onLog(jobId, msg); } catch {}
  }

  _notify(jobId = null) {
    if (this._onStatusChange) try { this._onStatusChange(jobId, this.getJobs(), this.totalProgress()); } catch {}
    this.dispatchEvent(new CustomEvent('change', { detail: { jobId } }));
  }

  _notifyProgress() {
    if (this._onProgress) try { this._onProgress(this.totalProgress(), this.getJobs()); } catch {}
  }

  _yield() { return new Promise(r => setTimeout(r, 0)); }
}
