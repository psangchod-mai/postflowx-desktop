// avf_bridge.swift — AVFoundation media bridge for PostFlowX
// Reads a JSON command from stdin, writes a JSON result to stdout.
// Errors go to stderr (media_engine.js logs them to avf-bridge.log).
//
// Actions: getInfo | getStill | getStills | getHeroFrames
//
// Build (universal binary):
//   swiftc avf_bridge.swift -o avf_bridge_arm64 -target arm64-apple-macos12.0 \
//     -framework AVFoundation -framework Foundation \
//     -framework CoreGraphics -framework ImageIO
//   swiftc avf_bridge.swift -o avf_bridge_x86 -target x86_64-apple-macos12.0 \
//     -framework AVFoundation -framework Foundation \
//     -framework CoreGraphics -framework ImageIO
//   lipo -create avf_bridge_arm64 avf_bridge_x86 -output avf_bridge

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

// ─── Input types ─────────────────────────────────────────────────────────────

struct Command: Decodable {
    let action: String
    let path: String?
    let frame: Int?
    let timecode: String?
    // Camera OCF runs free-run timecode; when present, `timecode` is interpreted
    // RELATIVE to this start TC (target frame = tcToFrame(timecode) − tcToFrame(startTimecode)).
    let startTimecode: String?
    let outputWidth: Int?
    let quality: Double?
    let frames: [FrameSpec]?
}

struct FrameSpec: Decodable {
    let frame: Int?
    let timecode: String?
    let startTimecode: String?
    let label: String?
}

// ─── Output helpers ───────────────────────────────────────────────────────────

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let str  = String(data: data, encoding: .utf8)
    else {
        print(#"{"ok":false,"error":"JSON serialization failed"}"#)
        fflush(stdout)
        return
    }
    print(str)
    fflush(stdout)
}

func emitError(_ msg: String) { emit(["ok": false, "error": msg]) }

// ─── Media helpers ────────────────────────────────────────────────────────────

func fourCC(_ v: FourCharCode) -> String {
    let bytes: [UInt8] = [
        UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF),
        UInt8((v >>  8) & 0xFF), UInt8((v      ) & 0xFF),
    ]
    return (String(bytes: bytes, encoding: .ascii) ?? "????")
        .trimmingCharacters(in: .whitespaces)
}

func jpegBase64(_ image: CGImage, width: Int, quality: Double) -> String? {
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

    let buf  = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(
        buf as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, scaled,
        [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return buf.base64EncodedString()
}

// "HH:MM:SS:FF" or "HH:MM:SS;FF" (drop-frame) → frame number
func tcToFrame(_ tc: String, fps: Double) -> Int {
    let normalized = tc.replacingOccurrences(of: ";", with: ":")
    let parts = normalized.split(separator: ":").compactMap { Int($0) }
    guard parts.count >= 4 else { return 0 }
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * Int(fps.rounded()) + parts[3]
}

// Frame number → CMTime using a high-precision timescale
func frameTime(_ f: Int, fps: Double) -> CMTime {
    guard fps > 0 else { return .zero }
    let scale: CMTimeScale = 90_000
    let value = CMTimeValue(Double(f) * Double(scale) / fps)
    return CMTime(value: value, timescale: scale)
}

// ─── run(async:) — run an async block synchronously from main ─────────────────

func runSync<T>(_ block: @Sendable @escaping () async throws -> T) -> Result<T, Error> {
    let sem = DispatchSemaphore(value: 0)
    var result: Result<T, Error> = .failure(NSError(domain: "avf_bridge", code: -1))
    Task {
        do    { result = .success(try await block()) }
        catch { result = .failure(error) }
        sem.signal()
    }
    sem.wait()
    return result
}

// ─── getInfo ──────────────────────────────────────────────────────────────────

func handleGetInfo(filePath: String) {
    guard FileManager.default.fileExists(atPath: filePath) else {
        emitError("File not found: \(filePath)"); return
    }

    let asset = AVURLAsset(url: URL(fileURLWithPath: filePath),
                           options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])

    let r = runSync {
        async let duration   = asset.load(.duration)
        async let videoTracks = asset.loadTracks(withMediaType: .video)
        async let audioTracks = asset.loadTracks(withMediaType: .audio)
        async let tcTracks   = asset.loadTracks(withMediaType: .timecode)

        let (dur, vTracks, aTracks, tTracks) = try await (duration, videoTracks, audioTracks, tcTracks)

        var info: [String: Any] = [
            "ok":            true,
            "path":          filePath,
            "duration":      CMTimeGetSeconds(dur),
            "hasAudio":      !aTracks.isEmpty,
            "audioTrackCount": aTracks.count,
            "hasTimecode":   !tTracks.isEmpty,
            "hwDecode":      true,
        ]

        if let vt = vTracks.first {
            async let size      = vt.load(.naturalSize)
            async let transform = vt.load(.preferredTransform)
            async let fps       = vt.load(.nominalFrameRate)
            async let fmts      = vt.load(.formatDescriptions)

            let (sz, tx, nomFps, formatDescs) = try await (size, transform, fps, fmts)
            let transformed = sz.applying(tx)
            let w = Int(abs(transformed.width)), h = Int(abs(transformed.height))

            info["width"]      = w > 0 ? w : Int(sz.width)
            info["height"]     = h > 0 ? h : Int(sz.height)
            info["fps"]        = Double(nomFps)
            info["frameCount"] = nomFps > 0 ? Int(CMTimeGetSeconds(dur) * Double(nomFps)) : 0

            if let fd = formatDescs.first {
                let sub      = CMFormatDescriptionGetMediaSubType(fd)
                let codecStr = fourCC(sub)
                info["codec"]    = codecStr
                info["isProRes"] = codecStr.hasPrefix("apc") || codecStr.hasPrefix("ap4")
            }
        }

        return info
    }

    switch r {
    case .success(let info): emit(info)
    case .failure(let err):  emitError(err.localizedDescription)
    }
}

// ─── getStill (single frame) ──────────────────────────────────────────────────
// Delegates to the batch handler with a single FrameSpec to avoid
// the deprecated copyCGImage(at:actualTime:) API.

func handleGetStill(filePath: String, frame: Int?, timecode: String?,
                    startTimecode: String?, width: Int, quality: Double) {
    let spec = FrameSpec(frame: frame, timecode: timecode,
                         startTimecode: startTimecode, label: "single")
    let r = runSync {
        return try await batchExtract(filePath: filePath, frames: [spec],
                                      width: width, quality: quality)
    }
    switch r {
    case .failure(let err):
        emitError(err.localizedDescription)
    case .success(let batch):
        guard let first = (batch["frames"] as? [[String: Any]])?.first else {
            emitError("No frame returned"); return
        }
        if let ok = first["ok"] as? Bool, !ok {
            emit(first)
        } else {
            var out = first
            out["timecode"] = timecode ?? ""
            out["extractor"] = "avf"
            emit(out)
        }
    }
}

// ─── batchExtract — shared async core ────────────────────────────────────────
// All frame extraction (single or batch) flows through here.
// Uses withCheckedContinuation to bridge generateCGImagesAsynchronously
// into async/await — no DispatchSemaphore inside an async context.

func batchExtract(filePath: String, frames: [FrameSpec],
                  width: Int, quality: Double) async throws -> [String: Any] {
    guard !frames.isEmpty else {
        return ["ok": true, "frames": [] as [[String: Any]], "decoder": "AVFoundation"]
    }
    guard FileManager.default.fileExists(atPath: filePath) else {
        throw NSError(domain: "avf_bridge", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "File not found: \(filePath)"])
    }

    let asset  = AVURLAsset(url: URL(fileURLWithPath: filePath))
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let vt = tracks.first else {
        throw NSError(domain: "avf_bridge", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "No video track"])
    }

    let fps  = Double(try await vt.load(.nominalFrameRate))
    let dur  = CMTimeGetSeconds(try await asset.load(.duration))
    let maxF = fps > 0 ? max(0, Int(dur * fps) - 1) : 0

    // Build parallel arrays aligned by index
    var times:     [NSValue] = []
    var labels:    [String]  = []
    var frameNums: [Int]     = []

    for spec in frames {
        let f: Int
        if let tc = spec.timecode, !tc.isEmpty {
            // Seek relative to the clip's own free-run start TC when supplied —
            // camera OCF timecode does not start at 00:00:00:00.
            let startF = (spec.startTimecode.map { $0.isEmpty ? 0 : tcToFrame($0, fps: fps) }) ?? 0
            f = min(max(0, tcToFrame(tc, fps: fps) - startF), maxF)
        } else { f = min(spec.frame ?? 0, maxF) }
        times.append(NSValue(time: frameTime(f, fps: fps)))
        labels.append(spec.label ?? (spec.timecode ?? "\(f)"))
        frameNums.append(f)
    }

    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.requestedTimeToleranceBefore   = CMTime(value: 1, timescale: 600)
    gen.requestedTimeToleranceAfter    = CMTime(value: 1, timescale: 600)

    // Build an Int64-keyed index queue for O(1) callback lookup.
    // CMTimeValue is Int64 (Sendable); avoids capturing [NSValue] in a @Sendable closure.
    // Different FrameSpecs routinely clamp to the same frame number (e.g. several
    // hero-frame offsets all landing on maxF for a short clip), so the same
    // CMTimeValue can appear at multiple indices. Each value maps to a queue of
    // its indices rather than a single Int, so every callback invocation — the
    // generator calls back once per element of `times`, including duplicates —
    // claims a distinct index instead of colliding on the same (last-written) one.
    var timeToIndices = [CMTimeValue: [Int]]()
    for (i, nv) in times.enumerated() { timeToIndices[nv.timeValue.value, default: []].append(i) }

    let labelSnapshot    = labels
    let frameNumSnapshot = frameNums
    let count            = times.count

    let results: [[String: Any]] = try await withCheckedThrowingContinuation { cont in
        var out       = [[String: Any]](repeating: [:], count: count)
        let lock      = NSLock()
        var remaining = count

        gen.generateCGImagesAsynchronously(forTimes: times) {
            reqT, img, actualT, status, err in
            lock.lock()
            let idx: Int
            if var indices = timeToIndices[reqT.value], !indices.isEmpty {
                idx = indices.removeFirst()
                timeToIndices[reqT.value] = indices
            } else {
                idx = 0
            }
            lock.unlock()
            let label = idx < labelSnapshot.count    ? labelSnapshot[idx]    : "\(idx)"
            let nomF  = idx < frameNumSnapshot.count ? frameNumSnapshot[idx] : 0

            let entry: [String: Any]
            if status == .succeeded, let image = img,
               let b64 = jpegBase64(image, width: width, quality: quality) {
                let actualF = fps > 0 ? Int(CMTimeGetSeconds(actualT) * fps) : nomF
                entry = [
                    "ok": true, "label": label, "frame": actualF,
                    "dataUrl":      "data:image/jpeg;base64,\(b64)",
                    "imageDataUrl": "data:image/jpeg;base64,\(b64)",
                    "decoder": "AVFoundation", "hwDecode": true,
                ]
            } else {
                entry = ["ok": false, "label": label,
                         "error": err?.localizedDescription ?? "extraction failed"]
            }

            lock.lock()
            out[idx] = entry
            remaining -= 1
            let done = remaining == 0
            lock.unlock()
            if done { cont.resume(returning: out) }
        }
    }

    return ["ok": true, "frames": results, "decoder": "AVFoundation"]
}

// ─── getStills / getHeroFrames ────────────────────────────────────────────────

func handleGetStills(filePath: String, frames: [FrameSpec], width: Int, quality: Double) {
    let r = runSync { try await batchExtract(filePath: filePath, frames: frames,
                                              width: width, quality: quality) }
    switch r {
    case .success(let obj): emit(obj)
    case .failure(let err): emitError(err.localizedDescription)
    }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let cmd = try? JSONDecoder().decode(Command.self, from: inputData) else {
    emitError("Failed to parse input JSON"); exit(1)
}

let fp      = cmd.path ?? ""
let width   = cmd.outputWidth ?? 960
let quality = cmd.quality ?? 0.88
let fspecs  = cmd.frames ?? []

switch cmd.action {
case "getInfo":
    guard !fp.isEmpty else { emitError("path required"); break }
    handleGetInfo(filePath: fp)
case "getStill":
    guard !fp.isEmpty else { emitError("path required"); break }
    handleGetStill(filePath: fp, frame: cmd.frame, timecode: cmd.timecode,
                   startTimecode: cmd.startTimecode, width: width, quality: quality)
case "getStills", "getHeroFrames":
    guard !fp.isEmpty else { emitError("path required"); break }
    handleGetStills(filePath: fp, frames: fspecs, width: width, quality: quality)
default:
    emitError("Unknown action: \(cmd.action)")
}
