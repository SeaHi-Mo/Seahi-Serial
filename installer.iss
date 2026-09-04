; SeaHi Serial - Inno Setup 安装脚本
; 使用 Inno Setup Compiler (ISCC) 编译此脚本生成安装程序

#define MyAppName "Seahi Serial"
#define MyAppVersion "0.3.6"
#define MyAppPublisher "SeaHi"
#define MyAppExeName "seahi-serial.exe"
#define MyAppDescription "串口调试器 - Tauri 2 桌面应用"
#define UsbipdMsiName "usbipd-win.msi"
#define WebView2BootstrapperUrl "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

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
chinese_simplified.WebView2NotInstalled=检测到系统未安装 WebView2 Runtime（界面渲染必需）
chinese_simplified.WebView2Installing=正在安装 WebView2 Runtime ...
chinese_simplified.WebView2InstallFailed=WebView2 Runtime 安装失败（错误码 %1）。%n界面可能无法正常显示，您可以从 https://developer.microsoft.com/microsoft-edge/webview2/ 手动安装。
chinese_simplified.WebView2AlreadyInstalled=检测到已安装 WebView2 Runtime。
chinese_simplified.WebView2DownloadFailed=下载 WebView2 Runtime 失败，请检查网络连接。%n界面可能无法正常显示，您可以从 https://developer.microsoft.com/microsoft-edge/webview2/ 手动安装。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"
Name: "install_usbipd"; Description: "安装 usbipd-win(WSL USB 串口映射支持)"; Flags: unchecked
Name: "add_adb_path"; Description: "将 ADB 工具(platform-tools)添加至系统 PATH（终端/脚本可直接使用 adb）"

[Files]
; 主程序 - 使用 Tauri 内嵌的 WebView2，无需额外 DLL
Source: "src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; ADB 工具(platform-tools) - 随安装包分发，运行时零下载
Source: "platform-tools\*"; DestDir: "{app}\platform-tools"; Flags: recursesubdirs ignoreversion

[Icons]
; 开始菜单快捷方式
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
; 桌面快捷方式
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Code]
// ===== usbipd-win 安装检查与自动安装 =====

var
  UsbipdInstalled: Boolean;
  WebView2Installed: Boolean;
  DownloadPage: TDownloadWizardPage;

/// 检查 WebView2 Runtime 是否已安装（通过 EdgeUpdate 注册表键）
function IsWebView2Installed: Boolean;
var
  Version: String;
begin
  Result := False;
  // 32 位视图（Inno Setup 32 位编译默认）：64 位系统上 WebView2 注册在 WOW6432Node
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
    Result := Version <> '';
  // 64 位视图
  if not Result then begin
    if RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
      Result := Version <> '';
  end;
  // 每用户安装
  if not Result then begin
    if RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
      Result := Version <> '';
  end;
end;

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
  WebView2Installed := IsWebView2Installed;

  if not UsbipdInstalled then begin
    Log('usbipd-win not found, will offer to install');
    // 不弹窗阻断安装流程，只是记录状态
    // 安装页面中会自动勾选 install_usbipd 任务
  end else begin
    Log('usbipd-win already installed');
  end;

  if not WebView2Installed then begin
    Log('WebView2 Runtime not found, will install during setup');
  end else begin
    Log('WebView2 Runtime already installed');
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

/// 下载并安装 WebView2 Runtime（Evergreen Bootstrapper）
/// 使用微软官方引导程序，仅下载安装缺失的运行时
function DownloadAndInstallWebView2: Boolean;
var
  ResultCode: Integer;
  BootstrapperPath: String;
begin
  Result := False;
  BootstrapperPath := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');

  // 1. 显示下载进度提示
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), nil);
  try
    DownloadPage.Show;
    DownloadPage.SetText(CustomMessage('WebView2Installing'), '');

    // 2. 下载官方 Evergreen Bootstrapper（加入队列后执行下载，文件写入 {tmp}）
    DownloadPage.Clear;
    DownloadPage.Add('{#WebView2BootstrapperUrl}', 'MicrosoftEdgeWebview2Setup.exe', '');
    try
      DownloadPage.Download;
    except
      Log('WebView2 bootstrapper download failed: ' + GetExceptionMessage);
      MsgBox(CustomMessage('WebView2DownloadFailed'), mbError, MB_OK);
      Exit;
    end;

    // 3. 静默安装（安装程序本身已以管理员权限运行）
    DownloadPage.SetText(CustomMessage('WebView2Installing'), '此过程可能需要几分钟，请耐心等待');
    if Exec(BootstrapperPath, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      if ResultCode = 0 then begin
        Log('WebView2 Runtime installed successfully');
        Result := True;
      end else begin
        Log('WebView2 Runtime install failed with code: ' + IntToStr(ResultCode));
        MsgBox(Format(CustomMessage('WebView2InstallFailed'), [IntToStr(ResultCode)]), mbError, MB_OK);
      end;
    end else begin
      MsgBox(CustomMessage('WebView2InstallFailed'), mbError, MB_OK);
    end;

  finally
    DownloadPage.Hide;
  end;
end;

/// 修改系统 PATH（安全）：add=追加 entry、remove=移除 entry，均保留 REG_EXPAND_SZ（含 %SystemRoot% 等表达式）
procedure ModifyPathEntry(const Op, Entry: String);
var
  Ps, PsPath: String;
  ResultCode: Integer;
begin
  Ps :=
    '$entry=' + '''' + Entry + '''' + #13#10 +
    '$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(''SYSTEM\CurrentControlSet\Control\Session Manager\Environment'', $true)' + #13#10 +
    'if($k){' + #13#10 +
    '  $raw=$k.GetValue(''Path'','''',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)' + #13#10 +
    '  if($raw -is [string]){' + #13#10 +
    '    $parts=$raw -split '';''' + #13#10 +
    '    $parts=@($parts | Where-Object { $_.Trim() -ne '''' })' + #13#10 +
    '    if(' + '''' + Op + '''' + ' -eq ''add''){' + #13#10 +
    '      if(-not ($parts | Where-Object { $_.Trim() -eq $entry })){' + #13#10 +
    '        $parts += $entry' + #13#10 +
    '        $k.SetValue(''Path'', ($parts -join '';''), [Microsoft.Win32.RegistryValueKind]::ExpandString)' + #13#10 +
    '      }' + #13#10 +
    '    } else {' + #13#10 +
    '      $parts=@($parts | Where-Object { $_.Trim() -ne $entry })' + #13#10 +
    '      $k.SetValue(''Path'', ($parts -join '';''), [Microsoft.Win32.RegistryValueKind]::ExpandString)' + #13#10 +
    '    }' + #13#10 +
    '  }' + #13#10 +
    '  $k.Close()' + #13#10 +
    '}';
  PsPath := ExpandConstant('{tmp}\adb_path.ps1');
  SaveStringToFile(PsPath, Ps, False);
  // 以宿主身份运行，失败不阻断安装/卸载流程
  Exec('powershell', '-ExecutionPolicy Bypass -NonInteractive -File "' + PsPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure AddAdbToPath;
begin
  ModifyPathEntry('add', ExpandConstant('{app}\platform-tools'));
end;

procedure RemoveAdbFromPath;
begin
  ModifyPathEntry('remove', ExpandConstant('{app}\platform-tools'));
end;

/// CurStepChanged: 在安装阶段执行 usbipd 安装、PATH 追加
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

    // WebView2 Runtime 是界面渲染必需项：缺失时无条件安装（不依赖用户勾选）
    if not WebView2Installed then begin
      Log('Installing WebView2 Runtime ...');
      if not DownloadAndInstallWebView2 then begin
        Log('WebView2 Runtime installation failed, continuing with main app install');
        // 不阻断主程序安装，仅记录日志并提示用户
      end;
    end;
  end else if CurStep = ssPostInstall then begin
    // 安装完成后：勾选了则把 ADB 加入系统 PATH
    if WizardIsTaskSelected('add_adb_path') then
      AddAdbToPath;
  end;
end;

/// CurUninstallStepChanged: 卸载时移除 ADB 的 PATH 条目
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveAdbFromPath;
end;

[Run]
; 安装完成后可选运行
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 卸载时删除配置文件
Type: filesandordirs; Name: "{app}"
