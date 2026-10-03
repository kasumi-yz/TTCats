/** 主进程的系统状态查询；鼠标左键指系统设置中的主按钮。 */
export interface Platform {
  /** 系统查询失败会抛错，调用方必须捕获，避免轮询回调出现未处理异常。 */
  isFullscreen(): boolean;
  isCtrlDown(): boolean;
  isLeftButtonDown(): boolean;
}

/** 诊断导出用的系统信息（D13）。用户目录和用户名只用来在导出时替换掉，不写进压缩包。 */
export interface SystemInfo {
  home: string;
  username: string;
  os: { version: string; release: string; arch: string };
  cpu: { model: string | null; cores: number };
  memory: { totalBytes: number; freeBytes: number };
}
