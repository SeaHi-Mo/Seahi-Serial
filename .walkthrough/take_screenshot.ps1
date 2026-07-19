param(
  [string]$OutPath,
  [string]$ProcessName = "seahi-serial"
)

# Activate target window first so it is in foreground
$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
  $ws = New-Object -ComObject WScript.Shell
  $ws.AppActivate($p.Id) | Out-Null
  Start-Sleep -Milliseconds 600
}

# Capture virtual screen (full desktop including multi-monitor)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)

$dir = Split-Path $OutPath -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Output $OutPath
