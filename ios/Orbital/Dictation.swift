import AVFoundation
import SwiftUI

// Dictation in Quick Add, as Codex dictates: the microphone recorded (AAC, 16 kHz mono, small to send) with its level
// sampled for the dots that move while you speak, then sent to ChatGPT as a whole (ChatGPT.transcribe) once stopped.
@MainActor @Observable
final class Dictation {
    static let dots = 28
    private(set) var levels = Array(repeating: Float(0), count: dots) // 0...1, newest last
    private(set) var recording = false
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var meter: Timer?
    private let file = FileManager.default.temporaryDirectory.appending(path: "dictation.m4a")

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio)
        try session.setActive(true)
        let recorder = try AVAudioRecorder(url: file, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1])
        recorder.isMeteringEnabled = true
        guard recorder.record() else { throw ChatGPT.Failure(errorDescription: "The microphone did not start") }
        self.recorder = recorder
        recording = true
        meter = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.sample() } }
    }

    private func sample() {
        guard let recorder else { return }
        recorder.updateMeters()
        levels = Array(levels.dropFirst()) + [max(0, min(1, (recorder.averagePower(forChannel: 0) + 50) / 45))] // -50 dB is silence
    }

    // the recording, stopped; nil when there was none
    func stop() -> Data? {
        guard let recorder else { return nil }
        recorder.stop()
        end()
        defer { try? FileManager.default.removeItem(at: file) }
        return try? Data(contentsOf: file)
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        end()
    }

    private func end() {
        meter?.invalidate(); meter = nil
        recorder = nil
        recording = false
        levels = Array(repeating: 0, count: Self.dots)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// The dots while recording: one per sample, newest on the right, each taller as you speak louder, fading out at both ends
struct Listening: View {
    let levels: [Float]
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                Capsule().fill(.secondary).frame(width: 4, height: 4 + CGFloat(level) * 16)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.08), .init(color: .black, location: 0.92), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
        .animation(.linear(duration: 0.06), value: levels)
        .accessibilityLabel("Listening")
    }
}
