// WaveformGenerator.swift — AVAssetReader + vDSP audio waveform extraction

import Foundation
import AVFoundation
import Accelerate

final class WaveformGenerator {
    private let asset: AVURLAsset

    init(asset: AVURLAsset) { self.asset = asset }

    func generate(buckets: Int, channel: Int) async throws -> Any {
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard !tracks.isEmpty else {
            return ["ok": false, "error": "No audio tracks"] as [String: Any]
        }
        let asset = self.asset
        return try await Task.detached(priority: .userInitiated) {
            try WaveformGenerator.compute(asset: asset, buckets: buckets, channel: channel)
        }.value
    }

    // Runs on a background thread (AVAssetReader must not block the actor)
    private static func compute(asset: AVURLAsset, buckets: Int, channel: Int) throws -> Any {
        let sem    = DispatchSemaphore(value: 0)
        var tracks: [AVAssetTrack] = []
        var loadErr: Error? = nil
        Task {
            do    { tracks  = try await asset.loadTracks(withMediaType: .audio) }
            catch { loadErr = error }
            sem.signal()
        }
        sem.wait()
        if let e = loadErr { throw e }
        guard let track = tracks.first else {
            return ["ok": false, "error": "No audio track"] as [String: Any]
        }

        let reader = try AVAssetReader(asset: asset)
        let outputSettings: [String: Any] = [
            AVFormatIDKey:             kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey:    32,
            AVLinearPCMIsFloatKey:     true,
            AVLinearPCMIsBigEndianKey: false,
            AVNumberOfChannelsKey:     2,
            AVSampleRateKey:           44100,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: outputSettings)
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else {
            return ["ok": false, "error": reader.error?.localizedDescription ?? "AVAssetReader failed"] as [String: Any]
        }

        var samples: [Float] = []
        while let sb = output.copyNextSampleBuffer(), let bb = CMSampleBufferGetDataBuffer(sb) {
            let len  = CMBlockBufferGetDataLength(bb)
            var data = Data(count: len)
            data.withUnsafeMutableBytes { ptr in
                _ = CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: ptr.baseAddress!)
            }
            samples.append(contentsOf: data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) })
        }

        guard !samples.isEmpty else {
            return ["ok": false, "error": "No audio samples decoded"] as [String: Any]
        }

        // Deinterleave: interleaved stereo (L R L R …) → channel selection
        let chCount = 2
        let mono: [Float]
        switch channel {
        case 1:  mono = stride(from: 0, to: samples.count, by: chCount).map { samples[$0] }
        case 2:  mono = stride(from: 1, to: samples.count, by: chCount).map { samples[min($0, samples.count-1)] }
        default: mono = samples
        }

        let perBucket = max(1, mono.count / buckets)
        var waveform: [[String: Double]] = []

        for i in 0..<buckets {
            let s = i * perBucket
            let e = min(s + perBucket, mono.count)
            guard s < mono.count else { waveform.append(["min": 0, "max": 0, "rms": 0]); continue }
            let slice = Array(mono[s..<e])
            var minV: Float = 0, maxV: Float = 0, rms: Float = 0
            vDSP_minv(slice, 1, &minV, vDSP_Length(slice.count))
            vDSP_maxv(slice, 1, &maxV, vDSP_Length(slice.count))
            vDSP_rmsqv(slice, 1, &rms,  vDSP_Length(slice.count))
            waveform.append(["min": Double(minV), "max": Double(maxV), "rms": Double(rms)])
        }

        return ["ok": true, "waveform": waveform, "buckets": buckets,
                "samples": mono.count, "decoder": "AVFoundation+vDSP"] as [String: Any]
    }
}
