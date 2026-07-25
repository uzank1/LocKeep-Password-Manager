!macro customInit
  ${if} ${isUpdated}
    # Updates launched by either the current or an older updater must remain
    # invisible. The --force-run argument still reopens LocKeep afterwards.
    SetSilent silent

    CreateDirectory "$APPDATA\LocKeepPasswordManager"
    FileOpen $1 "$APPDATA\LocKeepPasswordManager\.update-in-progress" w
    FileWrite $1 "installer"
    FileClose $1

    # Prevent an open browser from starting another native messaging host
    # while files are being replaced. LocKeep restores these keys on restart.
    DeleteRegKey HKCU "SOFTWARE\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.sifreyoneticisi.host"
    DeleteRegKey HKCU "SOFTWARE\Google\Chrome\NativeMessagingHosts\com.sifreyoneticisi.host"
    DeleteRegKey HKCU "SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.sifreyoneticisi.host"
    DeleteRegKey HKCU "SOFTWARE\Vivaldi\NativeMessagingHosts\com.sifreyoneticisi.host"
    DeleteRegKey HKCU "SOFTWARE\Opera Software\Opera Stable\NativeMessagingHosts\com.sifreyoneticisi.host"

    # Give electron-updater time to run the normal before-quit cleanup, then
    # close any remaining renderer or native-host process. Browsers stay open.
    Sleep 1500
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $1
    Sleep 300
  ${endif}

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
