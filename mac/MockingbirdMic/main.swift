import AVFoundation
import Foundation

// Mockingbird Mic: streams the Mac's default input as 16 kHz mono signed 16-bit
// little-endian PCM to stdout. It exists only so the microphone permission
// belongs to a named app ("Mockingbird Mic") instead of whichever terminal or
// agent launched the rig: macOS attributes a CLI's mic use to its responsible
// parent, and an unattended rig must not depend on that.
//
// Usage: open -W --stdout <fifo> -a MockingbirdMic.app --args [--seconds N]
//        (or run the binary directly from a terminal that already has mic access)

setvbuf(stdout, nil, _IONBF, 0)
var seconds: Double = 0
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--seconds"), i + 1 < args.count { seconds = Double(args[i + 1]) ?? 0 }

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var granted = false
AVCaptureDevice.requestAccess(for: .audio) { ok in granted = ok; semaphore.signal() }
semaphore.wait()
if !granted { fail("microphone-denied: allow Mockingbird Mic in System Settings > Privacy & Security > Microphone") }

let engine = AVAudioEngine()
let input = engine.inputNode
let inFormat = input.outputFormat(forBus: 0)
guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inFormat, to: outFormat) else { fail("converter-unavailable") }
let out = FileHandle.standardOutput
input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / inFormat.sampleRate) + 32
    guard let converted = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
        if supplied { status.pointee = .noDataNow; return nil }
        supplied = true; status.pointee = .haveData; return buffer
    }
    guard error == nil, converted.frameLength > 0, let data = converted.int16ChannelData else { return }
    out.write(Data(bytes: data[0], count: Int(converted.frameLength) * 2))
}
do { try engine.start() } catch { fail("engine-start-failed: \(error)") }
FileHandle.standardError.write("mockingbird-mic: streaming \(inFormat.sampleRate) Hz -> 16000 Hz s16le\n".data(using: .utf8)!)
signal(SIGPIPE, SIG_IGN)
if seconds > 0 {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
}
RunLoop.main.run()
