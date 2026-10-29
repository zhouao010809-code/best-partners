import Foundation
import ImageIO
import Vision

// Pixel processing stays on this Mac. No filenames, metadata, URLs or network APIs enter the protocol.
// https://developer.apple.com/documentation/vision/recognizing-text-in-images
// https://developer.apple.com/documentation/vision/vnclassifyimagerequest
struct Label: Encodable { let label: String; let confidence: Float }
struct Evidence: Encodable {
    let status: String
    var text = ""
    var labels: [Label] = []
    var sampled = false
}
func output(_ value: Evidence) {
    guard let data = try? JSONEncoder().encode(value) else { exit(1) }
    FileHandle.standardOutput.write(data)
}

func recognize() -> Evidence {
    let limit = 20 * 1024 * 1024
    var data = Data()
    do {
        while let chunk = try FileHandle.standardInput.read(upToCount: min(65536, limit + 1 - data.count)), !chunk.isEmpty {
            data.append(chunk)
            if data.count > limit { return Evidence(status: "too-large") }
        }
    } catch { return Evidence(status: "unreadable") }
    guard !data.isEmpty,
          let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let type = CGImageSourceGetType(source) as String?,
          ["public.jpeg", "public.png", "org.webmproject.webp", "public.heic", "public.heif", "public.tiff", "com.microsoft.bmp"].contains(type),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0 else { return Evidence(status: "unreadable") }
    guard width <= 30000, height <= 30000, Int64(width) * Int64(height) <= 100_000_000 else { return Evidence(status: "too-large") }
    // Decode an oriented thumbnail rather than allocating an unrestricted decompressed bitmap.
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 3000,
        kCGImageSourceShouldCacheImmediately: true]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return Evidence(status: "unreadable") }
    var evidence = Evidence(status: "ready", sampled: max(width, height) > 3000 || CGImageSourceGetCount(source) > 1)
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    textRequest.usesLanguageCorrection = true
    textRequest.automaticallyDetectsLanguage = true
    if let supported = try? textRequest.supportedRecognitionLanguages() {
        textRequest.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"].filter { supported.contains($0) }
    }
    var succeeded = false
    do {
        try handler.perform([textRequest])
        succeeded = true
        var lines: [String] = []
        var count = 0
        for observation in textRequest.results ?? [] {
            guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.7 else { continue }
            let line = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if count + line.count > 24000 || lines.count >= 500 { evidence.sampled = true; break }
            lines.append(line); count += line.count + 1
        }
        evidence.text = lines.joined(separator: "\n")
    } catch { evidence.sampled = true }
    let classification = VNClassifyImageRequest()
    do {
        try handler.perform([classification])
        succeeded = true
        // High confidence only. Naming must never turn labels into claims about identity or traits.
        evidence.labels = (classification.results ?? []).filter { $0.confidence >= 0.8 }
            .sorted { $0.confidence > $1.confidence }.prefix(8)
            .map { Label(label: String($0.identifier.prefix(120)), confidence: $0.confidence) }
    } catch { evidence.sampled = true }
    return succeeded ? evidence : Evidence(status: "failed")
}

autoreleasepool { output(recognize()) }
