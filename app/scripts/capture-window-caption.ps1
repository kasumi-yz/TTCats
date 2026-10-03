param(
    [Parameter(Mandatory=$true)][long]$WindowHandle,
    [Parameter(Mandatory=$true)][int]$Left,
    [Parameter(Mandatory=$true)][int]$Top,
    [Parameter(Mandatory=$true)][int]$Right,
    [Parameter(Mandatory=$true)][int]$Bottom,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [switch]$FromScreen)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaptionCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
}
'@
$previous = [CaptionCapture]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
if ($previous -eq [IntPtr]::Zero) { throw '无法设置按钮截图的物理坐标。' }
$bitmap = $null
$graphics = $null
$caption = $null
try {
    $window = [IntPtr]::new($WindowHandle)
    $rect = [CaptionCapture+Rect]::new()
    if (![CaptionCapture]::GetWindowRect($window, [ref]$rect)) { throw '无法读取截图目标外框。' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0 -or $width -gt 10000 -or $height -gt 10000) { throw '截图目标尺寸无效。' }
    # 不经过 Electron 缩略图缩放；整个目标仅存在内存，磁盘只写按钮区域。
    $bitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    if ($FromScreen) {
        foreach ($taskPoint in @(@(($Left+1),($Top+1)),@(($Right-2),($Top+1)),@(($Left+1),($Bottom-2)),@(($Right-2),($Bottom-2)),@([int](($Left+$Right)/2),[int](($Top+$Bottom)/2)))) {
            $point=[CaptionCapture+Point]::new()
            $point.X=$taskPoint[0];$point.Y=$taskPoint[1]
            if ([CaptionCapture]::GetAncestor([CaptionCapture]::WindowFromPoint($point),2) -ne $window) { throw '按钮区域被其他窗口遮挡，不能捕获物理屏幕证据。' }
        }
        $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,[Drawing.Size]::new($width,$height),[Drawing.CopyPixelOperation]::SourceCopy)
    } else {
        $dc = $graphics.GetHdc()
        try {
            if (![CaptionCapture]::PrintWindow($window, $dc, 2)) { throw '目标窗口没有提供实际截图。' }
        } finally { $graphics.ReleaseHdc($dc) }
    }
    $cropLeft = [Math]::Max($rect.Left, $Left)
    $cropTop = [Math]::Max($rect.Top, $Top)
    $cropRight = [Math]::Min($rect.Right, $Right)
    $cropBottom = [Math]::Min($rect.Bottom, $Bottom)
    if ($cropRight -le $cropLeft -or $cropBottom -le $cropTop) { throw '实际按钮截图范围无效。' }
    $crop = [Drawing.Rectangle]::new($cropLeft - $rect.Left, $cropTop - $rect.Top, $cropRight - $cropLeft, $cropBottom - $cropTop)
    $caption = $bitmap.Clone($crop, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $caption.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
    ConvertTo-Json -Compress -InputObject @{
        outer = @{ left=$rect.Left; top=$rect.Top; right=$rect.Right; bottom=$rect.Bottom }
        crop = @{ left=$cropLeft; top=$cropTop; right=$cropRight; bottom=$cropBottom }
        width=$caption.Width; height=$caption.Height
        method=$(if($FromScreen){'物理屏幕'}else{'PrintWindow'})
    }
} finally {
    if ($caption) { $caption.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ([CaptionCapture]::SetThreadDpiAwarenessContext($previous) -eq [IntPtr]::Zero) { throw '按钮截图后无法恢复 DPI 上下文。' }
}
