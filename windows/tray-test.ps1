param([string]$Exe)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$bin = Join-Path $root 'runtime/bin'
if (!$Exe) { $Exe = Join-Path $bin 'SocratiCodeV.exe' }
$cache = Join-Path $root '.cache/scv-windows'
$scratch = Join-Path $cache ('tray-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$env:TEMP = $env:TMP = $scratch

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ScvTrayTest {
    private delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr window, uint msg, UIntPtr parameter, IntPtr detail, uint flags, uint timeout, out IntPtr result);

    public static IntPtr Find(uint processId) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, data) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != processId) return true;
            var name = new StringBuilder(60);
            GetClassName(window, name, name.Capacity);
            if (name.ToString() != "SocratiCodeV.Tray") return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static IntPtr Send(IntPtr window, uint message, uint parameter) {
        IntPtr result;
        if (SendMessageTimeout(window, message, new UIntPtr(parameter), IntPtr.Zero, 2, 4000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Tray window did not answer");
        return result;
    }
}
'@

$profile = Get-Content -LiteralPath (Join-Path $bin 'profile.json') -Raw | ConvertFrom-Json
$profile.data = Join-Path $scratch 'data'
$profile.tray = $true
$profile.mcpPort = 30365
$profile.qdrantPort = 30333
$profile.qdrantGrpcPort = 30334
$profile.ollamaPort = 25435
$profileFile = Join-Path $scratch 'profile.json'
[IO.File]::WriteAllText($profileFile, ($profile | ConvertTo-Json))
$styleFile = Join-Path $profile.data 'tray-style.txt'
$log = Join-Path $profile.data 'logs/scv.log'
$arguments = @('--profile', ('"' + $profileFile + '"'))

function Open-Tray {
    Start-Process -FilePath $Exe -ArgumentList (@('--serve') + $arguments) -WindowStyle Hidden -PassThru
}

function Find-Tray($owner) {
    for ($i = 0; $i -lt 150; $i++) {
        if ($owner.HasExited) { throw 'SCV stopped before creating its tray icon' }
        $window = [ScvTrayTest]::Find([uint32]$owner.Id)
        if ($window -ne [IntPtr]::Zero -and (Test-Path -LiteralPath $log) -and
                (Get-Content -LiteralPath $log -Raw).Contains('SCV: notification icon registered')) { return $window }
        Start-Sleep -Milliseconds 100
    }
    throw 'Tray window was not registered'
}

function Close-Tray($owner) {
    if (!$owner.HasExited) {
        Start-Process -FilePath $Exe -ArgumentList (@('--stop') + $arguments) -WindowStyle Hidden -Wait
        if (!$owner.WaitForExit(15000)) { throw 'SCV did not stop' }
    }
}

$owner = Open-Tray
try {
    $window = Find-Tray $owner
    $color = [ScvTrayTest]::Send($window, 0x7f, 0)
    [void][ScvTrayTest]::Send($window, 0x111, 4)
    if (!(Test-Path -LiteralPath $styleFile) -or (Get-Content -LiteralPath $styleFile -Raw).Trim() -ne 'monochrome') {
        throw 'Selecting monochrome in the tray must save the choice'
    }
    $mono = [ScvTrayTest]::Send($window, 0x7f, 0)
    if ($color -eq [IntPtr]::Zero -or $mono -eq [IntPtr]::Zero -or $mono -eq $color) {
        throw 'The Windows icon must change immediately'
    }
    Close-Tray $owner
    $owner = Open-Tray
    $window = Find-Tray $owner
    $reopened = [ScvTrayTest]::Send($window, 0x7f, 0)
    [void][ScvTrayTest]::Send($window, 0x111, 4)
    if ($reopened -ne [ScvTrayTest]::Send($window, 0x7f, 0)) { throw 'Restart forgot the selected style' }
    [void][ScvTrayTest]::Send($window, 0x111, 3)
    if ((Get-Content -LiteralPath $styleFile -Raw).Trim() -ne 'color' -or $reopened -eq [ScvTrayTest]::Send($window, 0x7f, 0)) {
        throw 'The color icon must restore immediately'
    }
    Write-Output 'Both tray styles apply immediately and survive restart'
} finally {
    Close-Tray $owner
}
