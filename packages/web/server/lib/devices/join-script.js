/**
 * Build a one-click Windows enrollment script.
 * The script is served with an enrollment token already embedded so the operator
 * only needs to paste one line on the target machine.
 */
export const buildJoinScript = ({
  serverOrigin,
  enrollToken,
  approval = 'smart',
  enableWindowsMcp = true,
}) => {
  const origin = String(serverOrigin || '').replace(/\/$/, '');
  const token = String(enrollToken || '');
  const approvalMode = approval === 'auto' || approval === 'deny' ? approval : 'smart';
  const mcpEnabled = enableWindowsMcp !== false;

  return `# OpenChamber device join (generated)
# One-shot enrollment. Token is single-use and short-lived.
$ErrorActionPreference = 'Stop'
$Server = '${origin.replace(/'/g, "''")}'
$Token = '${token.replace(/'/g, "''")}'
$Approval = '${approvalMode}'
$EnableWindowsMcp = $${mcpEnabled ? 'true' : 'false'}

function Write-Step($msg) { Write-Host "[join] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "[join] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[join] $msg" -ForegroundColor Yellow }

Write-Step "OpenChamber device enrollment"
Write-Step "Server: $Server"

$computer = $env:COMPUTERNAME
$name = $computer
$user = $env:USERNAME

# --- SSH key ---
$sshDir = Join-Path $env:USERPROFILE '.ssh'
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir | Out-Null }
$keyPath = Join-Path $sshDir 'id_ed25519_openchamber'
if (-not (Test-Path $keyPath)) {
  Write-Step "Generating SSH key pair"
  ssh-keygen -t ed25519 -f $keyPath -N '""' -C 'openchamber-device' | Out-Null
} else {
  Write-Step "Reusing existing SSH key: $keyPath"
}
$privateKey = Get-Content $keyPath -Raw
$publicKey = (Get-Content "$keyPath.pub" -Raw).Trim()

# --- Connection candidates ---
$tsIp = $null
try {
  $tsJson = & tailscale status --json 2>$null | ConvertFrom-Json
  if ($tsJson -and $tsJson.Self -and $tsJson.Self.TailscaleIPs) {
    $tsIp = @($tsJson.Self.TailscaleIPs | Where-Object { $_ -like '*.*' })[0]
  }
} catch { }

$sshPort = 22
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
# Ensure OpenSSH server is installed and running
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshd) {
  if ($isAdmin) {
    Write-Step "Installing OpenSSH Server capability (silent)"
    try {
      Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    } catch {
      Write-Warn2 "OpenSSH capability install failed: $($_.Exception.Message)"
    }
  } else {
    Write-Warn2 "OpenSSH Server not installed. Install with:"
    Write-Warn2 "  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0"
  }
  $sshd = Get-Service sshd -ErrorAction SilentlyContinue
}
if ($sshd) {
  if ($sshd.Status -ne 'Running') { Start-Service sshd }
  Set-Service sshd -StartupType Automatic
  Write-Ok "sshd running (Automatic)"
} else {
  Write-Warn2 "sshd still missing — shell/file tools will fail until installed"
}

# Authorize this user's key. Admin users use administrators_authorized_keys.
if ($isAdmin) {
  $adminKeys = 'C:\\ProgramData\\ssh\\administrators_authorized_keys'
  $existing = ''
  if (Test-Path $adminKeys) { $existing = Get-Content $adminKeys -Raw }
  if ($existing -notmatch [regex]::Escape($publicKey)) {
    Write-Step "Adding public key to administrators_authorized_keys"
    Add-Content -Path $adminKeys -Value $publicKey -Encoding utf8
  }
  Write-Ok "SSH key authorized (admin)"
} else {
  $ak = Join-Path $sshDir 'authorized_keys'
  $existing = ''
  if (Test-Path $ak) { $existing = Get-Content $ak -Raw }
  if ($existing -notmatch [regex]::Escape($publicKey)) {
    Add-Content -Path $ak -Value $publicKey -Encoding utf8
  }
  Write-Warn2 "Not elevated — if this account is in Administrators, run once as admin:"
  Write-Warn2 "  Add-Content C:\\ProgramData\\ssh\\administrators_authorized_keys -Value (Get-Content $keyPath.pub)"
}

# --- Windows-MCP: silent install + login autostart ---
$mcpBearer = $null
$mcpPort = $null
$mcpReady = $false
if ($EnableWindowsMcp) {
  $mcpPort = 18080
  $mcpHost = '127.0.0.1'
  $mcpBearer = 'wmcp_' + [guid]::NewGuid().ToString('N')
  $wmcpDir = Join-Path $env:USERPROFILE '.windows-mcp'
  $cfgPath = Join-Path $wmcpDir 'config.toml'

  Write-Step "Installing Windows-MCP (silent, login autostart)"

  # Telemetry off for personal fleet
  [Environment]::SetEnvironmentVariable('ANONYMIZED_TELEMETRY', 'false', 'User')
  $env:ANONYMIZED_TELEMETRY = 'false'

  function Test-Uv {
    try { $null = Get-Command uv -ErrorAction Stop; return $true } catch { return $false }
  }

  if (-not (Test-Uv)) {
    Write-Step "Installing uv package manager"
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      try {
        winget install --id astral-sh.uv -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
      } catch {
        Write-Warn2 "winget uv install failed, trying official installer"
      }
    }
    if (-not (Test-Uv)) {
      try {
        irm https://astral.sh/uv/install.ps1 | iex
      } catch {
        Write-Warn2 "uv install failed: $($_.Exception.Message)"
      }
    }
    # Refresh PATH for current session
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $env:Path = "$userPath;$machinePath"
  }

  if (Test-Uv) {
    # Persist auth + bind settings; scheduled task runs serve and reads this file.
    if (-not (Test-Path $wmcpDir)) { New-Item -ItemType Directory -Path $wmcpDir | Out-Null }
    $toml = @"
[server]
transport = "streamable-http"
host = "$mcpHost"
port = $mcpPort
auth_key = "$mcpBearer"
"@
    # UTF-8 without BOM — Windows PowerShell -Encoding utf8 writes a BOM that
    # Python tomllib rejects ("Invalid statement at line 1").
    [IO.File]::WriteAllText($cfgPath, $toml, (New-Object System.Text.UTF8Encoding $false))
    try {
      $acl = Get-Acl $cfgPath
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'Read', 'Allow')
      $acl.SetAccessRule($rule)
      Set-Acl -Path $cfgPath -AclObject $acl
    } catch { }

    # First resolve/download the package (may take a minute), then register task.
    Write-Step "Preparing windows-mcp package (first run may take a minute)"
    try {
      uvx windows-mcp --help | Out-Null
    } catch {
      Write-Warn2 "uvx windows-mcp warmup failed: $($_.Exception.Message)"
    }

    Write-Step "Registering login autostart for Windows-MCP"
    $installedTask = $false
    try {
      uvx windows-mcp install --force --transport streamable-http --host $mcpHost --port $mcpPort
      $installedTask = $true
      Write-Ok "Scheduled task windows-mcp-server installed (starts at login)"
    } catch {
      Write-Warn2 "Scheduled task install failed (often needs admin). Falling back to Startup folder."
    }

    if (-not $installedTask) {
      # HKCU Startup — no admin required, runs at user logon.
      $startup = [Environment]::GetFolderPath('Startup')
      $wrapper = Join-Path $startup 'openchamber-windows-mcp.cmd'
      $uvx = (Get-Command uvx -ErrorAction SilentlyContinue).Source
      if (-not $uvx) { $uvx = 'uvx' }
      $cmd = @"
@echo off
set ANONYMIZED_TELEMETRY=false
"$uvx" windows-mcp serve --transport streamable-http --host $mcpHost --port $mcpPort >> "%USERPROFILE%\\.windows-mcp\\server.log" 2>&1
"@
      Set-Content -Path $wrapper -Value $cmd -Encoding ascii
      Write-Ok "Startup autostart: $wrapper"
      # Start now
      Start-Process -FilePath $wrapper -WindowStyle Hidden
    }

    # Wait briefly for health
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
      try {
        $r = Invoke-WebRequest -Uri "http://$($mcpHost):$($mcpPort)/mcp" -Method Post -Headers @{ Authorization = "Bearer $mcpBearer"; accept = 'application/json, text/event-stream' } -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"join","version":"0"}}}' -TimeoutSec 5 -UseBasicParsing
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { $mcpReady = $true; break }
      } catch { Start-Sleep -Seconds 2 }
    }
    if ($mcpReady) {
      Write-Ok "Windows-MCP listening on $($mcpHost):$($mcpPort) (autostart on)"
    } else {
      Write-Warn2 "Windows-MCP not answering yet — check %USERPROFILE%\\.windows-mcp\\server.log"
    }
  } else {
    Write-Warn2 "uv not available — skip Windows-MCP autostart (shell/files still work)"
    $mcpBearer = $null
    $mcpPort = $null
  }
}

# --- Enroll ---
if (-not $mcpReady) {
  $mcpBearer = $null
  $mcpPort = $null
}
$connection = @{}
if ($tsIp) {
  $connection.tailscale = @{ host = $tsIp; sshPort = $sshPort; mcpPort = $mcpPort }
  Write-Ok "Tailscale IP: $tsIp"
}
$connection.tunnel = @{ sshPort = $sshPort; mcpPort = $mcpPort }

$capabilities = @{ shell = $true; files = $true; screen = [bool]$mcpReady }
$body = @{
  name = $name
  platform = 'windows'
  capabilities = $capabilities
  connection = $connection
  auth = @{ sshUser = $user }
  approval = $Approval
  sshPrivateKey = $privateKey
}
if ($mcpBearer) { $body.mcpBearer = $mcpBearer }

Write-Step "Registering device with OpenChamber…"
$enrollUrl = "$Server/api/devices/enroll"
$headers = @{
  'content-type' = 'application/json'
  authorization = "Bearer $Token"
}
try {
  $response = Invoke-RestMethod -Uri $enrollUrl -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 8)
  $device = $response.device
  Write-Ok "Registered: $($device.name)  id=$($device.id)"
  Write-Host ""
  Write-Host "Next steps:" -ForegroundColor Cyan
  Write-Host "  1. Enrollment token is spent."
  Write-Host "  2. Agent MCP endpoint: POST $Server/api/devices/mcp"
  Write-Host "  3. Create an agent token in OpenChamber Settings → Devices."
  if ($mcpReady) {
    Write-Host "  4. Windows-MCP is running and will restart at login (task: windows-mcp-server)."
    Write-Host "     Uninstall: uvx windows-mcp uninstall"
  }
  Write-Host ""
  Write-Ok "Done."
} catch {
  $status = $null
  try { $status = [int]$_.Exception.Response.StatusCode } catch { }
  Write-Host "[join] Enrollment failed HTTP $status" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($status -eq 401) { Write-Host "Token invalid/expired/used. Generate a new one from Settings → Devices." }
  exit 1
}
`;
};
