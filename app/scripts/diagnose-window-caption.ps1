param([long]$WindowHandle)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaptionDiagnosticDpi {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
if([CaptionDiagnosticDpi]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero){throw '无法设置按钮诊断的物理坐标。'}
$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($WindowHandle))
$windowBounds=$root.Current.BoundingRectangle
$elements=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
$result=@()
$all=@($elements)
# 现代标题栏可能不在窗口的 ControlView 子树里，从实际屏幕位置另查。
for($x=[int]$windowBounds.Right-15;$x -gt [Math]::Max($windowBounds.Left,[int]$windowBounds.Right-360);$x-=15){
 for($y=[int]$windowBounds.Top+5;$y -lt $windowBounds.Top+100;$y+=15){
  $all += [Windows.Automation.AutomationElement]::FromPoint([Windows.Point]::new($x,$y))
 }
}
foreach($element in $all) {
 $c=$element.Current; $r=$c.BoundingRectangle
 if($r.Top -gt $windowBounds.Top+180) {continue}
 $kind=if($c.Name -match '(最小化|Minimize)'){'minimize'}elseif($c.Name -match '(最大化|还原|Maximize|Restore)'){'maximize'}elseif($c.Name -match '(关闭|Close)'){'close'}elseif($c.Name -match '(帮助|Help)'){'help'}else{''}
 if(!$kind -or $c.ControlType -ne [Windows.Automation.ControlType]::Button -or $c.ProcessId -ne $root.Current.ProcessId){continue}
 $p=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
 if(@($result | Where-Object {$_.left -eq $r.Left -and $_.top -eq $r.Top -and $_.kind -eq $kind}).Count){continue}
 $result+=@{kind=$kind;exactName=$c.Name -match '^(最小化|Minimize|最大化|还原|Maximize|Restore|关闭|Close|帮助|Help)$';id=$c.AutomationId;offscreen=$c.IsOffscreen;parentType=$p.Current.ControlType.ProgrammaticName;left=$r.Left;top=$r.Top;right=$r.Right;bottom=$r.Bottom}
}
ConvertTo-Json -Depth 5 -InputObject @{rootType=$root.Current.ControlType.ProgrammaticName;rootBounds=@{left=$windowBounds.Left;top=$windowBounds.Top;right=$windowBounds.Right;bottom=$windowBounds.Bottom};buttons=$result}
