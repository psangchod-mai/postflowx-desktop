// MediaEngine.swift — Swift actor managing persistent AVAsset sessions

import Foundation
import AVFoundation
import CoreMedia

// ── MediaInfo ──────────────────────────────────────────────────────────────────

struct MediaInfo: Codable {
    let path: String
    let duration: Double
    let fps: Double
    let frameCount: Int
    let width: Int
    let height: Int
    let codec: String
    let isProRes: Bool
    let hasAudio: Bool
    let audioTrackCount: Int
    let hasTimecode: Bool
    let hwDecodeAvailable: Bool
    let bitrate: Double
    let container: String
    let colorSpace: String
    let hdr: Bool
    let needsProxy: Bool
}

struct PlaybackState {
    var playing = false
    var frame   = 0
    var rate    = 1.0
    var inPoint:  Int? = nil
    var outPoint: Int? = nil
    var droppedFrames = 0
}

// ── MediaSession ───────────────────────────────────────────────────────────────

final class MediaSession {
    let sessionId: String
    let path: String
    let asset: AVURLAsset
    var info: MediaInfo
    var state = PlaybackState()
    var proxyPath: String?
    var imageGenerator: AVAssetImageGenerator?

    init(sessionId: String, path: String, asset: AVURLAsset, info: MediaInfo) {
        self.sessionId = sessionId
        self.path      = path
        self.asset     = asset
        self.info      = info
    }

    func makeImageGenerator(outputWidth: Int) -> AVAssetImageGenerator {
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore  = CMTime(value: 1, timescale: 600)
        gen.requestedTimeToleranceAfter   = CMTime(value: 1, timescale: 600)
        if outputWidth > 0 {
            gen.maximumSize = CGSize(width: outputWidth, height: outputWidth)
        }
        return gen
    }
}

// ── MediaEngine actor ──────────────────────────────────────────────────────────

actor MediaEngine {
    private var sessions: [String: MediaSession] = [:]
    private var sessionIdCounter = 0
    private var proxyJobs: [String: ProxyCreator] = [:]
    private var proxyJobIdCounter = 0
    private var activeDecoderSessionId: String?

    // ── Session open/close/probe ───────────────────────────────────────────────

    func open(payload: [String: Any]) async throws -> Any {
        guard let path = payload["path"] as? String else { throw pfxError("path required") }

        if let existing = sessions.values.first(where: { $0.path == path }) {
            return sessionDict(existing)
        }

        guard FileManager.default.fileExists(atPath: path) else {
            throw pfxError("File not found: \(path)")
        }

        let asset = AVURLAsset(url: URL(fileURLWithPath: path),
            options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let info = try await probeAsset(asset, path: path)

        sessionIdCounter += 1
        let id      = "ses-\(sessionIdCounter)"
        let session = MediaSession(sessionId: id, path: path, asset: asset, info: info)
        session.imageGenerator = session.makeImageGenerator(outputWidth: 1280)
        sessions[id] = session
        return sessionDict(session)
    }

    func close(payload: [String: Any]) async throws -> Any {
        let id = payload["sessionId"] as? String ?? ""
        if let s = sessions[id] {
            s.imageGenerator?.cancelAllCGImageGeneration()
            if activeDecoderSessionId == id { activeDecoderSessionId = nil }
            sessions.removeValue(forKey: id)
        }
        return ["ok": true]
    }

    func probe(payload: [String: Any]) async throws -> Any {
        guard let path = payload["path"] as? String else { throw pfxError("path required") }
        guard FileManager.default.fileExists(atPath: path) else {
            throw pfxError("File not found: \(path)")
        }
        let asset = AVURLAsset(url: URL(fileURLWithPath: path),
            options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
        let info = try await probeAsset(asset, path: path)
        return mediaInfoDict(info)
    }

    // ── Playback state (renderer drives display; engine tracks state) ──────────

    func playbackPlay(payload: [String: Any]) async throws -> Any {
        let s = try session(payload)
        s.state.playing = true
        activeDecoderSessionId = s.sessionId
        return playbackStateDict(s)
    }

    func playbackPause(payload: [String: Any]) async throws -> Any {
        let s = try session(payload); s.state.playing = false
        return playbackStateDict(s)
    }

    func playbackSeek(payload: [String: Any]) async throws -> Any {
        let s = try session(payload)
        if let f = payload["frame"] as? Int {
            s.state.frame = max(0, min(f, s.info.frameCount - 1))
        } else if let t = payload["time"] as? Double, s.info.fps > 0 {
            s.state.frame = max(0, min(Int(t * s.info.fps), s.info.frameCount - 1))
        } else if let tc = payload["timecode"] as? String {
            s.state.frame = tcToFrame(tc, fps: s.info.fps)
        }
        return playbackStateDict(s)
    }

    func playbackSetRate(payload: [String: Any]) async throws -> Any {
        let s = try session(payload)
        s.state.rate = payload["rate"] as? Double ?? 1.0
        return playbackStateDict(s)
    }

    func playbackSetRange(payload: [String: Any]) async throws -> Any {
        let s = try session(payload)
        if let i = payload["inPoint"]  as? Int { s.state.inPoint  = i }
        if let o = payload["outPoint"] as? Int { s.state.outPoint = o }
        return playbackStateDict(s)
    }

    // ── Frame extraction (hot path — session reuses AVAssetImageGenerator) ─────

    func frameExtract(payload: [String: Any]) async throws -> Any {
        let s           = try session(payload)
        let outputWidth = payload["outputWidth"] as? Int    ?? 1280
        let quality     = payload["quality"]     as? Double ?? 0.88
        let frame       = payload["frame"]       as? Int    ?? s.state.frame

        // Reuse cached generator; rebuild only if width changed
        var gen = s.imageGenerator
        if gen == nil || (outputWidth > 0 && gen!.maximumSize.width != CGFloat(outputWidth)) {
            let g = s.makeImageGenerator(outputWidth: outputWidth)
            s.imageGenerator = g
            gen = g
        }

        let time = frameTime(frame, fps: s.info.fps)
        return try await withCheckedThrowingContinuation { cont in
            gen!.generateCGImagesAsynchronously(forTimes: [NSValue(time: time)]) { _, img, _, status, err in
                if status == .succeeded, let image = img,
                   let b64 = MediaEngine.jpegBase64(image, width: outputWidth, quality: quality) {
                    cont.resume(returning: [
                        "ok":           true,
                        "frame":        frame,
                        "dataUrl":      "data:image/jpeg;base64,\(b64)",
                        "imageDataUrl": "data:image/jpeg;base64,\(b64)",
                        "decoder":      "AVFoundation+VideoToolbox",
                        "hwDecode":     true,
                    ] as [String: Any])
                } else {
                    cont.resume(throwing: pfxError(err?.localizedDescription ?? "Frame extraction failed"))
                }
            }
        }
    }

    // ── Thumbnail generation ───────────────────────────────────────────────────

    func thumbnailGenerate(payload: [String: Any]) async throws -> Any {
        let sessionId   = payload["sessionId"] as? String ?? ""
        let path        = payload["path"]       as? String
        let outputWidth = payload["outputWidth"] as? Int    ?? 320
        let count       = payload["count"]       as? Int    ?? 7
        let quality     = payload["quality"]     as? Double ?? 0.80
        let outputDir   = payload["outputDir"]   as? String

        let asset: AVURLAsset
        let info: MediaInfo
        if let s = sessions[sessionId] {
            asset = s.asset; info = s.info
        } else if let p = path, FileManager.default.fileExists(atPath: p) {
            asset = AVURLAsset(url: URL(fileURLWithPath: p))
            info  = try await probeAsset(asset, path: p)
        } else {
            throw pfxError("sessionId or valid path required")
        }

        let gen = ThumbnailGenerator(asset: asset, info: info)
        return try await gen.generate(count: count, outputWidth: outputWidth,
                                      quality: quality, outputDir: outputDir)
    }

    // ── Waveform generation ────────────────────────────────────────────────────

    func waveformGenerate(payload: [String: Any]) async throws -> Any {
        let s       = try session(payload)
        let buckets = payload["buckets"] as? Int ?? 1000
        let channel = payload["channel"] as? Int ?? 0
        let gen     = WaveformGenerator(asset: s.asset)
        return try await gen.generate(buckets: buckets, channel: channel)
    }

    // ── Proxy creation (background, VideoToolbox-accelerated) ─────────────────

    func proxyCreate(payload: [String: Any]) async throws -> Any {
        let s         = try session(payload)
        let outputDir = payload["outputDir"] as? String ?? defaultCacheDir(for: s.path, sub: "proxies")
        let width     = payload["width"]   as? Int    ?? 960
        let height    = payload["height"]  as? Int    ?? 0
        let quality   = payload["quality"] as? String ?? "medium"

        proxyJobIdCounter += 1
        let jobId   = "proxy-\(proxyJobIdCounter)"
        let creator = ProxyCreator(asset: s.asset, info: s.info, outputDir: outputDir,
                                   width: width, height: height, quality: quality, jobId: jobId)
        proxyJobs[jobId] = creator

        let sessionId = s.sessionId
        Task {
            let result = await creator.run()
            await self.handleProxyComplete(sessionId: sessionId, jobId: jobId, result: result)
        }
        return ["ok": true, "jobId": jobId, "status": "queued"]
    }

    func proxyStatus(payload: [String: Any]) async throws -> Any {
        let jobId = payload["jobId"] as? String ?? ""
        guard let creator = proxyJobs[jobId] else { throw pfxError("Unknown jobId: \(jobId)") }
        return await creator.currentStatus()
    }

    func proxyCancel(payload: [String: Any]) async throws -> Any {
        let jobId = payload["jobId"] as? String ?? ""
        if let creator = proxyJobs[jobId] { await creator.cancel(); proxyJobs.removeValue(forKey: jobId) }
        return ["ok": true]
    }

    private func handleProxyComplete(sessionId: String, jobId: String, result: [String: Any]) {
        sessions[sessionId]?.proxyPath  = result["outputPath"] as? String
    }

    // ── Diagnostics helpers ────────────────────────────────────────────────────

    func activeSessions() -> Int  { sessions.count }
    func playingSessionId() -> String? { activeDecoderSessionId }

    // ── Internal helpers ───────────────────────────────────────────────────────

    private func probeAsset(_ asset: AVURLAsset, path: String) async throws -> MediaInfo {
        async let duration    = asset.load(.duration)
        async let videoTracks = asset.loadTracks(withMediaType: .video)
        async let audioTracks = asset.loadTracks(withMediaType: .audio)
        async let tcTracks    = asset.loadTracks(withMediaType: .timecode)

        let (dur, vTracks, aTracks, tTracks) = try await (duration, videoTracks, audioTracks, tcTracks)

        var width = 0, height = 0, fps = 24.0, codec = "", bitrate = 0.0, isProRes = false

        if let vt = vTracks.first {
            async let sz      = vt.load(.naturalSize)
            async let tx      = vt.load(.preferredTransform)
            async let nomFps  = vt.load(.nominalFrameRate)
            async let fmts    = vt.load(.formatDescriptions)
            async let br      = vt.load(.estimatedDataRate)

            let (size, transform, nfps, fmtDescs, estBR) = try await (sz, tx, nomFps, fmts, br)
            let transformed = size.applying(transform)
            width   = Int(abs(transformed.width))  > 0 ? Int(abs(transformed.width))  : Int(size.width)
            height  = Int(abs(transformed.height)) > 0 ? Int(abs(transformed.height)) : Int(size.height)
            fps     = Double(nfps) > 0 ? Double(nfps) : 24.0
            bitrate = Double(estBR)
            if let fd = fmtDescs.first {
                codec    = fourCC(CMFormatDescriptionGetMediaSubType(fd))
                isProRes = codec.hasPrefix("apc") || codec.hasPrefix("ap4")
            }
        }

        let durationSec = CMTimeGetSeconds(dur)
        let frameCount  = fps > 0 ? Int(durationSec * fps) : 0
        let needsProxy  = (width * height >= 3840 * 2160) || isProRes || bitrate > 50_000_000
        let ext         = (path as NSString).pathExtension.lowercased()

        return MediaInfo(
            path: path, duration: durationSec, fps: fps, frameCount: frameCount,
            width: width, height: height, codec: codec, isProRes: isProRes,
            hasAudio: !aTracks.isEmpty, audioTrackCount: aTracks.count,
            hasTimecode: !tTracks.isEmpty, hwDecodeAvailable: true, bitrate: bitrate,
            container: ext, colorSpace: "rec709", hdr: false, needsProxy: needsProxy
        )
    }

    private func session(_ payload: [String: Any]) throws -> MediaSession {
        let id = payload["sessionId"] as? String ?? ""
        guard let s = sessions[id] else { throw pfxError("Unknown sessionId: \(id)") }
        return s
    }

    private func sessionDict(_ s: MediaSession) -> [String: Any] {
        var d = mediaInfoDict(s.info)
        d["sessionId"] = s.sessionId
        if let pp = s.proxyPath { d["proxyPath"] = pp }
        return d
    }

    private func mediaInfoDict(_ info: MediaInfo) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(info),
              var d    = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ["ok": true] }
        d["ok"] = true
        return d
    }

    private func playbackStateDict(_ s: MediaSession) -> [String: Any] {
        ["ok": true, "sessionId": s.sessionId, "playing": s.state.playing,
         "frame": s.state.frame, "rate": s.state.rate, "droppedFrames": s.state.droppedFrames]
    }

    // ── JPEG encode + base64 ───────────────────────────────────────────────────

    static func jpegBase64(_ image: CGImage, width: Int, quality: Double) -> String? {
        let srcW = image.width, srcH = image.height
        let dstW = (width > 0 && width < srcW) ? width : srcW
        let dstH = dstW == srcW ? srcH : max(1, Int(Double(srcH) * Double(dstW) / Double(srcW)))
        guard let ctx = CGContext(
            data: nil, width: dstW, height: dstH, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: dstW, height: dstH))
        guard let scaled = ctx.makeImage() else { return nil }
        let buf = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(buf as CFMutableData, "public.jpeg" as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(dest, scaled,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return buf.base64EncodedString()
    }
}

// ── Free helpers ───────────────────────────────────────────────────────────────

func pfxError(_ msg: String) -> NSError {
    NSError(domain: "PFXNativeMediaEngine", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
}

func fourCC(_ v: FourCharCode) -> String {
    let b: [UInt8] = [UInt8((v>>24)&0xFF), UInt8((v>>16)&0xFF), UInt8((v>>8)&0xFF), UInt8(v&0xFF)]
    return (String(bytes: b, encoding: .ascii) ?? "????").trimmingCharacters(in: .whitespaces)
}

func frameTime(_ frame: Int, fps: Double) -> CMTime {
    guard fps > 0 else { return .zero }
    let scale: CMTimeScale = 90_000
    return CMTime(value: CMTimeValue(Double(frame) * Double(scale) / fps), timescale: scale)
}

func tcToFrame(_ tc: String, fps: Double) -> Int {
    let parts = tc.replacingOccurrences(of: ";", with: ":").split(separator: ":").compactMap { Int($0) }
    guard parts.count >= 4 else { return 0 }
    return (parts[0]*3600 + parts[1]*60 + parts[2]) * Int(fps.rounded()) + parts[3]
}

func defaultCacheDir(for filePath: String, sub: String) -> String {
    let dir = (filePath as NSString).deletingLastPathComponent
    return "\(dir)/.pfx_cache/\(sub)"
}
