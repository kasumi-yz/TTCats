/** 主进程的系统状态查询；鼠标左键指系统设置中的主按钮。 */
export interface Platform {
  isFullscreen(): boolean;
  isCtrlDown(): boolean;
  isLeftButtonDown(): boolean;
}
