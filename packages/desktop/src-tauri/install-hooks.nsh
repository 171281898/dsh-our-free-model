; OFM 安装器自定义钩子
; 安装前后检测 Node.js 运行时

!macro NSIS_HOOK_PREINSTALL
  ; 检测 Node.js 是否已安装
  ReadRegStr $0 HKLM "SOFTWARE\Node.js" "InstallPath"
  StrCmp $0 "" 0 node_found
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Node.js" "InstallPath"
    StrCmp $0 "" 0 node_found
      IfFileExists "$PROFILE\nodejs\node.exe" node_found
        MessageBox MB_YESNO|MB_ICONQUESTION "Node.js not found. Our Free Model Desktop requires Node.js to run. Open download page?" IDYES open_node IDNO skip_node
        open_node:
          ExecShell "open" "https://nodejs.org/"
        skip_node:
  node_found:

  ; 清理旧进程
  nsExec::ExecToStack 'taskkill /F /IM ofm-desktop.exe 2>nul'
  Pop $0
  Pop $1

  ; 清理锁文件
  Delete "$PROFILE\.our-free-model\service.lock"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 安装后：创建数据目录
  CreateDirectory "$PROFILE\.our-free-model"

  ; 写入初始配置（如果不存在）
  IfFileExists "$PROFILE\.our-free-model\settings.json" +4
    FileOpen $0 "$PROFILE\.our-free-model\settings.json" w
    FileWrite $0 '{}'
    FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载前：停止服务和桌面应用
  nsExec::ExecToStack 'taskkill /F /IM ofm-desktop.exe 2>nul'
  Pop $0
  Pop $1
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载后：清理残留
  Delete "$PROFILE\.our-free-model\service.lock"
!macroend
