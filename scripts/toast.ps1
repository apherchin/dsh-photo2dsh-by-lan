# Photo Inbox toast for dsh-photo2dsh-by-lan.
#
# THIS FILE MUST STAY PURE ASCII. Do not add non-ASCII characters to it.
# Rationale (measured in this repo, do not "improve" it away):
#   1. A toast must be raised by **Windows PowerShell 5.1** -- pwsh 7 has no WinRT
#      type projection.
#   2. A .ps1 containing non-ASCII must carry a UTF-8 BOM, otherwise 5.1 decodes it
#      as ANSI and can fail to parse it outright. Editors and patch tools drop BOMs
#      easily, so this script avoids the problem entirely by staying ASCII.
#   3. The (possibly Chinese) title and message travel in a UTF-8 JSON file instead
#      of command-line arguments, because argument encoding under 5.1 is unreliable
#      while a JSON file is deterministic.
#
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File toast.ps1 <payload.json>
# payload.json: { "title": "...", "message": "...", "appId": "..." }

param([Parameter(Mandatory = $true)][string]$PayloadPath)

$ErrorActionPreference = 'Stop'

try {
    $json = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $title = [string]$json.title
    $message = [string]$json.message
    $appId = [string]$json.appId
    if ([string]::IsNullOrWhiteSpace($appId)) {
        # PowerShell's own AUMID: works without registering anything, at the cost of
        # showing "Windows PowerShell" as the app name on the banner. To show your own
        # name, register an AUMID under HKCU\Software\Classes\AppUserModelId
        # (dsh-attention's register-app-id.ps1 in this repo is a working example).
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    }

    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
        [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($template.CreateTextNode($title)) | Out-Null
    $texts.Item(1).AppendChild($template.CreateTextNode($message)) | Out-Null

    $toast = New-Object Windows.UI.Notifications.ToastNotification $template
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)

    Write-Output 'shown'
    exit 0
}
catch {
    Write-Error ("toast failed: " + $_.Exception.Message)
    exit 1
}
