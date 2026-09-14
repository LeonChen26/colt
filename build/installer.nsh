; Colt NSIS 自定义脚本：安装前检测历史安装
; electron-builder 会在标准 NSIS 模板中通过 !include 引入此文件。
; 可用的内置宏（由 electron-builder 注入）：
;   UNINSTALL_REGISTRY_KEY  卸载信息注册表键（SHELL_CONTEXT 下）
;   UNINSTALL_APP_KEY       用于检测「是否已安装」的键
;   SHELL_CONTEXT           随 perMachine 自动取 HKLM / HKCU

; 安装开始前触发：检查是否已存在历史安装
!macro customInit
  ; 用 UninstallString 是否为空判断本机（当前 SHELL_CONTEXT 范围）是否装过 Colt
  ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $R0 "" customInitDone

  ; 读取已安装版本号，便于提示升级
  ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"

  MessageBox MB_OKCANCEL|MB_ICONQUESTION \
    "检测到 Colt 已在本机安装（版本：$R1）。$\r$\n$\r$\n点击「确定」将覆盖安装并保留原有工作台数据；$\r$\n点击「取消」将先卸载旧版本，再继续安装。" \
    IDOK customInitKeepData IDCANCEL customInitUninstall

  customInitKeepData:
    ; 覆盖安装：保留历史数据，直接继续
    Goto customInitDone

  customInitUninstall:
    ; 先静默卸载旧版本，再继续安装（$R0 即前面读到的 UninstallString）
    ExecWait '$R0 /S _?=$INSTDIR'
    Goto customInitDone

  customInitDone:
!macroend
