// IMFEngine.swift — IMF package session manager for PFXNativeMediaEngine
//
// Provides CPL-aware IMF operations through the native helper protocol:
//   imf.openPackage     — scan CPL/ASSETMAP, return timecode/codec/frame info
//   imf.getInfo         — return session metadata for an open package
//   imf.seekFrame       — decode one frame via pfx-helper child process
//   imf.stepFrame       — frame-accurate ±1 step via pfx-helper
//   imf.grabThumbnail   — JPEG thumbnail for scrub-bar hover
//   imf.closePackage    — release session resources
//
// This module wraps pfx-helper via a persistent child process, mirroring
// imf_native_decoder.js on the Node.js side.  The Swift layer is used when
// IMF commands arrive on the pfx:nativeEngine HTTP channel.

import Foundation

// MARK: - Types

struct IMFPackageSession {
    let packageId:      String
    let mxfPath:        String
    var currentFrame:   Int
    var frameCount:     Int
    var editRate:       Double
    var timecodeStart:  String
    var codec:          String
    var width:          Int
    var height:         Int
    var isHDR:          Bool
    var isDV:           Bool
    var dvProfile:      String?
    var helperProcess:  PfxHelperProcess?
}

// MARK: - IMFEngine

final class IMFEngine {

    // Active IMF sessions keyed by packageId
    private var sessions: [String: IMFPackageSession] = [:]
    private let lock = NSLock()

    // Path to the pfx-helper binary (resolved once at init)
    private let helperBinaryPath: String?

    init() {
        helperBinaryPath = IMFEngine.findHelperBinary()
    }

    // MARK: imf.openPackage

    func openPackage(payload: [String: Any]) async throws -> Any {
        guard let mxfPath = payload["mxfPath"] as? String else {
            throw engineError("mxfPath required")
        }
        guard FileManager.default.fileExists(atPath: mxfPath) else {
            throw engineError("MXF not found: \(mxfPath)")
        }

        guard let binPath = helperBinaryPath else {
            throw engineError("pfx-helper binary not found — build electron/imf/pfx-helper/")
        }

        let packageId = UUID().uuidString
        let helper    = PfxHelperProcess(binaryPath: binPath)
        try await helper.start()

        // Open the MXF file
        let openResp = try await helper.sendCommand("openFile", params: ["path": mxfPath])
        guard openResp["ok"] as? Bool == true else {
            let err = openResp["error"] as? String ?? "openFile failed"
            throw engineError(err)
        }

        // Retrieve metadata
        let infoResp = try await helper.sendCommand("getInfo", params: [:])
        let frameCount    = infoResp["frameCount"]    as? Int    ?? 0
        let editRate      = infoResp["editRate"]      as? Double ?? 24.0
        let timecodeStart = infoResp["timecodeStart"] as? String ?? "00:00:00:00"
        let codec         = infoResp["codec"]         as? String ?? "jpeg2000"
        let width         = infoResp["width"]         as? Int    ?? 0
        let height        = infoResp["height"]        as? Int    ?? 0
        let isHDR         = infoResp["isHDR"]         as? Bool   ?? false
        let isDV          = infoResp["isDV"]           as? Bool   ?? false
        let dvProfile     = infoResp["dvProfile"]     as? String

        var session = IMFPackageSession(
            packageId:      packageId,
            mxfPath:        mxfPath,
            currentFrame:   0,
            frameCount:     frameCount,
            editRate:       editRate,
            timecodeStart:  timecodeStart,
            codec:          codec,
            width:          width,
            height:         height,
            isHDR:          isHDR,
            isDV:           isDV,
            dvProfile:      dvProfile,
            helperProcess:  helper
        )

        lock.lock()
        sessions[packageId] = session
        lock.unlock()

        return [
            "ok":             true,
            "packageId":      packageId,
            "frameCount":     frameCount,
            "editRate":       editRate,
            "timecodeStart":  timecodeStart,
            "codec":          codec,
            "width":          width,
            "height":         height,
            "isHDR":          isHDR,
            "isDV":           isDV,
            "dvProfile":      dvProfile as Any,
        ]
    }

    // MARK: imf.getInfo

    func getInfo(payload: [String: Any]) async throws -> Any {
        guard let packageId = payload["packageId"] as? String,
              let session   = sessions[packageId] else {
            throw engineError("package not found")
        }
        return [
            "ok":            true,
            "packageId":     packageId,
            "frameCount":    session.frameCount,
            "editRate":      session.editRate,
            "timecodeStart": session.timecodeStart,
            "currentFrame":  session.currentFrame,
            "codec":         session.codec,
            "width":         session.width,
            "height":        session.height,
            "isHDR":         session.isHDR,
            "isDV":          session.isDV,
            "dvProfile":     session.dvProfile as Any,
        ]
    }

    // MARK: imf.seekFrame

    func seekFrame(payload: [String: Any]) async throws -> Any {
        guard let packageId = payload["packageId"] as? String else {
            throw engineError("packageId required")
        }
        guard let session = sessions[packageId], let helper = session.helperProcess else {
            throw engineError("package not open or pfx-helper not running")
        }

        let frame       = payload["frame"]       as? Int    ?? session.currentFrame
        let displayMode = payload["displayMode"] as? String ?? "sdr"
        let outputWidth = payload["outputWidth"] as? Int    ?? 1920

        let tmpPath  = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pfx_native_\(packageId)_\(frame)_\(UUID().uuidString).jpg").path

        let resp = try await helper.sendCommand("seekFrame", params: [
            "frame":       frame,
            "outputPath":  tmpPath,
            "displayMode": displayMode,
            "outputWidth": outputWidth,
        ])

        guard resp["ok"] as? Bool == true else {
            throw engineError(resp["error"] as? String ?? "seekFrame failed")
        }

        guard FileManager.default.fileExists(atPath: tmpPath),
              let imageData = try? Data(contentsOf: URL(fileURLWithPath: tmpPath)) else {
            throw engineError("output file not written: \(tmpPath)")
        }

        let b64 = imageData.base64EncodedString()
        try? FileManager.default.removeItem(atPath: tmpPath)

        lock.lock()
        sessions[packageId]?.currentFrame = frame
        lock.unlock()

        return [
            "ok":             true,
            "frame":          frame,
            "imageDataUrl":   "data:image/jpeg;base64,\(b64)",
            "toneMapApplied": resp["toneMapApplied"] as? Bool ?? false,
            "dvProfile":      resp["dvProfile"] as Any,
            "backend":        "pfx-helper",
        ]
    }

    // MARK: imf.stepFrame

    func stepFrame(payload: [String: Any]) async throws -> Any {
        guard let packageId = payload["packageId"] as? String else {
            throw engineError("packageId required")
        }
        guard let session = sessions[packageId], let helper = session.helperProcess else {
            throw engineError("package not open")
        }

        let rawDirection  = payload["direction"] as? String ?? "forward"
        let direction     = rawDirection == "backward" ? "backward" : "forward"
        let displayMode   = payload["displayMode"] as? String ?? "sdr"
        let outputWidth   = payload["outputWidth"] as? Int    ?? 1920
        let currentFrame  = session.currentFrame

        let tmpPath = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pfx_step_\(packageId)_\(currentFrame)_\(UUID().uuidString).jpg").path

        let resp = try await helper.sendCommand("stepFrame", params: [
            "direction":   direction,
            "outputPath":  tmpPath,
            "displayMode": displayMode,
            "outputWidth": outputWidth,
        ])

        guard resp["ok"] as? Bool == true else {
            throw engineError(resp["error"] as? String ?? "stepFrame failed")
        }

        let newFrame = resp["frame"] as? Int ?? (direction == "forward"
            ? min(currentFrame + 1, session.frameCount - 1)
            : max(currentFrame - 1, 0))

        guard let imageData = try? Data(contentsOf: URL(fileURLWithPath: tmpPath)) else {
            throw engineError("output file missing: \(tmpPath)")
        }

        let b64 = imageData.base64EncodedString()
        try? FileManager.default.removeItem(atPath: tmpPath)

        lock.lock()
        sessions[packageId]?.currentFrame = newFrame
        lock.unlock()

        return [
            "ok":           true,
            "frame":        newFrame,
            "imageDataUrl": "data:image/jpeg;base64,\(b64)",
            "backend":      "pfx-helper",
        ]
    }

    // MARK: imf.grabThumbnail

    func grabThumbnail(payload: [String: Any]) async throws -> Any {
        guard let packageId = payload["packageId"] as? String else {
            throw engineError("packageId required")
        }
        guard let session = sessions[packageId], let helper = session.helperProcess else {
            throw engineError("package not open")
        }

        let frame = payload["frame"] as? Int ?? session.currentFrame
        let width = payload["width"] as? Int ?? 320

        let tmpPath = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pfx_thumb_\(packageId)_\(frame)_\(UUID().uuidString).jpg").path

        let resp = try await helper.sendCommand("grabThumbnail", params: [
            "frame":      frame,
            "outputPath": tmpPath,
            "width":      width,
        ])

        guard resp["ok"] as? Bool == true else {
            throw engineError(resp["error"] as? String ?? "grabThumbnail failed")
        }

        guard let imageData = try? Data(contentsOf: URL(fileURLWithPath: tmpPath)) else {
            throw engineError("thumbnail file missing: \(tmpPath)")
        }

        let b64 = imageData.base64EncodedString()
        try? FileManager.default.removeItem(atPath: tmpPath)

        return [
            "ok":           true,
            "frame":        frame,
            "imageDataUrl": "data:image/jpeg;base64,\(b64)",
        ]
    }

    // MARK: imf.closePackage

    func closePackage(payload: [String: Any]) async throws -> Any {
        guard let packageId = payload["packageId"] as? String else {
            throw engineError("packageId required")
        }
        lock.lock()
        let session = sessions.removeValue(forKey: packageId)
        lock.unlock()

        if let helper = session?.helperProcess {
            try? await helper.sendCommand("close", params: [:])
            helper.terminate()
        }

        return ["ok": true]
    }

    // MARK: - Helpers

    private func engineError(_ msg: String) -> NSError {
        NSError(domain: "IMFEngine", code: 500,
                userInfo: [NSLocalizedDescriptionKey: msg])
    }

    private static func findHelperBinary() -> String? {
        // Search alongside the existing PFXNativeMediaEngine binary
        let bundleDir = Bundle.main.bundlePath
        let candidates = [
            "\(bundleDir)/../pfx_helper",
            "\(bundleDir)/pfx_helper",
            "/opt/homebrew/bin/pfx-helper",
            "/usr/local/bin/pfx-helper",
        ]
        for c in candidates {
            let resolved = (c as NSString).standardizingPath
            if FileManager.default.isExecutableFile(atPath: resolved) {
                return resolved
            }
        }
        return nil
    }
}

// MARK: - PfxHelperProcess

/// Manages a long-lived pfx-helper child process with JSON newline-delimited IPC.
final class PfxHelperProcess {
    private let binaryPath:  String
    private var process:     Process?
    private var inputPipe:   Pipe?
    private var outputPipe:  Pipe?
    private var seq:         Int = 0
    private var pending:     [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var readBuf:     String = ""
    private let lock =       NSLock()

    init(binaryPath: String) {
        self.binaryPath = binaryPath
    }

    func start() async throws {
        let p   = Process()
        let inp = Pipe()
        let out = Pipe()

        p.executableURL  = URL(fileURLWithPath: binaryPath)
        p.arguments      = ["--ipc"]
        p.standardInput  = inp
        p.standardOutput = out
        p.standardError  = Pipe()   // silence pfx-helper stderr

        try p.run()
        process    = p
        inputPipe  = inp
        outputPipe = out

        // Start reading responses
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self = self else { return }
            let chunk = String(data: handle.availableData, encoding: .utf8) ?? ""
            self.onData(chunk)
        }
    }

    private func onData(_ chunk: String) {
        lock.lock()
        readBuf += chunk
        var lines = readBuf.components(separatedBy: "\n")
        readBuf = lines.removeLast()   // keep incomplete last line
        lock.unlock()

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            guard let data = trimmed.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id   = json["id"] as? Int else { continue }

            lock.lock()
            let cont = pending.removeValue(forKey: id)
            lock.unlock()

            if let cont = cont {
                if json["ok"] as? Bool == false,
                   let err = json["error"] as? String {
                    cont.resume(throwing: NSError(domain: "PfxHelper", code: 500,
                        userInfo: [NSLocalizedDescriptionKey: err]))
                } else {
                    cont.resume(returning: json)
                }
            }
        }
    }

    func sendCommand(_ cmd: String, params: [String: Any]) async throws -> [String: Any] {
        guard let inp = inputPipe else {
            throw NSError(domain: "PfxHelper", code: 500,
                          userInfo: [NSLocalizedDescriptionKey: "process not started"])
        }

        lock.lock()
        seq += 1
        let id = seq
        lock.unlock()

        var msg: [String: Any] = ["id": id, "cmd": cmd]
        for (k, v) in params { msg[k] = v }

        let line = (try JSONSerialization.data(withJSONObject: msg)) + Data("\n".utf8)

        return try await withCheckedThrowingContinuation { cont in
            lock.lock()
            pending[id] = cont
            lock.unlock()

            do {
                try inp.fileHandleForWriting.write(contentsOf: line)
            } catch {
                lock.lock()
                pending.removeValue(forKey: id)
                lock.unlock()
                cont.resume(throwing: error)
            }
        }
    }

    func terminate() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        process?.terminate()
        process = nil
    }
}
