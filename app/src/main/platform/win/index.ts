import koffi from 'koffi';
import type { Platform } from '../types';

export function createWindowsPlatform(): Platform {
  const user32 = koffi.load('user32.dll');
  const shell32 = koffi.load('shell32.dll');
  const getAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)') as (
    key: number,
  ) => number;
  const getSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)') as (
    index: number,
  ) => number;
  const queryNotificationState = shell32.func(
    'int __stdcall SHQueryUserNotificationState(_Out_ int *state)',
  ) as (state: number[]) => number;

  return {
    isFullscreen() {
      const state = [0];
      const result = queryNotificationState(state);
      // HRESULT 的负值表示失败，不能把查询失败当作“没有全屏”。
      if (result < 0) {
        throw new Error(`SHQueryUserNotificationState: HRESULT 0x${(result >>> 0).toString(16)}`);
      }
      return state[0] === 2 || state[0] === 3 || state[0] === 4;
    },
    isCtrlDown() {
      // 只读当前按下位；最低位“自上次查询后按过”会被其他进程消耗。
      return (getAsyncKeyState(0x11) & 0x8000) !== 0;
    },
    isLeftButtonDown() {
      // GetAsyncKeyState 读物理按钮，交换左右键时主按钮是物理右键。
      // 每次读取设置，运行中交换按钮也立即生效，避免拖动兜底误判松手。
      const primaryButton = getSystemMetrics(23) !== 0 ? 0x02 : 0x01;
      return (getAsyncKeyState(primaryButton) & 0x8000) !== 0;
    },
  };
}
