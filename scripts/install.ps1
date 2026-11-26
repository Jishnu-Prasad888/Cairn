<#
.SYNOPSIS
    Cairn installer for Windows.

.DESCRIPTION
    Downloads the latest Cairn release for this CPU (amd64 or arm64), verifies
    its checksum, installs it, and optionally sets it to start automatically.

        irm https://raw.githubusercontent.com/Jishnu-Prasad888/Cairn/main/scripts/install.ps1 | iex

    Options are read from environment variables, so they work with `| iex`:

        $env:CAIRN_YES = '1'            # accept every default answer
        $env:CAIRN_VERSION = 'v1.3.1'   # install this release instead of the latest
        $env:CAIRN_INSTALL_DIR = 'D:\Apps\Cairn'
        $env:CAIRN_PORT = '8715'
        $env:CAIRN_UNINSTALL = '1'      # remove Cairn and its startup task (keeps data)

    Or download the script and pass parameters:

        .\install.ps1 -Yes -Version v1.3.1 -Port 9000

    Your photo libraries and the Cairn data directory are never touched.
#>
param(
    [switch] $Yes = ($env:CAIRN_YES -eq '1'),
    [string] $Version = $(if ($env:CAIRN_VERSION) { $env:CAIRN_VERSION } else { 'latest' }),
    [string] $InstallDir = $(if ($env:CAIRN_INSTALL_DIR) { $env:CAIRN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Cairn' }),
    [int]    $Port = $(if ($env:CAIRN_PORT) { [int]$env:CAIRN_PORT } else { 8715 }),
    [switch] $NoService,
    [switch] $Uninstall = ($env:CAIRN_UNINSTALL -eq '1')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on PS 5.1

$Repo     = 'Jishnu-Prasad888/Cairn'
$TaskName = 'Cairn'
$ExePath  = Join-Path $InstallDir 'cairn.exe'
$DataDir  = Join-Path $env:USERPROFILE '.local\share\cairn'
$LogDir   = Join-Path $env:LOCALAPPDATA 'Cairn\logs'

# --- output & prompts --------------------------------------------------------

function Write-Info($m) { Write-Host '==> ' -ForegroundColor Blue -NoNewline; Write-Host $m }
function Write-Ok($m)   { Write-Host ' OK ' -ForegroundColor Green -NoNewline; Write-Host $m }
function Write-Warn2($m){ Write-Host ' !  ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Stop-Install($m) { Write-Host "error: $m" -ForegroundColor Red; throw $m }

$Interactive = -not $Yes -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

function Ask([string] $Question, [bool] $Default) {
    $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
    if (-not $Interactive) {
        Write-Host "? $Question $hint $(if ($Default) { 'y' } else { 'n' }) (default)"
        return $Default
    }
    while ($true) {
        $reply = Read-Host "? $Question $hint"
        if ([string]::IsNullOrWhiteSpace($reply)) { return $Default }
        switch -Regex ($reply.Trim()) {
            '^(y|yes)$' { return $true }
            '^(n|no)$'  { return $false }
            default     { Write-Host '   Please answer y or n.' }
        }
    }
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- platform detection ------------------------------------------------------

function Get-CairnArch {
    $arch = $null
    try {
        # Reports the real OS architecture even from an emulated x64 PowerShell on ARM.
        $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    } catch { }
    if (-not $arch) {
        $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch -Regex ($arch) {
        '^(X64|AMD64)$' { return 'amd64' }
        '^(Arm64|ARM64)$' { return 'arm64' }
        default { Stop-Install "unsupported CPU '$arch'. Cairn needs a 64-bit CPU (amd64 or arm64)." }
    }
}

if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
    Stop-Install "this installer is for Windows. On Linux or macOS run:`n  curl -fsSL https://raw.githubusercontent.com/$Repo/main/scripts/install.sh | bash"
}

# TLS 1.2 is not on by default in Windows PowerShell 5.1.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# --- uninstall ---------------------------------------------------------------

function Remove-StartupTask {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Ok 'Removed the startup task'
    }
}

function Stop-Cairn {
    Get-Process -Name cairn -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $ExePath } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

if ($Uninstall) {
    Write-Info 'Uninstalling Cairn'
    try { Remove-StartupTask } catch { Write-Warn2 "Could not remove the startup task (try an elevated PowerShell): $_" }
    Stop-Cairn
    if (Test-Path $ExePath) { Remove-Item $ExePath -Force; Write-Ok "Removed $ExePath" }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath) {
        $parts = $userPath.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $InstallDir.TrimEnd('\')) }
        [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    }
    Get-NetFirewallRule -DisplayName 'Cairn' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Info "Your data in $DataDir and your libraries were left untouched."
    return
}

# --- download & install ------------------------------------------------------

Write-Host ''
Write-Host 'Cairn installer' -ForegroundColor White
Write-Host ''

$Arch = Get-CairnArch
Write-Info "Detected windows/$Arch"

if ($Version -eq 'latest') {
    try {
        $rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'cairn-installer' }
        $Version = $rel.tag_name
    } catch {
        # API rate-limited: fall back to the /releases/latest redirect.
        $req = [Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
        $req.AllowAutoRedirect = $false
        $req.UserAgent = 'cairn-installer'
        $resp = $req.GetResponse()
        $loc = $resp.Headers['Location']; $resp.Close()
        if ($loc -match '/releases/tag/([^/]+)$') { $Version = $Matches[1] }
        else { Stop-Install "could not determine the latest release of $Repo" }
    }
}
if ($Version -notmatch '^v') { $Version = "v$Version" }
Write-Info "Release $Version"

$Asset   = "cairn-windows-$Arch.exe"
$BaseUrl = "https://github.com/$Repo/releases/download/$Version"
$TmpDir  = Join-Path ([IO.Path]::GetTempPath()) ("cairn-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    $TmpExe = Join-Path $TmpDir $Asset
    Write-Info "Downloading $Asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $TmpExe

    $sumsFile = Join-Path $TmpDir 'SHA256SUMS'
    $haveSums = $true
    try { Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS" -OutFile $sumsFile } catch { $haveSums = $false }
    if ($haveSums) {
        # Entries may carry a path prefix (dist/cairn-...), so match on the file name.
        $expected = Get-Content $sumsFile | ForEach-Object {
            $f = $_ -split '\s+', 2
            if ($f.Count -eq 2 -and (($f[1].TrimStart('*') -split '/')[-1]) -eq $Asset) { $f[0].ToLower() }
        } | Select-Object -First 1
        if (-not $expected) { Stop-Install "$Asset is not listed in SHA256SUMS" }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $TmpExe).Hash.ToLower()
        if ($expected -ne $actual) { Stop-Install "checksum mismatch for $Asset (expected $expected, got $actual)" }
        Write-Ok 'Checksum verified'
    } else {
        Write-Warn2 "SHA256SUMS not found in $Version; skipping checksum verification"
    }

    $Upgrade = Test-Path $ExePath
    if ($Upgrade) {
        $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($t -and $t.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
        Stop-Cairn
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Move-Item -Force -Path $TmpExe -Destination $ExePath
    Unblock-File -Path $ExePath -ErrorAction SilentlyContinue
    if ($Upgrade) { Write-Ok "Upgraded $ExePath to $Version" } else { Write-Ok "Installed $ExePath" }
} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

# Put the install directory on the user's PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (-not ($userPath.Split(';') | Where-Object { $_.TrimEnd('\') -eq $InstallDir.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';'), $InstallDir) -join ';').TrimStart(';'), 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Ok "Added $InstallDir to your PATH (open a new terminal to use 'cairn')"
}

# --- ffmpeg ------------------------------------------------------------------

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warn2 'ffmpeg was not found. Cairn uses it for video, HEIC and AVIF thumbnails.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        if (Ask 'Install ffmpeg now with winget?' $true) {
            winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -eq 0) { Write-Ok 'ffmpeg installed (it is on PATH for new processes)' }
            else { Write-Warn2 'ffmpeg install failed; install it later yourself' }
        }
    } else {
        Write-Warn2 'Install ffmpeg (https://ffmpeg.org/download.html) and put it on PATH.'
    }
}

# --- autostart ---------------------------------------------------------------

function Wait-Health {
    for ($i = 0; $i -lt 20; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/api/v1/health" | Out-Null
            return $true
        } catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

$ListenAddr = "127.0.0.1:$Port"
$Autostart  = $false

if (-not $NoService) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $configure = $true
    if ($existing -and $Upgrade -and -not (Ask 'A Cairn startup task already exists. Rewrite its configuration?' $false)) {
        $configure = $false
        $Autostart = $true
        Start-ScheduledTask -TaskName $TaskName
        if (Wait-Health) { Write-Ok "Restarted Cairn on $Version" }
    }

    if ($configure -and (Ask 'Start Cairn automatically in the background?' $true)) {
        if (Ask "Allow other devices on your network to reach Cairn (listen on 0.0.0.0:$Port)?" $false) {
            $ListenAddr = "0.0.0.0:$Port"
            Write-Warn2 'Cairn serves plain HTTP. For access beyond your LAN, put a TLS reverse proxy in front.'
        }

        $isAdmin = Test-Admin
        $atBoot = $false
        if ($isAdmin) {
            $atBoot = Ask 'Start at boot, before anyone logs in? (otherwise: when you log in)' $true
        } else {
            Write-Info 'Cairn will start when you log in. (Run this installer as Administrator to start it at boot instead.)'
        }

        New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null
        $logFile = Join-Path $LogDir 'cairn.log'

        # Run through a hidden PowerShell so no console window appears; output goes to a log file.
        function Quote([string] $s) { "'" + $s.Replace("'", "''") + "'" }
        $cmd = "`$env:CAIRN_DATA_DIR=$(Quote $DataDir); `$env:CAIRN_HTTP_ADDR=$(Quote $ListenAddr); & $(Quote $ExePath) *>> $(Quote $logFile)"
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`"" `
            -WorkingDirectory $InstallDir
        $user = "$env:USERDOMAIN\$env:USERNAME"
        if ($atBoot) {
            $trigger   = New-ScheduledTaskTrigger -AtStartup
            # S4U: runs as you without storing your password. It cannot reach network shares.
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
        } else {
            $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        }
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

        if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
        Register-ScheduledTask -TaskName $TaskName -Description 'Cairn media server' `
            -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
        Write-Ok "Registered scheduled task '$TaskName'"
        $Autostart = $true

        if ($ListenAddr.StartsWith('0.0.0.0')) {
            if ($isAdmin) {
                if (Ask "Open TCP port $Port in Windows Firewall for private networks?" $true) {
                    Get-NetFirewallRule -DisplayName 'Cairn' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
                    New-NetFirewallRule -DisplayName 'Cairn' -Direction Inbound -Protocol TCP -LocalPort $Port `
                        -Action Allow -Profile Private | Out-Null
                    Write-Ok "Firewall rule added for port $Port (private networks)"
                }
            } else {
                Write-Warn2 "To reach Cairn from other devices, allow TCP port $Port in Windows Firewall (needs Administrator)."
            }
        }

        if (Ask 'Start Cairn now?' $true) {
            Start-ScheduledTask -TaskName $TaskName
            if (Wait-Health) { Write-Ok 'Cairn is running' }
            else { Write-Warn2 "Cairn did not answer yet. Check $logFile" }
        }
    }
}

# --- done --------------------------------------------------------------------

Write-Host ''
Write-Host "Cairn $Version is installed." -ForegroundColor Green
Write-Host ''
$hostName = if ($ListenAddr.StartsWith('0.0.0.0')) { $env:COMPUTERNAME } else { '127.0.0.1' }
if ($Autostart) {
    Write-Host "  Open:    http://${hostName}:$Port"
    Write-Host "  Status:  Get-ScheduledTask -TaskName $TaskName"
    Write-Host "  Stop:    Stop-ScheduledTask -TaskName $TaskName; Stop-Process -Name cairn"
    Write-Host "  Logs:    $LogDir\cairn.log"
    Write-Host "  Data:    $DataDir"
} else {
    Write-Host '  Run it:  cairn'
    Write-Host "  Open:    http://127.0.0.1:$Port"
}
Write-Host ''
Write-Host '  On first visit you will create the admin account.'
Write-Host '  Upgrade by running this installer again.'
Write-Host ''
