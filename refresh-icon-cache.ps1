# 强制刷新 Windows 图标缓存
Write-Host "正在刷新 Windows 图标缓存..." -ForegroundColor Cyan

# 1. 结束资源管理器进程
Write-Host "步骤 1/4: 结束 explorer.exe..."
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 2. 删除本地图标缓存数据库
Write-Host "步骤 2/4: 清除本地图标缓存..."
$iconCachePath = "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache*"
Remove-Item -Path $iconCachePath -Force -ErrorAction SilentlyContinue

# 3. 删除缩略图缓存
Write-Host "步骤 3/4: 清除缩略图缓存..."
$thumbCachePath = "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache*"
Remove-Item -Path $thumbCachePath -Force -ErrorAction SilentlyContinue

# 4. 重启资源管理器
Write-Host "步骤 4/4: 重启 explorer.exe..."
Start-Process explorer

Write-Host "图标缓存已刷新！请检查 seahi-serial.exe 的图标是否已更新。" -ForegroundColor Green
Write-Host ""
Write-Host "如果仍未更新，还可以尝试以下额外方法：" -ForegroundColor Yellow
Write-Host "  - 将 exe 复制到其他文件夹查看" -ForegroundColor Gray
Write-Host "  - 或修改 exe 文件名后再改回来" -ForegroundColor Gray
