import AppKit
import ImageIO

// Synthetic test image only. No real files or user photos are read.
let image = NSImage(size: NSSize(width: 1200, height: 500))
image.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 1200, height: 500).fill()
if CommandLine.arguments.dropFirst().first != "blank" {
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 56), .foregroundColor: NSColor.black]
    "短视频选题与咨询转化方法".draw(at: NSPoint(x: 50, y: 300), withAttributes: attributes)
    "Audience research and useful content".draw(at: NSPoint(x: 50, y: 180), withAttributes: attributes)
}
image.unlockFocus()
guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let type = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "public.png"
let data = NSMutableData()
guard let destination = CGImageDestinationCreateWithData(data, type as CFString, 1, nil) else { exit(2) }
CGImageDestinationAddImage(destination, cg, nil)
guard CGImageDestinationFinalize(destination) else { exit(3) }
FileHandle.standardOutput.write(data as Data)
