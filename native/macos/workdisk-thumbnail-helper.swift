import Foundation
import AVFoundation
import ImageIO
import Darwin

// fd 3 is a checked, already-open regular file. No source path, metadata, or network input.
func thumbnail() -> CGImage? {
    var info = stat()
    guard CommandLine.arguments.count == 2, fstat(3, &info) == 0,
          info.st_mode & S_IFMT == S_IFREG, info.st_size > 0 else { return nil }
    let url = URL(fileURLWithPath: "/dev/fd/3")
    if CommandLine.arguments[1] == "image" {
        guard info.st_size <= 40 * 1024 * 1024,
              let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 30000, height <= 30000,
              Int64(width) * Int64(height) <= 100_000_000 else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 480,
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary)
    }
    guard CommandLine.arguments[1] == "video", info.st_size <= 4 * 1024 * 1024 * 1024 else { return nil }
    var options: [String: Any] = [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue]
    if #available(macOS 14.0, *) { options[AVURLAssetOverrideMIMETypeKey] = "video/mp4" }
    let asset = AVURLAsset(url: url, options: options)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 480, height: 320)
    return try? generator.copyCGImage(at: CMTime(value: 0, timescale: 1), actualTime: nil)
}

autoreleasepool {
    guard let image = thumbnail() else { exit(1) }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { exit(1) }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
    guard CGImageDestinationFinalize(destination), data.length <= 256 * 1024 else { exit(1) }
    FileHandle.standardOutput.write(data as Data)
}
