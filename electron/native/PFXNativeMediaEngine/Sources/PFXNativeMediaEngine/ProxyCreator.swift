// ProxyCreator.swift — background VideoToolbox-accelerated proxy generation

import Foundation
import AVFoundation

actor ProxyCreator {
    let jobId: String
    private let asset: AVURLAsset
    private let info: MediaInfo
    private let outputDir: String
    private let width: Int
    private let height: Int
    private let quality: String
    private(set) var _progress: Double = 0
    private(set) var _status   = "queued"
    private(set) var _outputPath: String?
    private(set) var _error: String?
    private var exportSession: AVAssetExportSession?
    private var _cancelled = false

    init(asset: AVURLAsset, info: MediaInfo, outputDir: String,
         width: Int, height: Int, quality: String, jobId: String) {
        self.asset     = asset; self.info = info; self.outputDir = outputDir
        self.width     = width; self.height = height; self.quality = quality; self.jobId = jobId
    }

    func run() async -> [String: Any] {
        do    { return try await export() }
        catch {
            _status = "failed"; _error = error.localizedDescription
            return ["ok": false, "jobId": jobId, "error": error.localizedDescription]
        }
    }

    func currentStatus() -> [String: Any] {
        ["ok": true, "jobId": jobId, "status": _status,
         "progress": _progress, "outputPath": _outputPath as Any, "error": _error as Any]
    }

    func cancel() {
        _cancelled = true; exportSession?.cancelExport(); _status = "cancelled"
    }

    private func export() async throws -> [String: Any] {
        _status = "running"
        try FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

        let baseName = ((info.path as NSString).lastPathComponent as NSString).deletingPathExtension
        let outPath  = "\(outputDir)/\(baseName)_proxy_\(width)p.mp4"
        let outURL   = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: outURL)

        let preset = quality == "high" ? AVAssetExportPreset1920x1080
                   : quality == "low"  ? AVAssetExportPreset640x480
                                       : AVAssetExportPreset960x540

        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
            throw pfxError("AVAssetExportSession unavailable for preset: \(preset)")
        }
        exportSession = session
        session.outputURL      = outURL
        session.outputFileType = .mp4

        if width > 0, info.width > 0, info.height > 0 {
            let dstH = max(2, Int((Double(width) / Double(info.width) * Double(info.height)).rounded() / 2) * 2)
            let comp = AVMutableVideoComposition(propertiesOf: asset)
            comp.renderSize = CGSize(width: width, height: dstH)
            session.videoComposition = comp
        }

        let pollTask = Task {
            while !Task.isCancelled {
                _progress = Double(session.progress)
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        await session.export()
        pollTask.cancel()

        if _cancelled { throw pfxError("Cancelled") }

        switch session.status {
        case .completed:
            _status = "completed"; _progress = 1.0; _outputPath = outPath
            return ["ok": true, "jobId": jobId, "status": "completed", "outputPath": outPath, "progress": 1.0]
        case .failed:
            throw session.error ?? pfxError("Export failed")
        case .cancelled:
            throw pfxError("Cancelled")
        default:
            throw pfxError("Unexpected export status: \(session.status.rawValue)")
        }
    }
}
