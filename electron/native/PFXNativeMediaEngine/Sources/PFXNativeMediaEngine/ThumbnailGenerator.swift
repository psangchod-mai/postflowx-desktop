// ThumbnailGenerator.swift — AVAssetImageGenerator-based thumbnail batch extraction

import Foundation
import AVFoundation
import CoreGraphics
import ImageIO

final class ThumbnailGenerator {
    private let asset: AVURLAsset
    private let info: MediaInfo

    init(asset: AVURLAsset, info: MediaInfo) {
        self.asset = asset
        self.info  = info
    }

    func generate(count: Int, outputWidth: Int, quality: Double, outputDir: String?) async throws -> Any {
        let fps        = info.fps
        let frameCount = info.frameCount
        guard frameCount > 0 && fps > 0 else {
            return ["ok": false, "error": "No video frames"] as [String: Any]
        }

        // Distribute evenly, always include first and last
        let step   = max(1, frameCount / max(1, count))
        var frames = (0..<count).map { i in min(i * step + step / 2, frameCount - 1) }
        if !frames.contains(0)              { frames.insert(0, at: 0) }
        if !frames.contains(frameCount - 1) { frames.append(frameCount - 1) }
        frames = Array(Set(frames)).sorted()

        var outDir: URL? = nil
        if let dir = outputDir {
            outDir = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: outDir!, withIntermediateDirectories: true)
        }

        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore  = CMTime(value: 2, timescale: 600)
        gen.requestedTimeToleranceAfter   = CMTime(value: 2, timescale: 600)
        if outputWidth > 0 { gen.maximumSize = CGSize(width: outputWidth, height: outputWidth) }

        let times: [NSValue] = frames.map { f in NSValue(time: frameTime(f, fps: fps)) }
        let timeToFrame = Dictionary(uniqueKeysWithValues: zip(times.map { $0.timeValue.value }, frames))

        return try await withCheckedThrowingContinuation { cont in
            var out       = [[String: Any]](repeating: [:], count: times.count)
            let lock      = NSLock()
            var remaining = times.count

            gen.generateCGImagesAsynchronously(forTimes: times) { reqT, img, _, status, err in
                let frameNum = timeToFrame[reqT.value] ?? 0
                let idx      = frames.firstIndex(of: frameNum) ?? 0
                var entry: [String: Any]

                if status == .succeeded, let image = img,
                   let b64 = MediaEngine.jpegBase64(image, width: outputWidth, quality: quality) {
                    var e: [String: Any] = [
                        "ok":           true,
                        "frame":        frameNum,
                        "time":         fps > 0 ? Double(frameNum) / fps : 0.0,
                        "dataUrl":      "data:image/jpeg;base64,\(b64)",
                        "imageDataUrl": "data:image/jpeg;base64,\(b64)",
                        "decoder":      "AVFoundation+VideoToolbox",
                    ]
                    if let dir = outDir {
                        let url = dir.appendingPathComponent(String(format: "thumb_%06d.jpg", frameNum))
                        if let data = Data(base64Encoded: b64) { try? data.write(to: url) }
                        e["diskPath"] = url.path
                    }
                    entry = e
                } else {
                    entry = ["ok": false, "frame": frameNum,
                             "error": err?.localizedDescription ?? "extraction failed"]
                }

                lock.lock()
                if idx < out.count { out[idx] = entry }
                remaining -= 1
                let done = remaining == 0
                lock.unlock()

                if done { cont.resume(returning: ["ok": true, "thumbnails": out] as [String: Any]) }
            }
        }
    }
}
