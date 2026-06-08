; SeaHi Serial - Inno Setup 安装脚本
; 使用 Inno Setup Compiler (ISCC) 编译此脚本生成安装程序

#define MyAppName "Seahi Serial"
#define MyAppVersion "0.1.1"
#define MyAppPublisher "SeaHi"
#define MyAppExeName "seahi-serial.exe"
#define MyAppDescription "串口调试器 - Tauri 2 桌面应用"

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

; 权限 - 串口需要管理员权限才能访问
PrivilegesRequired=admin

[Languages]
Name: "chinese_simplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"

[Files]
; 主程序 - 使用 Tauri 内嵌的 WebView2，无需额外 DLL
Source: "src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; 开始菜单快捷方式
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
; 桌面快捷方式
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 安装完成后可选运行
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 卸载时删除配置文件
Type: filesandordirs; Name: "{app}"
