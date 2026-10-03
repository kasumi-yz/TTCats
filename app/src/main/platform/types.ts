/** Electron 的屏幕坐标（DIP）。 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** 主进程的系统状态查询；鼠标左键指系统设置中的主按钮。 */
export interface Platform {
  /**
   * 猫所在的显示器上有没有全屏程序（#65）。display 是那块显示器上的任意一点，用 Electron 的屏幕坐标。
   * 别的显示器上的全屏窗口不算；系统不告诉是哪块屏幕的独占全屏和演示模式照旧算。
   * 系统查询失败会抛错，调用方必须捕获，避免轮询回调出现未处理异常。
   */
  isFullscreen(display: ScreenPoint): boolean;
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
