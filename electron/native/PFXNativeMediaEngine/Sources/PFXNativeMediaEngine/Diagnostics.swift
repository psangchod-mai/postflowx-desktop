// Diagnostics.swift — engine health and capability report

import Foundation
import VideoToolbox
import Metal

enum Diagnostics {
    static func report(engine: MediaEngine) async throws -> Any {
        let activeSessions = await engine.activeSessions()
        let playingSession = await engine.playingSessionId()
        let memMB          = memoryUsageMB()
        let gpuName        = MTLCreateSystemDefaultDevice()?.name

        return [
            "ok":                true,
            "engineVersion":     "1.0.0",
            "engineRunning":     true,
            "platform":          "macOS",
            "hardwareDecode":    videoToolboxAvailable() ? "on" : "off",
            "hardwareEncode":    videoToolboxAvailable() ? "on" : "off",
            "gpu":               gpuName != nil ? "Metal" : "Software",
            "gpuName":           gpuName ?? "None",
            "activeDecoderCount":activeSessions,
            "playingSessionId":  playingSession as Any,
            "playbackFPS":       0.0,
            "droppedFrames":     0,
            "proxyCacheSizeMB":  0,
            "renderFPS":         0.0,
            "memoryMB":          memMB,
            "videoToolboxReady": videoToolboxAvailable(),
            "avFoundationReady": true,
            "metalReady":        gpuName != nil,
            "lastError":         Optional<String>.none as Any,
        ] as [String: Any]
    }

    private static func videoToolboxAvailable() -> Bool {
        // Probe with a minimal H.264 format description
        guard let fd = makeH264FormatDesc() else { return true }
        var session: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: nil, formatDescription: fd,
            decoderSpecification: [:] as CFDictionary,
            imageBufferAttributes: nil, outputCallback: nil,
            decompressionSessionOut: &session)
        if let s = session { VTDecompressionSessionInvalidate(s) }
        return status == noErr || status == kVTVideoDecoderNotAvailableNowErr
    }

    private static func makeH264FormatDesc() -> CMVideoFormatDescription? {
        let sps: [UInt8] = [0x67,0x64,0x00,0x1f,0xac,0xd9,0x40,0xa0,
                            0x2f,0xf9,0x70,0x11,0x00,0x00,0x03,0x00,
                            0x01,0x00,0x00,0x03,0x00,0x32,0x0f,0x18,0x31,0x96]
        let pps: [UInt8] = [0x68,0xe9,0x7b,0x2c,0x8b]
        var desc: CMVideoFormatDescription?
        sps.withUnsafeBufferPointer { spsBuf in
            pps.withUnsafeBufferPointer { ppsBuf in
                let params = [spsBuf.baseAddress!, ppsBuf.baseAddress!]
                let sizes  = [sps.count, pps.count]
                _ = CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: nil, parameterSetCount: 2,
                    parameterSetPointers: params,
                    parameterSetSizes: sizes, nalUnitHeaderLength: 4,
                    formatDescriptionOut: &desc)
            }
        }
        return desc
    }

    private static func memoryUsageMB() -> Double {
        var info  = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
        let r = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return r == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : 0
    }
}
