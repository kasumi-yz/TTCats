; 即使用户主动以管理员身份启动安装器，也只能安装到当前用户。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  ; 覆盖安装和自动更新会调用旧版卸载程序，不能弹窗或删除数据。
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "要不要同时删除存档和日志（$APPDATA\TTCats）？$\r$\n选“否”保留数据，下次安装后可以继续使用。" IDNO keepData
    RMDir /r "$APPDATA\TTCats"
    IfFileExists "$APPDATA\TTCats" 0 keepData
      MessageBox MB_OK|MB_ICONEXCLAMATION "存档和日志未能完全删除，请关闭使用这些文件的程序后再检查 $APPDATA\TTCats。"
    keepData:
  ${EndIf}
!macroend
