param([Parameter(Mandatory=$true)][long]$WindowHandle)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaptionReferenceDpi {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
# 独立进程退出时销毁线程上下文；所有查询统一使用物理屏幕坐标。
if([CaptionReferenceDpi]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero){throw '无法设置辅助功能核对的物理坐标。'}
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($WindowHandle))
if ($null -eq $root) { throw 'UI Automation 找不到窗口。' }
$condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$result = @()
$windowBounds=$root.Current.BoundingRectangle
$all=@($elements)
for($x=[int]$windowBounds.Right-15;$x -gt [Math]::Max($windowBounds.Left,[int]$windowBounds.Right-360);$x-=15){
    for($y=[int]$windowBounds.Top+5;$y -lt $windowBounds.Top+100;$y+=15){
        $all += [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x,$y))
    }
}
foreach ($element in $all) {
    $current = $element.Current
    if ($current.IsOffscreen) { continue }
    if ($current.ProcessId -ne $root.Current.ProcessId) { continue }
    if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
    $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
    if($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem){continue}
    $kind = ''
    if ($current.Name -match '^(最小化|Minimize)$' -or $current.AutomationId -match '^(Minimize|MinimizeButton)$') { $kind = 'minimize' }
    elseif ($current.Name -match '^(最大化|还原|Maximize|Restore)$' -or $current.AutomationId -match '^(Maximize|MaximizeButton|Restore)$') { $kind = 'maximize' }
    elseif ($current.Name -match '^(关闭|Close)$' -or $current.AutomationId -match '^(Close|CloseButton)$') { $kind = 'close' }
    elseif ($current.Name -match '^(帮助|Help)$' -or $current.AutomationId -match '^(Help|HelpButton)$') { $kind = 'help' }
    if (!$kind) { continue }
    $rectangle = $current.BoundingRectangle
    $windowBounds = $root.Current.BoundingRectangle
    # 只取窗口最上方的标题栏按钮，不把文档/标签页里的“关闭”混进去；不使用被测算法的边界。
    if ($rectangle.Top -gt $windowBounds.Top + 120 -or $rectangle.Width -le 0 -or $rectangle.Height -le 0) { continue }
    if(@($result | Where-Object {$_.left -eq $rectangle.Left -and $_.top -eq $rectangle.Top -and $_.kind -eq $kind}).Count){continue}
    $result += @{ kind = $kind; left = $rectangle.Left; top = $rectangle.Top; right = $rectangle.Right; bottom = $rectangle.Bottom }
}
$windowPattern = [System.Windows.Automation.WindowPattern]$root.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
foreach ($kind in @('minimize', 'maximize', 'close')) {
    $required = $kind -eq 'close' -or ($kind -eq 'minimize' -and $windowPattern.Current.CanMinimize) -or ($kind -eq 'maximize' -and $windowPattern.Current.CanMaximize)
    $count = @($result | Where-Object { $_.kind -eq $kind }).Count
    if ($count -gt 1 -or ($required -and $count -ne 1)) {
        throw "UI Automation 没有找到唯一的 $kind 标题栏按钮。"
    }
}
ConvertTo-Json -InputObject @($result) -Compress
