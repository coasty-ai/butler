import Foundation
import CoreGraphics

// Compare rendered pixels, not PNG bytes. The model's frame hash remains an
// integrity identifier; it is not a test of whether a GUI target is unchanged.
struct ScreenPixels {
    let width: Int
    let height: Int
    let rgba: [UInt8]

    init(width: Int, height: Int, rgba: [UInt8]) {
        self.width = width; self.height = height; self.rgba = rgba
    }
    init?(_ image: CGImage) {
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = bytes.withUnsafeMutableBytes { data -> Bool in
            guard let context = CGContext(data: data.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else { return nil }
        self.width = width; self.height = height; rgba = bytes
    }

    func changed(comparedTo other: ScreenPixels, in rect: CGRect, target: Bool, ignoring stableControls: [CGRect] = []) -> Bool {
        guard !rect.isNull, !rect.isInfinite, rect.width > 0, rect.height > 0 else { return true }
        guard width == other.width, height == other.height,
              rgba.count == width * height * 4, other.rgba.count == rgba.count else { return true }
        let left = max(0, Int(floor(rect.minX))), top = max(0, Int(floor(rect.minY)))
        let right = min(width, Int(ceil(rect.maxX))), bottom = min(height, Int(ceil(rect.maxY)))
        guard right > left, bottom > top else { return true }
        var count = 0, minX = right, maxX = left, minY = bottom, maxY = top
        for y in top..<bottom {
            let ignored = stableControls.filter { Double(y) >= $0.minY && Double(y) < $0.maxY }
            for x in left..<right {
                if ignored.contains(where: { Double(x) >= $0.minX && Double(x) < $0.maxX }) { continue }
                let i = (y * width + x) * 4
                let delta = max(abs(Int(rgba[i]) - Int(other.rgba[i])),
                    max(abs(Int(rgba[i+1]) - Int(other.rgba[i+1])), abs(Int(rgba[i+2]) - Int(other.rgba[i+2]))))
                if delta > 24 {
                    count += 1; minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                }
            }
        }
        // A narrow caret may blink without changing the editable element/value.
        if count > 0 && maxX - minX < 3 && maxY - minY < 40 { return false }
        let area = (right - left) * (bottom - top)
        return count > (target ? 8 : max(24, Int(Double(area) * 0.001)))
    }
}

func framePixelsChanged(_ old: ScreenPixels, _ fresh: ScreenPixels, window: CGRect, points: [CGPoint], stableControls: [CGRect] = []) -> Bool {
    if old.changed(comparedTo: fresh, in: window, target: false, ignoring: stableControls) { return true }
    return targetPixelsChanged(old, fresh, points: points, stableControls: stableControls)
}

// A small change at the actual click/drag destination is significant even
// when it occupies very little of the whole window. Used alone when every
// input point lies inside a verified, stable, hit-tested control, so unrelated
// animation elsewhere in the window does not reject the step.
func targetPixelsChanged(_ old: ScreenPixels, _ fresh: ScreenPixels, points: [CGPoint], stableControls: [CGRect] = []) -> Bool {
    points.contains { point in
        old.changed(comparedTo: fresh, in: CGRect(x: point.x - 48, y: point.y - 32, width: 96, height: 64), target: true, ignoring: stableControls)
    }
}
