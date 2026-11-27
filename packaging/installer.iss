; Inno Setup script: wraps dist\BingersScrobbler into BingersScrobbler_Setup_<version>.exe
; Build (after PyInstaller):  ISCC.exe /DAppVersion=0.2.0 packaging\installer.iss
; Installs per user (no admin prompt) into %LOCALAPPDATA%\Programs\Bingers Scrobbler.

#define AppName "Bingers Scrobbler"
#define AppExe "BingersScrobbler.exe"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{3422ACF2-E033-49A6-8316-A4B56884AF1F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=scrobbler-for-bingers contributors
AppPublisherURL=https://github.com/siklevis7/scrobbler-for-bingers
AppSupportURL=https://github.com/siklevis7/scrobbler-for-bingers/issues
AppUpdatesURL=https://github.com/siklevis7/scrobbler-for-bingers/releases
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=BingersScrobbler_Setup_{#AppVersion}
SetupIconFile=..\src\bingers_scrobbler\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
LicenseFile=..\LICENSE
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=force

[Tasks]
Name: "autostart"; Description: "Start {#AppName} when I sign in to Windows"; GroupDescription: "Options:"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\BingersScrobbler\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; Same value the app's own "Start with Windows" menu item writes.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "BingersScrobbler"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent
; The app's own updater runs this installer with /SILENT /RELAUNCH=1; start the new version afterwards.
Filename: "{app}\{#AppExe}"; Flags: nowait; Check: ShouldRelaunch

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#AppExe}"; Flags: runhidden; RunOnceId: "StopApp"
Filename: "{sys}\reg.exe"; Parameters: "delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Run"" /v BingersScrobbler /f"; Flags: runhidden; RunOnceId: "RemoveAutostart"
; Settings, token and history in %APPDATA%\bingers-scrobbler are kept, so a reinstall keeps you signed in.

[Code]
function ShouldRelaunch: Boolean;
begin
  Result := WizardSilent and (ExpandConstant('{param:RELAUNCH|0}') = '1');
end;
