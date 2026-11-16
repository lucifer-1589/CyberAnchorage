<#
.SYNOPSIS
  Run CyberAnchorage on Windows without Docker, Make or Redis.

.DESCRIPTION
  One process does everything: embedded PostgreSQL 16 (pgserver), the FastAPI API, the scheduler
  (hourly + daily 07:00 UTC syncs), the real-time seam, and the built web UI.
  Everything binds to 127.0.0.1. The CTI folder is only ever read through snapshots.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\run-local.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\run-local.ps1 -Demo         # add the synthetic demo dataset
  powershell -ExecutionPolicy Bypass -File .\scripts\run-local.ps1 -Simulator    # simulated real-time detections

  By default only the real Dark Web CTI data is shown: any demo data or simulated detections left in the
  database are removed on start and the IOC store is rebuilt from the real CTI stores.
#>
param(
    [switch]$Demo,
    [switch]$Simulator,
    [switch]$Reseed,
    [switch]$NoBrowser,
    [int]$Port = 8077
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Backend = Join-Path $Root "backend"
$Py = Join-Path $Backend ".venv\Scripts\python.exe"
$EnvFile = Join-Path $Root ".env"
$Dist = Join-Path $Root "web\dist"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# 1. Python 3.12 + virtual environment -------------------------------------------------------------
if (-not (Test-Path $Py)) {
    Step "Creating Python virtual environment (first run only, takes a few minutes)"
    $venvDir = Join-Path $Backend ".venv"
    $made = $false
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3.12 -m venv $venvDir 2>$null
        $made = ($LASTEXITCODE -eq 0)
    }
    if (-not $made -and (Get-Command python -ErrorAction SilentlyContinue)) {
        $ver = & python -c "import sys; print('%d.%d' % sys.version_info[:2])"
        if ($ver -eq "3.12") { & python -m venv $venvDir; $made = ($LASTEXITCODE -eq 0) }
    }
    if (-not $made) { throw "Python 3.12 is required. Install it from https://www.python.org/downloads/ and re-run." }
    & $Py -m pip install --upgrade pip --quiet
    & $Py -m pip install -e "$Backend[dev]" --quiet
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
}

# 2. .env with generated secrets --------------------------------------------------------------------
if (-not (Test-Path $EnvFile)) {
    Step "Creating .env with a random JWT secret and admin password"
    $secret = & $Py -c "import secrets; print(secrets.token_urlsafe(48))"
    $adminPw = & $Py -c "import secrets; print(secrets.token_urlsafe(12))"
    $lines = Get-Content (Join-Path $Root ".env.example") | ForEach-Object {
        if ($_ -match '^JWT_SECRET=') { "JWT_SECRET=$secret" }
        elseif ($_ -match '^ADMIN_PASSWORD=') { "ADMIN_PASSWORD=$adminPw" }
        elseif ($_ -match '^REDIS_URL=') { "REDIS_URL=" }
        else { $_ }
    }
    [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))  # no BOM
    Write-Host ""
    Write-Host "   Admin login:  admin@anchorage.local  /  $adminPw" -ForegroundColor Yellow
    Write-Host "   (saved in .env as ADMIN_PASSWORD)" -ForegroundColor Yellow
    Write-Host ""
}

# 3. Web UI (built once, rebuilt when the frontend source changes, e.g. after git pull) ------------
$Web = Join-Path $Root "web"
$built = Join-Path $Dist "index.html"
$stale = $false
if (Test-Path $built) {
    $builtAt = (Get-Item $built).LastWriteTimeUtc
    $sources = @(Get-ChildItem (Join-Path $Web "src") -Recurse -File) +
        @(Get-Item (Join-Path $Web "index.html"), (Join-Path $Web "package.json"), (Join-Path $Web "vite.config.ts"), (Join-Path $Web "tailwind.config.ts"))
    $stale = [bool]($sources | Where-Object { $_.LastWriteTimeUtc -gt $builtAt } | Select-Object -First 1)
}
if (-not (Test-Path $built) -or $stale) {
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Step $(if ($stale) { "Frontend changed since the last build - rebuilding the web UI" } else { "Building the web UI (first run only)" })
        Push-Location $Web
        try {
            if (-not (Test-Path "node_modules") -or ((Get-Item "package-lock.json").LastWriteTimeUtc -gt (Get-Item "node_modules").LastWriteTimeUtc)) {
                npm ci --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
            }
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "web UI build failed" }
        } finally { Pop-Location }
    } elseif ($stale) {
        Write-Warning "The frontend source is newer than web\dist but Node.js is not installed; serving the previous build. Install Node 20 LTS from https://nodejs.org to get the latest UI."
    } else {
        throw "web\dist is missing and Node.js is not installed. Install Node 20 LTS from https://nodejs.org and re-run."
    }
}

# 4. Embedded PostgreSQL ----------------------------------------------------------------------------
Step "Starting embedded PostgreSQL (data in data\pg)"
$PgHelper = Join-Path $Root "scripts\local_pg.py"
$dbUrl = & $Py $PgHelper start
if ($LASTEXITCODE -ne 0 -or -not $dbUrl) { throw "PostgreSQL did not start" }

$env:DATABASE_URL = $dbUrl
$env:REDIS_URL = ""
$env:EMBEDDED_WORKER = "true"
$env:WEB_DIST_DIR = $Dist
$env:DEMO_CTI_DIR = Join-Path $Root "data\demo-cti"
$env:CORS_ORIGINS = "http://127.0.0.1:$Port"
$env:PYTHONUTF8 = "1"
if ($Simulator) { $env:ENABLE_SIMULATOR = "true" }
# CTI_DATA_DIR is resolved relative to the repo root unless it is absolute
$cti = (Get-Content $EnvFile | Where-Object { $_ -match '^CTI_DATA_DIR=' }) -replace '^CTI_DATA_DIR=', ''
if ($cti -and -not [System.IO.Path]::IsPathRooted($cti)) { $cti = Join-Path $Root $cti }
if ($cti) {
    $env:CTI_DATA_DIR = $cti
    if (-not (Test-Path $cti)) { Write-Warning "CTI_DATA_DIR not found: $cti (only demo data will be ingested)" }
}

Push-Location $Backend
try {
    # 5. Schema, first admin, demo data --------------------------------------------------------------
    Step "Applying database migrations"
    & $Py -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "migrations failed" }
    & $Py -m anchorage.cli bootstrap

    if ($Demo -or $Reseed) {
        Step "Seeding demo data (synthetic CTI fixture + sample rules + first sync)"
        if ($Reseed) { & $Py -m anchorage.cli seed-demo } else { & $Py -m anchorage.cli seed-demo --if-empty }
    } else {
        Step "Real CTI data only: removing any demo data and simulated detections"
        & $Py -m anchorage.cli purge-demo --if-present
        if ($LASTEXITCODE -ne 0) { throw "purge-demo failed" }
    }

    # 6. Run ----------------------------------------------------------------------------------------
    $url = "http://127.0.0.1:$Port"
    Step "CyberAnchorage is starting at $url  (Ctrl+C to stop)"
    if (-not $NoBrowser) { Start-Job -ScriptBlock { param($u) Start-Sleep 4; Start-Process $u } -ArgumentList $url | Out-Null }
    & $Py -m uvicorn anchorage.main:app --host 127.0.0.1 --port $Port
} finally {
    Pop-Location
    Write-Host "==> Stopping embedded PostgreSQL" -ForegroundColor Cyan
    & $Py $PgHelper stop | Out-Null
}
