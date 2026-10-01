/** 主进程的系统状态查询；鼠标左键指系统设置中的主按钮。 */
export interface Platform {
  /** 系统查询失败会抛错，调用方必须捕获，避免轮询回调出现未处理异常。 */
  isFullscreen(): boolean;
  isCtrlDown(): boolean;
  isLeftButtonDown(): boolean;
}
