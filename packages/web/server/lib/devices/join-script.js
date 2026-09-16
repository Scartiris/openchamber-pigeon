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
# Ensure OpenSSH server is installed and running
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshd) {
  Write-Warn2 "OpenSSH Server not installed. Install with:"
  Write-Warn2 "  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0"
  Write-Warn2 "Then start: Start-Service sshd"
} else {
  if ($sshd.Status -ne 'Running') { Start-Service sshd }
  Set-Service sshd -StartupType Automatic
  Write-Ok "sshd running"
}

# Authorize this user's key. Admin users use administrators_authorized_keys.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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

# --- Optional Windows-MCP bearer ---
$mcpBearer = $null
$mcpPort = $null
if ($EnableWindowsMcp) {
  $mcpBearer = 'wmcp_' + [guid]::NewGuid().ToString('N')
  $mcpPort = 18080
  Write-Warn2 "Windows-MCP install is optional. If installed, use:"
  Write-Warn2 "  uvx windows-mcp serve --transport streamable-http --host 127.0.0.1 --port $mcpPort --auth-key $mcpBearer"
}

# --- Enroll ---
$connection = @{}
if ($tsIp) {
  $connection.tailscale = @{ host = $tsIp; sshPort = $sshPort; mcpPort = $mcpPort }
  Write-Ok "Tailscale IP: $tsIp"
}
$connection.tunnel = @{ sshPort = $sshPort; mcpPort = $mcpPort }

$capabilities = @{ shell = $true; files = $true; screen = [bool]$mcpBearer }
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
  Write-Host "  1. Keep this terminal — enrollment token is now spent."
  Write-Host "  2. Agent MCP endpoint: POST $Server/api/devices/mcp"
  Write-Host "  3. Create an agent token in OpenChamber Settings → Devices."
  if ($mcpBearer) {
    Write-Host "  4. Windows-MCP bearer (save it): $mcpBearer"
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
