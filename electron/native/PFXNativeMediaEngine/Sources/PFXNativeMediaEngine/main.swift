// PFXNativeMediaEngine — main.swift
// Persistent HTTP media engine for PostFlowX. Writes the assigned port to stdout
// on the line "PFX_ENGINE_PORT:<n>" so the Electron launcher can discover it.

import Foundation
import AVFoundation

let mediaEngine  = MediaEngine()
let renderEngine = RenderEngine(mediaEngine: mediaEngine)
let router       = CommandRouter(engine: mediaEngine, renderEngine: renderEngine)
let httpServer   = HTTPServer(router: router)

do {
    let port = try httpServer.start()
    print("PFX_ENGINE_PORT:\(port)")
    fflush(stdout)
} catch {
    fputs("PFXNativeMediaEngine: failed to start HTTP server: \(error)\n", stderr)
    exit(1)
}

RunLoop.main.run()
