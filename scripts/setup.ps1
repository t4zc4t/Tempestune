# gets everything tempestune needs onto this pc: java, lavalink, yt-dlp, ffmpeg, then installs and builds the bot
# safe to run again, it only downloads what is missing or out of date
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$ll = Join-Path $root 'lavalink'
$tools = Join-Path $ll 'tools'
$stampFile = Join-Path $ll 'versions.json'
New-Item -ItemType Directory -Force $tools | Out-Null

# bump these to update, setup notices and fetches the new one
$want = [ordered]@{ lavalink = '4.2.2'; ytdlp = '2026.10.26'; ffmpeg = '9.0' }

$have = @{}
if (Test-Path $stampFile) { (Get-Content $stampFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $have[$_.Name] = $_.Value } }
# older boot scripts kept the lavalink version in version.txt
$old = Join-Path $ll 'version.txt'
if (-not $have.lavalink -and (Test-Path $old)) { $have.lavalink = (Get-Content $old -Raw).Trim() }
function Save-Stamp { $have | ConvertTo-Json | Set-Content $stampFile }

function Get-File($url, $out) {
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out; return }
    catch { if ($i -eq 3) { throw "download failed: $url" }; Start-Sleep -Seconds 3 }
  }
}

# java from PATH if there is one, otherwise a portable one inside lavalink\jre
if (-not (Get-Command java -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $ll 'jre\bin\java.exe'))) {
  Write-Host 'Getting a portable Java 25...'
  $zip = Join-Path $ll 'jre.zip'
  Get-File 'https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jre/hotspot/normal/eclipse' $zip
  $tmp = Join-Path $ll 'jre-tmp'
  Expand-Archive $zip $tmp -Force
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName (Join-Path $ll 'jre')
  Remove-Item $tmp, $zip -Recurse -Force
}

$jar = Join-Path $ll 'Lavalink.jar'
if ($have.lavalink -ne $want.lavalink -or -not (Test-Path $jar)) {
  Write-Host "Getting Lavalink $($want.lavalink)..."
  Get-File "https://github.com/lavalink-devs/Lavalink/releases/download/$($want.lavalink)/Lavalink.jar" $jar
  $have.lavalink = $want.lavalink; Save-Stamp
}

$ytdlp = Join-Path $tools 'yt-dlp.exe'
if ($have.ytdlp -ne $want.ytdlp -or -not (Test-Path $ytdlp)) {
  Write-Host "Getting yt-dlp $($want.ytdlp)..."
  Get-File "https://github.com/yt-dlp/yt-dlp/releases/download/$($want.ytdlp)/yt-dlp.exe" $ytdlp
  $have.ytdlp = $want.ytdlp; Save-Stamp
}

$ffmpeg = Join-Path $tools 'ffmpeg'
if ($have.ffmpeg -ne $want.ffmpeg -or -not (Test-Path (Join-Path $ffmpeg 'bin\ffmpeg.exe'))) {
  Write-Host "Getting ffmpeg $($want.ffmpeg) (one time, about 65 MB)..."
  $name = "ffmpeg-n$($want.ffmpeg)-latest-win64-lgpl-shared-$($want.ffmpeg)"
  $zip = Join-Path $tools 'ffmpeg.zip'
  Get-File "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$name.zip" $zip
  if (Test-Path $ffmpeg) { Remove-Item $ffmpeg -Recurse -Force }
  Expand-Archive $zip $tools -Force
  Move-Item (Join-Path $tools $name) $ffmpeg
  Remove-Item $zip -Force
  $have.ffmpeg = $want.ffmpeg; Save-Stamp
}

Push-Location $root
try {
  Write-Host 'Getting the bot ready...'
  & npm.cmd install --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  & npm.cmd run build --silent
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
} finally { Pop-Location }
