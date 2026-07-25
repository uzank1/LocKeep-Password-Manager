!macro customInit
  StrCpy $0 "$TEMP\LocKeepPasswordManager-upgrade-backup"
  RMDir /r "$0"

  IfFileExists "$APPDATA\LocKeepPasswordManager\vault.dat" 0 +3
    CreateDirectory "$0"
    CopyFiles /SILENT "$APPDATA\LocKeepPasswordManager\vault.dat" "$0\vault.dat"

  IfFileExists "$APPDATA\LocKeepPasswordManager\settings.json" 0 +3
    CreateDirectory "$0"
    CopyFiles /SILENT "$APPDATA\LocKeepPasswordManager\settings.json" "$0\settings.json"
!macroend

!macro customInstall
  StrCpy $0 "$TEMP\LocKeepPasswordManager-upgrade-backup"

  IfFileExists "$0\vault.dat" 0 +4
    CreateDirectory "$APPDATA\LocKeepPasswordManager"
    IfFileExists "$APPDATA\LocKeepPasswordManager\vault.dat" +2 0
      CopyFiles /SILENT "$0\vault.dat" "$APPDATA\LocKeepPasswordManager\vault.dat"

  IfFileExists "$0\settings.json" 0 +4
    CreateDirectory "$APPDATA\LocKeepPasswordManager"
    IfFileExists "$APPDATA\LocKeepPasswordManager\settings.json" +2 0
      CopyFiles /SILENT "$0\settings.json" "$APPDATA\LocKeepPasswordManager\settings.json"

  RMDir /r "$0"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LocKeepPasswordManager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "LocKeepPasswordManager"
!macroend
