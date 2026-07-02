// CommandRouter.swift — maps JSON command types to engine methods

import Foundation
import PFXMediaCore

final class CommandRouter {
    private let engine: MediaEngine
    private let renderEngine: RenderEngine
    private let imfEngine: IMFEngine
    private let store: MediaStore?   // PFXMAC Sprint 3 — SQLite media database

    init(engine: MediaEngine, renderEngine: RenderEngine) {
        self.engine       = engine
        self.renderEngine = renderEngine
        self.imfEngine    = IMFEngine()
        self.store        = try? MediaStore(path: CommandRouter.defaultDbPath())
    }

    func route(type: String, payload: [String: Any]) async throws -> Any {
        switch type {
        // ── Media session
        case "media.open":   return try await engine.open(payload: payload)
        case "media.close":  return try await engine.close(payload: payload)
        case "media.probe":  return try await engine.probe(payload: payload)

        // ── Playback control (state tracking only; display is renderer-side)
        case "playback.play":     return try await engine.playbackPlay(payload: payload)
        case "playback.pause":    return try await engine.playbackPause(payload: payload)
        case "playback.seek":     return try await engine.playbackSeek(payload: payload)
        case "playback.setRate":  return try await engine.playbackSetRate(payload: payload)
        case "playback.setRange": return try await engine.playbackSetRange(payload: payload)

        // ── Frame / thumbnail / waveform
        case "frame.extract":      return try await engine.frameExtract(payload: payload)
        case "thumbnail.generate": return try await engine.thumbnailGenerate(payload: payload)
        case "waveform.generate":  return try await engine.waveformGenerate(payload: payload)

        // ── Proxy
        case "proxy.create": return try await engine.proxyCreate(payload: payload)
        case "proxy.status": return try await engine.proxyStatus(payload: payload)
        case "proxy.cancel": return try await engine.proxyCancel(payload: payload)

        // ── Render jobs
        case "render.createJob": return try await renderEngine.createJob(payload: payload)
        case "render.pauseJob":  return try await renderEngine.pauseJob(payload: payload)
        case "render.cancelJob": return try await renderEngine.cancelJob(payload: payload)
        case "render.getStatus": return try await renderEngine.getStatus(payload: payload)

        // ── IMF native decode (asdcplib + OpenJPEG + libplacebo)
        case "imf.openPackage":   return try await imfEngine.openPackage(payload: payload)
        case "imf.getInfo":       return try await imfEngine.getInfo(payload: payload)
        case "imf.seekFrame":     return try await imfEngine.seekFrame(payload: payload)
        case "imf.stepFrame":     return try await imfEngine.stepFrame(payload: payload)
        case "imf.grabThumbnail": return try await imfEngine.grabThumbnail(payload: payload)
        case "imf.closePackage":  return try await imfEngine.closePackage(payload: payload)

        // ── SQLite media database (PFXMAC Sprint 3)
        case "db.upsert":
            guard let store, let rec = Self.record(from: payload) else { throw Self.err("db.upsert: store unavailable or missing id/path") }
            try store.upsert(rec); return ["ok": true]
        case "db.get":
            guard let store, let id = payload["id"] as? String else { throw Self.err("db.get: missing id") }
            return try store.get(id: id).map { Self.dict($0) } ?? NSNull()
        case "db.search":
            guard let store else { throw Self.err("db.search: store unavailable") }
            return try store.search(payload["term"] as? String ?? "", limit: payload["limit"] as? Int ?? 100).map { Self.dict($0) }
        case "db.delete":
            guard let store, let id = payload["id"] as? String else { throw Self.err("db.delete: missing id") }
            return ["deleted": try store.delete(id: id)]
        case "db.count":
            guard let store else { throw Self.err("db.count: store unavailable") }
            return ["count": try store.count()]

        // ── Diagnostics
        case "engine.diagnostics": return try await Diagnostics.report(engine: engine)

        default:
            throw NSError(domain: "PFXNativeMediaEngine", code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Unknown command: \(type)"])
        }
    }

    // MARK: - db.* helpers

    private static func defaultDbPath() -> String {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("PostFlowX", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("media.db").path
    }

    private static func err(_ msg: String) -> NSError {
        NSError(domain: "PFXNativeMediaEngine", code: 400, userInfo: [NSLocalizedDescriptionKey: msg])
    }

    private static func record(from p: [String: Any]) -> MediaRecord? {
        guard let id = p["id"] as? String, let path = p["path"] as? String else { return nil }
        return MediaRecord(
            id: id, path: path,
            filename: (p["filename"] as? String) ?? (path as NSString).lastPathComponent,
            format: p["format"] as? String ?? "", codec: p["codec"] as? String ?? "",
            width: p["width"] as? Int ?? 0, height: p["height"] as? Int ?? 0,
            fps: p["fps"] as? Double ?? 0, durationFrames: p["durationFrames"] as? Int ?? 0,
            sizeBytes: (p["sizeBytes"] as? Int64) ?? Int64(p["sizeBytes"] as? Int ?? 0),
            modified: p["modified"] as? Double ?? 0,
            tcIn: p["tcIn"] as? String ?? "", tcOut: p["tcOut"] as? String ?? "",
            reel: p["reel"] as? String ?? "")
    }

    private static func dict(_ r: MediaRecord) -> [String: Any] {
        ["id": r.id, "path": r.path, "filename": r.filename, "format": r.format, "codec": r.codec,
         "width": r.width, "height": r.height, "fps": r.fps, "durationFrames": r.durationFrames,
         "sizeBytes": r.sizeBytes, "modified": r.modified,
         "tcIn": r.tcIn, "tcOut": r.tcOut, "reel": r.reel]
    }
}
