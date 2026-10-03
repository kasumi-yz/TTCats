param([Parameter(Mandatory=$true)][long]$WindowHandle)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($WindowHandle))
if ($null -eq $root) { throw 'UI Automation 找不到窗口。' }
$condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$result = @()
foreach ($element in $elements) {
    $current = $element.Current
    if ($current.IsOffscreen) { continue }
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
