// CommandRouter.swift — maps JSON command types to engine methods

import Foundation

final class CommandRouter {
    private let engine: MediaEngine
    private let renderEngine: RenderEngine
    private let imfEngine: IMFEngine

    init(engine: MediaEngine, renderEngine: RenderEngine) {
        self.engine       = engine
        self.renderEngine = renderEngine
        self.imfEngine    = IMFEngine()
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

        // ── Diagnostics
        case "engine.diagnostics": return try await Diagnostics.report(engine: engine)

        default:
            throw NSError(domain: "PFXNativeMediaEngine", code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Unknown command: \(type)"])
        }
    }
}
