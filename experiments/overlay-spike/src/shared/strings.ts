// 小样里所有给人看的界面文字（托盘菜单、调试信息、猫头顶的标签）集中放在这里。
// 测试脚本的命令行输出和报错不算界面文字，留在各自的脚本里。

import type { InterruptMode } from './protocol';

export const INTERRUPT_MODE_LABEL: Record<InterruptMode, string> = {
  crossfade: '交叉淡化（150ms）',
  hardcut: '硬切 + 小特效',
  transition: '专门的过渡片段',
};

export const UI = {
  appName: 'TTCats 桌面层小样',
  menu: {
    interruptMode: (mode: InterruptMode) => `衔接方式：${INTERRUPT_MODE_LABEL[mode]}`,
    interruptAll: '打断全部猫',
    showInCapture: '截图里显示猫',
    hideAll: '隐藏全部猫',
    showHud: '显示调试信息',
    quit: '退出',
  },
  hud: {
    title: (layout: string, ghost: boolean, fps: number) =>
      `${UI.appName}  布局=${layout}  幽灵=${ghost ? '开' : '关'}  FPS=${fps.toFixed(0)}`,
    modes: (modes: InterruptMode[]) => `衔接方式：${modes.map((m) => INTERRUPT_MODE_LABEL[m]).join(' / ')}`,
    fullness: (wall: number, naive: number) =>
      `饱腹（主进程按真实时间）=${wall.toFixed(2)}   按计时器次数累加=${naive.toFixed(2)}`,
    switches: (count: number, avgMs: number, maxMs: number) =>
      `片段切换 ${count} 次，首帧平均 ${avgMs.toFixed(1)}ms，最大 ${maxMs.toFixed(1)}ms`,
  },
};
