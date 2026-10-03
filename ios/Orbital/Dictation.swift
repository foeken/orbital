import AVFoundation
import SwiftUI

// Dictation in Quick Add and the Ask Tana composer, as Codex dictates: the microphone recorded (AAC mono, 44.1 kHz, small
// to send) with its level sampled for the dots that move while you speak, then sent to ChatGPT as a whole
// (ChatGPT.transcribe) once stopped, its words handed to whoever is being dictated into.
@MainActor @Observable
final class Dictation {
    static let dots = 28
    private(set) var levels = Array(repeating: Float(0), count: dots) // 0...1, newest last
    private(set) var recording = false
    private(set) var transcribing = false
    private(set) var problem: String? // why listening or writing down did not work, to show under the box
    @ObservationIgnored private var heard: Task<Bool, Never>?
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var meter: Timer?
    private let file = FileManager.default.temporaryDirectory.appending(path: "dictation.m4a")

    // the waveform button: listening, once ChatGPT and the microphone may be used
    func listen() async {
        problem = nil
        guard ChatGPT.load() != nil else { problem = "Sign in with ChatGPT in Settings to dictate"; return }
        guard await AVAudioApplication.requestRecordPermission() else { problem = "Allow Orbital the microphone in the Settings app to dictate"; return }
        do { try start() } catch { problem = error.localizedDescription }
    }

    // ■: listening stops and the recording is written down, its words handed to into once they come
    // false when there was nothing to write down: a recording too short to keep, which it says
    @discardableResult func finish(into: @escaping (String) -> Void) -> Bool {
        guard let audio = stop() else { problem = "Too short to write down. Try again."; return false }
        transcribing = true
        heard = Task {
            defer { transcribing = false; heard = nil }
            do {
                guard let text = try await ChatGPT.transcribe(audio) else { problem = "Sign in with ChatGPT in Settings to dictate"; return false }
                let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !said.isEmpty { into(said) }
                return true
            } catch { problem = "Dictation: " + error.localizedDescription; return false }
        }
        return true
    }

    // Add or send while listening or writing down: listening stops and the words are waited for; false when they did not
    // come, so what was said is never lost without a word
    func settle(into: @escaping (String) -> Void) async -> Bool {
        if recording, !finish(into: into) { return false }
        return await heard?.value ?? true
    }

    private func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let recorder = try AVAudioRecorder(url: file, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1])
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
    private func stop() -> Data? {
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

// The controls: a microphone to start, the glyph alone as in Codex's composer; while listening ✕ to throw the recording away, the dots, and ■ to stop
// (Codex's own dictation bar); a spinner while the words are being written down
struct Dictate: View {
    let dictation: Dictation
    let into: (String) -> Void
    var body: some View {
        if dictation.recording {
            Round(symbol: "xmark", label: "Cancel dictation") { dictation.cancel() }
            Listening(levels: dictation.levels)
            Round(symbol: "stop.fill", label: "Stop dictating") { dictation.finish(into: into) }
        } else if dictation.transcribing {
            ProgressView().frame(width: 32, height: 32)
        } else {
            Button { Task { await dictation.listen() } } label: { Image(systemName: "mic").font(.system(size: 20)).foregroundStyle(.primary).frame(width: 34, height: 34) }
                .buttonStyle(.plain)
                .accessibilityLabel("Dictate")
        }
    }
}

// A round grey button: ✕ and ■ while listening
struct Round: View {
    let symbol: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Color(.tertiarySystemFill)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
