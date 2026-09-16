import AppKit
import Foundation

let directory = "build/open-assist.iconset"
try FileManager.default.createDirectory(atPath:directory,withIntermediateDirectories:true)
for base in [16,32,128,256,512] {
    for scale in [1,2] {
        let size=base*scale
        let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
        let context=NSGraphicsContext(bitmapImageRep:bitmap)!
        NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=context
        let c=context.cgContext;c.scaleBy(x:CGFloat(size)/1024,y:CGFloat(size)/1024)
        c.setFillColor(NSColor(white:0.065,alpha:1).cgColor)
        c.addPath(CGPath(roundedRect:CGRect(x:72,y:72,width:880,height:880),cornerWidth:195,cornerHeight:195,transform:nil));c.fillPath()
        c.setStrokeColor(NSColor(white:0.28,alpha:1).cgColor);c.setLineWidth(4)
        c.addPath(CGPath(roundedRect:CGRect(x:76,y:76,width:872,height:872),cornerWidth:191,cornerHeight:191,transform:nil));c.strokePath()
        c.setStrokeColor(NSColor(white:0.25,alpha:1).cgColor);c.setLineWidth(6)
        c.strokeEllipse(in:CGRect(x:244,y:244,width:536,height:536))
        c.setLineCap(.round)
        func arc(_ radius:CGFloat,_ start:CGFloat,_ end:CGFloat,_ shade:CGFloat,_ width:CGFloat) {
            c.setStrokeColor(NSColor(white:shade,alpha:1).cgColor);c.setLineWidth(width)
            c.addArc(center:CGPoint(x:512,y:512),radius:radius,startAngle:start * .pi/180,endAngle:end * .pi/180,clockwise:false);c.strokePath()
        }
        arc(268,8,108,0.93,15);arc(268,130,172,0.93,15);arc(268,195,278,0.93,15);arc(268,305,332,0.93,15)
        for start:CGFloat in [5,95,185,275] {arc(164,start,start+58,0.57,9)}
        c.setFillColor(NSColor(white:0.94,alpha:1).cgColor);c.fillEllipse(in:CGRect(x:478,y:478,width:68,height:68))
        NSGraphicsContext.restoreGraphicsState()
        let suffix=scale==2 ? "@2x" : ""
        try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:"\(directory)/icon_\(base)x\(base)\(suffix).png"))
    }
}
