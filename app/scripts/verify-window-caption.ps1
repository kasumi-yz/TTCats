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
if([CaptionReferenceDpi]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero){throw '无法设置辅助功能核对的物理坐标。'}
$root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($WindowHandle))
if ($null -eq $root) { throw 'UI Automation 找不到窗口。' }
$condition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty,
    [Windows.Automation.ControlType]::Button)
$all = @($root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition))
$result = @()
$failures = @()
$windowBounds=$root.Current.BoundingRectangle
if (!$root.Current.IsOffscreen -and !$windowBounds.IsEmpty) {
    for($x=[int]$windowBounds.Right-15;$x -gt [Math]::Max($windowBounds.Left,[int]$windowBounds.Right-360);$x-=15){
        for($y=[int]$windowBounds.Top+5;$y -lt $windowBounds.Top+100;$y+=15){
            $element=[Windows.Automation.AutomationElement]::FromPoint([Windows.Point]::new($x,$y))
            if($null -ne $element){$all += $element}
        }
    }
}
foreach ($element in $all) {
    $current = $element.Current
    if ($current.IsOffscreen -or $current.ProcessId -ne $root.Current.ProcessId -or
        $current.ControlType -ne [Windows.Automation.ControlType]::Button) { continue }
    $parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
    if($null -ne $parent -and $parent.Current.ControlType -eq [Windows.Automation.ControlType]::TabItem){continue}
    $kind = ''
    if ($current.Name -match '^(最小化|Minimize)$' -or $current.AutomationId -match '^(Minimize|MinimizeButton)$') { $kind = 'minimize' }
    elseif ($current.Name -match '^(最大化|还原|Maximize|Restore)$' -or $current.AutomationId -match '^(Maximize|MaximizeButton|Restore)$') { $kind = 'maximize' }
    elseif ($current.Name -match '^(关闭|Close)$' -or $current.AutomationId -match '^(Close|CloseButton)$') { $kind = 'close' }
    elseif ($current.Name -match '^(帮助|Help)$' -or $current.AutomationId -match '^(Help|HelpButton)$') { $kind = 'help' }
    if (!$kind) { continue }
    $r = $current.BoundingRectangle
    if ($r.Top -gt $windowBounds.Top + 120 -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    if(@($result | Where-Object {$_.left -eq $r.Left -and $_.top -eq $r.Top -and $_.kind -eq $kind}).Count){continue}
    $result += @{kind=$kind;left=$r.Left;top=$r.Top;right=$r.Right;bottom=$r.Bottom;frameworkId=$current.FrameworkId}
}
$canMinimize=$null
$canMaximize=$null
try {
    $pattern = [Windows.Automation.WindowPattern]$root.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
    $canMinimize=$pattern.Current.CanMinimize
    $canMaximize=$pattern.Current.CanMaximize
} catch { $failures += $_.Exception.Message }
foreach ($kind in @('minimize', 'maximize', 'close')) {
    $required = $kind -eq 'close' -or ($kind -eq 'minimize' -and $canMinimize) -or ($kind -eq 'maximize' -and $canMaximize)
    $count = @($result | Where-Object { $_.kind -eq $kind }).Count
    if ($count -gt 1 -or ($required -and $count -ne 1)) {
        $failures += "UI Automation 没有找到唯一的 $kind 标题栏按钮（数量 $count）。"
    }
}
# 失败也输出完整参考/能力/来源信息，由核对脚本保存并继续其他项目。
ConvertTo-Json -Depth 5 -Compress -InputObject @{
    valid=($failures.Count -eq 0);errors=@($failures);buttons=@($result)
    canMinimize=$canMinimize;canMaximize=$canMaximize
    root=@{offscreen=$root.Current.IsOffscreen;frameworkId=$root.Current.FrameworkId}
}
