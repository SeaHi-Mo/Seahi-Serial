; SeaHi Serial - Inno Setup 安装脚本
; 使用 Inno Setup Compiler (ISCC) 编译此脚本生成安装程序

#define MyAppName "Seahi Serial"
#define MyAppVersion "0.5.2"
#define MyAppPublisher "SeaHi"
#define MyAppExeName "seahi-serial.exe"
#define MyAppDescription "串口调试器 - Tauri 2 桌面应用"
#define UsbipdMsiName "usbipd-win.msi"
#define WebView2BootstrapperUrl "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

; ===== 版本守卫（2026-09 加，别删）=====
; 事故：Cargo.toml 已改成 0.5.0，但 src-tauri\target\release\seahi-serial.exe 还是 0.4.0 的旧构建。
; 主程序版本来自 env!("CARGO_PKG_VERSION")，是**编译期烘焙**进 exe 的 —— 只改版本号文件、
; 不重新编译，exe 里的版本就不会变。于是安装包的文件名/产品版本是 0.5.0，装出来的应用却是 0.4.0。
; 下面在编译安装包时就把这种不一致卡死，避免再把旧内核装进新外壳。
; 注：GetVersionNumbersString 返回四段式（"0.5.0.0"），所以拿 MyAppVersion 比较时补一个 ".0"。
#define BundledExeVersion GetVersionNumbersString("src-tauri\target\release\" + MyAppExeName)
#pragma message "打包的主程序版本 = " + BundledExeVersion + " / MyAppVersion = " + MyAppVersion
#if BundledExeVersion != MyAppVersion + ".0"
  #error 打包的主程序版本与 MyAppVersion 不一致！请先重新编译发布产物（npm run build，或 cargo build --release --manifest-path src-tauri/Cargo.toml），再编译本安装脚本。
#endif

[Setup]
; 应用基本信息
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
; 让安装包自身的「文件版本」也有值（此前只有产品版本有值，文件版本一栏是空白，容易看错版本）
VersionInfoVersion={#MyAppVersion}
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
; ⚠️ 下面三个 flag 都与「重复安装 / 升级」直接相关，别删：
;   replacesameversion —— 版本号相同时先比对内容，不同才覆写（替代原 ignoreversion）。
;        adb 服务器常驻并锁住 platform-tools 下的文件，而无条件重写全部 14 个文件
;        只会平白制造「文件被占用」的安装错误；内容相同就没必要重写。
;   restartreplace     —— 万一文件仍被占用（如另一个用户会话里的 adb），登记到重启后替换，
;        而不是 Inno 默认的「重试 4 次后弹错」。
;   uninsrestartdelete —— 卸载时被占用的文件同样登记到重启后删除，避免 platform-tools 残留。
; 注：adb.exe / fastboot.exe 等**没有版本信息**，按 Inno 规则每次安装仍会覆写它们 →
;     所以安装/卸载前必须先把常驻的 adb 服务器停掉，见 [Code] 的 StopAdbServer。
Source: "platform-tools\*"; DestDir: "{app}\platform-tools"; Flags: recursesubdirs replacesameversion restartreplace uninsrestartdelete

[Icons]
; 开始菜单快捷方式
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
; 桌面快捷方式
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Code]
// ===== usbipd-win 安装检查与自动安装 =====

const
  // [Tasks] 段中任务的声明顺序（0-based）：0=desktopicon，1=install_usbipd，2=add_adb_path。
  // ⚠️ 调整或新增 [Tasks] 条目时必须同步这里的索引。CurPageChanged 里以前写的是
  //    Items.Count - 1（取“最后一项”），那只在 install_usbipd 恰好是最后一项时成立；
  //    2026-09 追加 add_adb_path 后它就指到了 ADB 的 PATH 任务上 —— 结果是未装 usbipd
  //    时自动勾选勾错了对象，usbipd 反而永远不被勾选。
  TaskIndexInstallUsbipd = 1;

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
    // 显式索引，别再用 Items.Count - 1（见 TaskIndexInstallUsbipd 的说明）
    WizardForm.TasksList.CheckItem(TaskIndexInstallUsbipd, coCheckWithChildren);
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

/// 把字符串安全地嵌入 PowerShell 单引号字符串（内部单引号翻倍）。
/// 安装目录允许包含单引号，直接拼接会生成语法错误的脚本。
function PsQuote(const S: String): String;
var
  T: String;
begin
  T := S;
  // StringChangeEx 是就地修改：把每个单引号翻倍，再整体套上单引号
  StringChangeEx(T, '''', '''''', True);
  Result := '''' + T + '''';
end;

/// 以隐藏窗口同步执行一段 PowerShell 脚本；失败只写日志，不阻断安装/卸载流程。
/// 用 -NoProfile：不加载用户 profile，避免慢或报错的 profile 拖累安装。
procedure RunPowerShellHidden(const ScriptText, ScriptName, What: String);
var
  PsPath: String;
  ResultCode: Integer;
begin
  PsPath := ExpandConstant('{tmp}\') + ScriptName;
  if not SaveStringToFile(PsPath, ScriptText, False) then begin
    Log(What + ': 写入临时脚本失败 ' + PsPath);
    Exit;
  end;
  if not Exec('powershell', '-NoProfile -ExecutionPolicy Bypass -NonInteractive -File "' + PsPath + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log(What + ': 无法启动 PowerShell')
  else if ResultCode <> 0 then
    Log(What + ': PowerShell 退出码 ' + IntToStr(ResultCode));
end;

/// 停掉本应用自带的常驻 ADB 服务器。
///
/// 为什么必须有这段：adb 启动的服务器是**常驻后台进程**（应用退出后依然活着，直到
/// `adb kill-server` 或注销登录），并且它把 {app}\platform-tools 下的 adb.exe、
/// AdbWinApi.dll、AdbWinUsbApi.dll 全部映射住 —— 运行中的 .exe 无法就地覆写，
/// 已加载的 DLL 连删除都不允许。于是「重复安装 / 升级」必然撞出一连串失败：
///   ① 新版安装包要覆写这三个文件 → Inno 重试 4 次后弹「尝试复制下列文件时出错」；
///   ② 同 AppId 升级会先跑旧版卸载器，它要删掉整个 {app} → 同样删不掉，留下残骸；
///   ③ 卸载后 platform-tools 删不干净。
/// 只结束**镜像路径位于本应用 platform-tools 下**的 adb，避免误伤 Android Studio /
/// 独立 platform-tools 等其它来源的 adb 服务器。
procedure StopAdbServer;
var
  Ps: String;
begin
  Ps :=
    '$root = ' + PsQuote(ExpandConstant('{app}\platform-tools')) + #13#10 +
    '$root = $root.TrimEnd(''\'')' + #13#10 +
    'Get-Process -Name adb -ErrorAction SilentlyContinue | ForEach-Object {' + #13#10 +
    '  $p = $null' + #13#10 +
    '  try { $p = $_.Path } catch { }' + #13#10 +
    '  if ($p -and ($p.TrimEnd(''\'')).ToLower().StartsWith($root.ToLower())) {' + #13#10 +
    '    try {' + #13#10 +
    '      Stop-Process -Id $_.Id -Force -ErrorAction Stop' + #13#10 +
    '      Write-Host ("[SeaHi] stopped adb: " + $p)' + #13#10 +
    '    } catch {' + #13#10 +
    '      Write-Host ("[SeaHi] cannot stop adb: " + $_.Exception.Message)' + #13#10 +
    '    }' + #13#10 +
    '  }' + #13#10 +
    '}';
  RunPowerShellHidden(Ps, 'seahi_stop_adb.ps1', 'StopAdbServer');
end;

/// 修改系统 PATH（安全）：add=追加 entry、remove=移除 entry，均保留 REG_EXPAND_SZ（含 %SystemRoot% 等表达式）。
/// 比较时去掉末尾反斜杠（PowerShell 的 -eq 对字符串不区分大小写），
/// 避免「同一目录两种写法」在重复安装后堆出多条 PATH。
procedure ModifyPathEntry(const Op, Entry: String);
var
  Ps: String;
begin
  Ps :=
    '$entry=' + PsQuote(Entry) + #13#10 +
    '$entry=$entry.Trim().TrimEnd(''\'')' + #13#10 +
    '$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(''SYSTEM\CurrentControlSet\Control\Session Manager\Environment'', $true)' + #13#10 +
    'if($k){' + #13#10 +
    '  $raw=$k.GetValue(''Path'','''',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)' + #13#10 +
    '  if($raw -is [string]){' + #13#10 +
    '    $parts=$raw -split '';''' + #13#10 +
    '    $parts=@($parts | Where-Object { $_.Trim() -ne '''' } | ForEach-Object { $_.Trim() })' + #13#10 +
    '    if(' + PsQuote(Op) + ' -eq ''add''){' + #13#10 +
    '      if(-not ($parts | Where-Object { $_.TrimEnd(''\'') -eq $entry })){' + #13#10 +
    '        $parts += $entry' + #13#10 +
    '        $k.SetValue(''Path'', ($parts -join '';''), [Microsoft.Win32.RegistryValueKind]::ExpandString)' + #13#10 +
    '      }' + #13#10 +
    '    } else {' + #13#10 +
    '      $before=$parts.Count' + #13#10 +
    '      $parts=@($parts | Where-Object { $_.TrimEnd(''\'') -ne $entry })' + #13#10 +
    '      if($parts.Count -ne $before){' + #13#10 +
    '        $k.SetValue(''Path'', ($parts -join '';''), [Microsoft.Win32.RegistryValueKind]::ExpandString)' + #13#10 +
    '      }' + #13#10 +
    '    }' + #13#10 +
    '  }' + #13#10 +
    '  $k.Close()' + #13#10 +
    '}';
  RunPowerShellHidden(Ps, 'adb_path.ps1', 'ModifyPathEntry(' + Op + ')');
end;

procedure AddAdbToPath;
begin
  ModifyPathEntry('add', ExpandConstant('{app}\platform-tools'));
end;

procedure RemoveAdbFromPath;
begin
  ModifyPathEntry('remove', ExpandConstant('{app}\platform-tools'));
end;

/// PrepareToInstall: 官方文档指定的「关掉即将被更新的应用」时机，且早于
/// CloseApplications 的占用检查（也早于旧版卸载器）—— 必须在这里先停掉常驻 adb，
/// 否则同 AppId 升级时旧版卸载器删 {app} 就会失败。
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopAdbServer;
end;

/// CurStepChanged: 在安装阶段执行 usbipd 安装、PATH 追加
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then begin
    // 双保险：旧版卸载器在进入 ssInstall 之前已跑过，若它删 platform-tools 时把 adb
    // 又带起来了（或被别的会话拉起），这里再停一次，确保 [Files] 覆写不会撞锁。
    StopAdbServer;

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

/// CurUninstallStepChanged: 卸载时先停掉常驻 adb（否则 platform-tools 下的三个文件
/// 删不掉、留下残骸），再移除 ADB 的 PATH 条目
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    StopAdbServer;
    RemoveAdbFromPath;
  end;
end;

[Run]
; 安装完成后可选运行
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 卸载时删除配置文件
Type: filesandordirs; Name: "{app}"
