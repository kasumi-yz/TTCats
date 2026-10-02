import type { Display } from 'electron';
import type { DisplayInfo } from '../../shared/display';

/** 一块显示器：面板看到的信息，加上摆放桌面层要用的工作区。 */
export interface OverlayDisplay extends DisplayInfo {
  workArea: Display['workArea'];
}

/** 现在接着的全部显示器（Electron 的 screen.getAllDisplays() 换成共享接口的样子）。 */
export function listDisplays(all: readonly Display[], primaryId: number): OverlayDisplay[] {
  return all.map((display) => toOverlayDisplay(display, primaryId));
}

export function toOverlayDisplay(display: Display, primaryId: number): OverlayDisplay {
  return {
    id: display.id,
    label: display.label,
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
    scaleFactor: display.scaleFactor,
    primary: display.id === primaryId,
    workArea: display.workArea,
  };
}

/** 只给面板看的部分，不带工作区。 */
export function displayInfo(display: OverlayDisplay): DisplayInfo {
  const { id, label, width, height, scaleFactor, primary } = display;
  return { id, label, width, height, scaleFactor, primary };
}
