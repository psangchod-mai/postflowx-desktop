// RenderEngine.swift — frame-accurate render job manager

import Foundation
import AVFoundation

// ── RenderJob ──────────────────────────────────────────────────────────────────

struct RenderRange {
    let inFrame: Int
    let outFrame: Int
    let label: String
}

actor RenderJob {
    let jobId: String
    let inputPath: String
    let outputPath: String
    let ranges: [RenderRange]
    let fps: Double

    private(set) var status: String = "queued"
    private(set) var progress: Double = 0
    private(set) var currentRange = 0
    private(set) var log: [String] = []
    private(set) var error: String?

    private var exportSession: AVAssetExportSession?
    private var pauseRequested  = false
    private var cancelRequested = false

    init(jobId: String, inputPath: String, outputPath: String,
         ranges: [RenderRange], fps: Double) {
        self.jobId = jobId; self.inputPath = inputPath; self.outputPath = outputPath
        self.ranges = ranges; self.fps = fps
    }

    func run() async {
        status = "running"
        addLog("Job \(jobId) started — \(ranges.count) range(s)")

        let outDir = (outputPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        for (i, range) in ranges.enumerated() {
            if cancelRequested { status = "cancelled"; addLog("Cancelled"); await writeReport(); return }
            while pauseRequested && !cancelRequested { try? await Task.sleep(nanoseconds: 100_000_000) }
            if cancelRequested { status = "cancelled"; addLog("Cancelled"); await writeReport(); return }

            currentRange = i
            addLog("Rendering \(range.label): frames \(range.inFrame)–\(range.outFrame)")

            do {
                try await renderRange(range, index: i)
                addLog("\(range.label) completed")
            } catch {
                addLog("ERROR \(range.label): \(error.localizedDescription)")
                self.error = error.localizedDescription
                status = "failed"
                await writeReport()
                return
            }
            progress = Double(i + 1) / Double(ranges.count)
        }
        status = "completed"; progress = 1.0
        addLog("All \(ranges.count) range(s) completed")
        await writeReport()
    }

    func pause()  { pauseRequested = true;  if status == "running" { status = "paused" } }
    func resume() { pauseRequested = false; if status == "paused"  { status = "running" } }
    func cancel() { cancelRequested = true; exportSession?.cancelExport() }

    func statusDict() -> [String: Any] {
        ["ok": true, "jobId": jobId, "status": status, "progress": progress,
         "currentRange": currentRange, "error": error as Any, "logLines": Array(log.suffix(50))]
    }

    private func renderRange(_ range: RenderRange, index: Int) async throws {
        let asset = AVURLAsset(url: URL(fileURLWithPath: inputPath))
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
            throw pfxError("AVAssetExportSession unavailable")
        }
        exportSession = session

        let scale: CMTimeScale = 90_000
        let startT = fps > 0 ? CMTime(value: CMTimeValue(Double(range.inFrame)  * Double(scale) / fps), timescale: scale) : .zero
        let endT   = fps > 0 ? CMTime(value: CMTimeValue(Double(range.outFrame) * Double(scale) / fps), timescale: scale) : .zero
        session.timeRange = CMTimeRange(start: startT, end: endT)

        let ext     = (outputPath as NSString).pathExtension
        let base    = ((outputPath as NSString).lastPathComponent as NSString).deletingPathExtension
        let dir     = (outputPath as NSString).deletingLastPathComponent
        let outName = "\(base)_\(index + 1)_\(range.label).\(ext.isEmpty ? "mov" : ext)"
        let outURL  = URL(fileURLWithPath: "\(dir)/\(outName)")
        try? FileManager.default.removeItem(at: outURL)

        session.outputURL      = outURL
        session.outputFileType = outURL.pathExtension.lowercased() == "mov" ? .mov : .mp4

        let rangesCount = ranges.count
        let pollTask = Task {
            while !Task.isCancelled {
                let p = Double(session.progress)
                progress = (Double(index) + p) / Double(rangesCount)
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        await session.export()
        pollTask.cancel()

        if let err = session.error { throw err }
        if session.status != .completed {
            throw pfxError("Export status: \(session.status.rawValue)")
        }
    }

    private func addLog(_ msg: String) {
        let ts = ISO8601DateFormatter().string(from: Date())
        log.append("[\(ts)] \(msg)")
    }

    private func writeReport() async {
        let reportPath = (outputPath as NSString).deletingLastPathComponent + "/render_\(jobId).log"
        try? log.joined(separator: "\n").write(toFile: reportPath, atomically: true, encoding: .utf8)
    }
}

// ── RenderEngine actor ─────────────────────────────────────────────────────────

actor RenderEngine {
    private let mediaEngine: MediaEngine
    private var jobs: [String: RenderJob] = [:]
    private var jobIdCounter = 0

    init(mediaEngine: MediaEngine) { self.mediaEngine = mediaEngine }

    func createJob(payload: [String: Any]) async throws -> Any {
        guard let inputPath  = payload["inputPath"]  as? String,
              let outputPath = payload["outputPath"] as? String else {
            throw pfxError("inputPath and outputPath required")
        }
        let fps       = payload["fps"] as? Double ?? 24.0
        let rawRanges = payload["ranges"] as? [[String: Any]] ?? []
        let ranges: [RenderRange] = rawRanges.compactMap { r in
            guard let i = r["inFrame"] as? Int, let o = r["outFrame"] as? Int else { return nil }
            return RenderRange(inFrame: i, outFrame: o, label: r["label"] as? String ?? "range")
        }
        guard !ranges.isEmpty else { throw pfxError("At least one range required") }

        jobIdCounter += 1
        let jobId = "render-\(jobIdCounter)"
        let job   = RenderJob(jobId: jobId, inputPath: inputPath, outputPath: outputPath,
                               ranges: ranges, fps: fps)
        jobs[jobId] = job
        Task { await job.run() }
        return ["ok": true, "jobId": jobId, "status": "queued", "rangeCount": ranges.count]
    }

    func pauseJob(payload: [String: Any]) async throws -> Any {
        let job = try resolveJob(payload); await job.pause()
        return ["ok": true, "jobId": job.jobId, "status": "paused"]
    }

    func cancelJob(payload: [String: Any]) async throws -> Any {
        let job = try resolveJob(payload); await job.cancel()
        jobs.removeValue(forKey: job.jobId)
        return ["ok": true, "jobId": job.jobId, "status": "cancelled"]
    }

    func getStatus(payload: [String: Any]) async throws -> Any {
        return try await resolveJob(payload).statusDict()
    }

    private func resolveJob(_ payload: [String: Any]) throws -> RenderJob {
        let id = payload["jobId"] as? String ?? ""
        guard let job = jobs[id] else { throw pfxError("Unknown jobId: \(id)") }
        return job
    }
}
