; SeaHi Serial - Inno Setup 安装脚本
; 使用 Inno Setup Compiler (ISCC) 编译此脚本生成安装程序

#define MyAppName "Seahi Serial"
#define MyAppVersion "0.2.6"
#define MyAppPublisher "SeaHi"
#define MyAppExeName "seahi-serial.exe"
#define MyAppDescription "串口调试器 - Tauri 2 桌面应用"
#define UsbipdMsiName "usbipd-win.msi"

[Setup]
; 应用基本信息
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/SeaHi-Mo/Seahi-Serial
AppSupportURL=https://github.com/SeaHi-Mo/Seahi-Serial/issues
AppUpdatesURL=https://github.com/SeaHi-Mo/Seahi-Serial/releases
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer
OutputBaseFilename=Seahi-Serial-Setup-{#MyAppVersion}
SetupIconFile=src-tauri\icons\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern

; 外观设置
WizardSizePercent=120
WizardImageFile=
WizardSmallImageFile=

; 权限 - 串口需要管理员权限才能访问；usbipd 安装也需要管理员权限
PrivilegesRequired=admin

[Languages]
Name: "chinese_simplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[CustomMessages]
chinese_simplified.UsbipdNotInstalled=检测到系统未安装 usbipd-win(WSL USB 映射功能所需)
chinese_simplified.UsbipdInstalling=正在安装 usbipd-win ...
chinese_simplified.UsbipdInstallFailed=usbipd-win 安装失败，WSL 映射功能将不可用。%n您可以稍后从 https://github.com/dorssel/usbipd-win/releases 手动下载安装。
chinese_simplified.UsbipdAlreadyInstalled=检测到已安装 usbipd-win，无需重复安装。
chinese_simplified.UsbipdDownloadFailed=下载 usbipd-win 失败，请检查网络连接。%n您可以稍后从 https://github.com/dorssel/usbipd-win/releases 手动下载安装。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"
Name: "install_usbipd"; Description: "安装 usbipd-win(WSL USB 串口映射支持)"; Flags: unchecked

[Files]
; 主程序 - 使用 Tauri 内嵌的 WebView2，无需额外 DLL
Source: "src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; 开始菜单快捷方式
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
; 桌面快捷方式
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Code]
// ===== usbipd-win 安装检查与自动安装 =====

var
  UsbipdInstalled: Boolean;
  DownloadPage: TDownloadWizardPage;

/// 检查 usbipd-win 是否已安装(通过注册表或 where 命令)
function IsUsbipdInstalled: Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  // 方式1：检查 where usbipd
  if Exec('where', 'usbipd', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := (ResultCode = 0);

  // 方式2：若 where 失败，检查默认安装路径
  if not Result then
    Result := FileExists(ExpandConstant('{pf}\usbipd\usbipd.exe'));
end;

/// 安装开始前：检测 usbipd，未安装则自动勾选安装任务
function InitializeSetup: Boolean;
begin
  Result := True;
  UsbipdInstalled := IsUsbipdInstalled;

  if not UsbipdInstalled then begin
    Log('usbipd-win not found, will offer to install');
    // 不弹窗阻断安装流程，只是记录状态
    // 安装页面中会自动勾选 install_usbipd 任务
  end else begin
    Log('usbipd-win already installed');
  end;
end;

/// 准备安装页面：若未安装 usbipd，自动勾选安装选项
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectTasks) and (not UsbipdInstalled) then begin
    // 自动勾选安装 usbipd 任务
    WizardForm.TasksList.CheckItem(WizardForm.TasksList.Items.Count - 1, coCheckWithChildren);
  end;
end;

/// 下载并安装 usbipd-win
/// 通过 GitHub API 获取真实下载 URL，避免 {version} 占位符导致 404 卡住
function DownloadAndInstallUsbipd: Boolean;
var
  ResultCode: Integer;
  MsiPath: String;
  PsScript: String;
  PsScriptPath: String;
begin
  Result := False;
  MsiPath := ExpandConstant('{tmp}\{#UsbipdMsiName}');

  // 1. 显示下载进度提示
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), nil);
  try
    DownloadPage.Show;
    DownloadPage.SetText('正在查询 usbipd-win 最新版本...', '');

    // 2. 写入 PowerShell 脚本：查询 GitHub API 获取真实下载 URL 并下载
    PsScript :=
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12' + #13#10 +
      'try {' + #13#10 +
      '  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/dorssel/usbipd-win/releases/latest" -UseBasicParsing -TimeoutSec 30' + #13#10 +
      '  $asset = $rel.assets | Where-Object { $_.name -like "*.msi" } | Select-Object -First 1' + #13#10 +
      '  if (-not $asset) { Write-Error "No MSI asset found"; exit 1 }' + #13#10 +
      '  $url = $asset.browser_download_url' + #13#10 +
      '  Write-Host "Downloading: $url"' + #13#10 +
      '  Invoke-WebRequest -Uri $url -OutFile "' + MsiPath + '" -UseBasicParsing -TimeoutSec 300' + #13#10 +
      '  if (Test-Path "' + MsiPath + '") { exit 0 } else { Write-Error "File not saved"; exit 1 }' + #13#10 +
      '} catch { Write-Error $_.Exception.Message; exit 1 }';

    PsScriptPath := ExpandConstant('{tmp}\usbipd_download.ps1');
    SaveStringToFile(PsScriptPath, PsScript, False);

    // 3. 执行下载（240 秒超时，避免无限卡住）
    DownloadPage.SetText('正在下载 usbipd-win ...', '此过程可能需要几分钟，请耐心等待');
    if not Exec('powershell', '-ExecutionPolicy Bypass -NonInteractive -File "' + PsScriptPath + '"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      Log('PowerShell download execution failed');
      MsgBox(CustomMessage('UsbipdDownloadFailed'), mbError, MB_OK);
      Exit;
    end;

    // 4. 检查下载结果
    if (ResultCode <> 0) or not FileExists(MsiPath) then begin
      Log('usbipd-win download failed, ResultCode=' + IntToStr(ResultCode));
      MsgBox(CustomMessage('UsbipdDownloadFailed'), mbError, MB_OK);
      Exit;
    end;

    // 5. 静默安装 MSI（安装程序本身已以管理员权限运行）
    DownloadPage.SetText('正在安装 usbipd-win ...', '');
    if Exec('msiexec', '/i "' + MsiPath + '" /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      if ResultCode = 0 then begin
        Log('usbipd-win MSI installed successfully');
        Result := True;
      end else begin
        Log('usbipd-win MSI install failed with code: ' + IntToStr(ResultCode));
        MsgBox(Format(CustomMessage('UsbipdInstallFailed'), [IntToStr(ResultCode)]), mbError, MB_OK);
      end;
    end else begin
      MsgBox(CustomMessage('UsbipdInstallFailed'), mbError, MB_OK);
    end;

  finally
    DownloadPage.Hide;
  end;
end;

/// CurStepChanged: 在安装阶段执行 usbipd 安装
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then begin
    // 检查是否勾选了安装 usbipd 任务
    if WizardIsTaskSelected('install_usbipd') then begin
      if UsbipdInstalled then begin
        Log('usbipd-win already installed, skipping');
      end else begin
        Log('Installing usbipd-win ...');
        if not DownloadAndInstallUsbipd then begin
          Log('usbipd-win installation failed, continuing with main app install');
          // 不阻断主程序安装，仅记录日志
        end;
      end;
    end;
  end;
end;

[Run]
; 安装完成后可选运行
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 卸载时删除配置文件
Type: filesandordirs; Name: "{app}"
