; AI Work OS Windows native-host helper — development setup candidate.
; This definition intentionally omits all execution, registry, code, task, icon, and deletion sections.
; Installation only copies the helper and provides an uninstaller.

#ifndef AppVersion
  #error AppVersion must be provided by the controlled packaging script.
#endif
#ifndef SourceBinary
  #error SourceBinary must be provided by the controlled packaging script.
#endif
#ifndef OutputDirectory
  #error OutputDirectory must be provided by the controlled packaging script.
#endif
#ifndef OutputBaseName
  #error OutputBaseName must be provided by the controlled packaging script.
#endif

[Setup]
AppId={{D6B7CB44-4E13-4B2D-9B50-CCF88AFA74A6}
AppName=AI Work OS Native Host Helper
AppVersion={#AppVersion}
AppPublisher=AI Work OS Development
DefaultDirName={localappdata}\Programs\AI Work OS\Native Host Helper
DisableProgramGroupPage=yes
AllowNoIcons=yes
Uninstallable=yes
CreateUninstallRegKey=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
RestartIfNeededByRun=no
OutputDir={#OutputDirectory}
OutputBaseFilename={#OutputBaseName}
Compression=lzma2/ultra64
SolidCompression=yes

[Files]
Source: "{#SourceBinary}"; DestDir: "{app}"; Flags: ignoreversion
