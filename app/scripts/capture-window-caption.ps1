param(
    [Parameter(Mandatory=$true)][long]$WindowHandle,
    [Parameter(Mandatory=$true)][int]$Left,
    [Parameter(Mandatory=$true)][int]$Top,
    [Parameter(Mandatory=$true)][int]$Right,
    [Parameter(Mandatory=$true)][int]$Bottom,
    [Parameter(Mandatory=$true)][int]$MonitorDpi,
    [string]$OutputPath,
    [switch]$PlanOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CaptionCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window,StringBuilder name,int count);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
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
    $awareness = [CaptionCapture]::GetAwarenessFromDpiAwarenessContext([CaptionCapture]::GetWindowDpiAwarenessContext($window))
    $windowDpi = [CaptionCapture]::GetDpiForWindow($window)
    if ($awareness -lt 0 -or $windowDpi -eq 0) { throw '无法确定目标窗口的 DPI，不能猜截图方式。' }
    # 老程序按 96 DPI 绘图，PrintWindow 不会替物理尺寸位图放大内容，非纯色也可能错位。
    $fromScreen = $awareness -ne 2 -or $windowDpi -ne $MonitorDpi
    $owners = @(
        foreach ($taskPoint in @(@(($Left+1),($Top+1)),@(($Right-2),($Top+1)),@(($Left+1),($Bottom-2)),@(($Right-2),($Bottom-2)),@([int](($Left+$Right)/2),[int](($Top+$Bottom)/2)))) {
            $point=[CaptionCapture+Point]::new()
            $point.X=$taskPoint[0];$point.Y=$taskPoint[1]
            $hit=[CaptionCapture]::WindowFromPoint($point)
            $root=[CaptionCapture]::GetAncestor($hit,2)
            $name=[Text.StringBuilder]::new(256)
            [void][CaptionCapture]::GetClassNameW($root,$name,256)
            @{x=$point.X;y=$point.Y;rootHandle=$root.ToInt64();rootClass=$name.ToString();isTarget=($root -eq $window)}
        }
    )
    if ($PlanOnly) {
        ConvertTo-Json -Compress -InputObject @{
            outer=@{left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom}
            windowDpi=$windowDpi;awareness=$awareness
            method=$(if($fromScreen){'screen'}else{'PrintWindow'})
            regionVisible=(@($owners | Where-Object { !$_.isTarget }).Count -eq 0);owners=$owners
        }
        return
    }
    if (!$OutputPath) { throw '实际截图必须提供输出路径。' }
    # 不经过 Electron 缩略图缩放；整个目标仅存在内存，磁盘只写按钮区域。
    $bitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    if ($fromScreen) {
        if ($owners | Where-Object { !$_.isTarget }) {
            throw "按钮区域所属窗口检查失败，不能捕获物理屏幕证据：$($owners | ConvertTo-Json -Compress)"
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
        method=$(if($fromScreen){'screen'}else{'PrintWindow'})
        regionVisible=(@($owners | Where-Object { !$_.isTarget }).Count -eq 0);owners=$owners
    }
} finally {
    if ($caption) { $caption.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ([CaptionCapture]::SetThreadDpiAwarenessContext($previous) -eq [IntPtr]::Zero) { throw '按钮截图后无法恢复 DPI 上下文。' }
}
