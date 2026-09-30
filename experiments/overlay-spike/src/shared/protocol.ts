// 主进程、渲染进程、测试脚本之间共用的类型。

/** 片段被打断时的衔接方式 */
export type InterruptMode = 'crossfade' | 'hardcut' | 'transition';
export const INTERRUPT_MODES: InterruptMode[] = ['crossfade', 'hardcut', 'transition'];
export const INTERRUPT_MODE_LABEL: Record<InterruptMode, string> = {
  crossfade: '交叉淡化（150ms）',
  hardcut: '硬切 + 小特效',
  transition: '专门的过渡片段',
};

export type GpuPower = 'low-power' | 'high-performance' | 'default';

/** all = 每只猫把所有片段都预加载好；lazy = 只保留正在播和接下来要播的片段 */
export type Preload = 'all' | 'lazy';

export type Layout = 'normal' | 'test' | 'demo';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 渲染进程上报的每只猫的几何信息（坐标都是桌面层窗口内的 DIP） */
export interface CatInfo {
  id: string;
  mode: InterruptMode;
  clip: string;
  frame: number;
  foot: Point;
  scale: number;
  z: number;
  alpha: number;
  dragging: boolean;
  bbox: Rect;
  /** 当前片段所有帧都不透明的点（猫身上） */
  core: Point | null;
  /** 猫的包围框内、所有帧都透明的点（比如两条腿之间） */
  gap: Point | null;
  /** 猫身上、而且不被其他猫盖住的点 */
  exclusive: Point | null;
  /** 这只猫和另一只猫都不透明的点（用来测重叠时谁接住点击） */
  shared: { with: string; point: Point } | null;
}

export interface CatPlacement {
  id: string;
  x: number;
  y: number;
  scale?: number;
  z?: number;
}

/** 片段切换的统计：从发出切换到新片段第一帧呈现（requestVideoFrameCallback）的耗时 */
export interface SwitchStats {
  count: number;
  avgMs: number;
  maxMs: number;
  interruptLatencyAvgMs: Record<InterruptMode, number | null>;
}

/** 渲染进程看到的鼠标情况（调试用） */
export interface MouseDebug {
  moves: number;
  x: number;
  y: number;
  inside: boolean;
  hover: boolean;
}

export interface HiddenReport {
  hiddenMs: number;
  intervalTicks: number;
  expectedIntervalTicks: number;
  rafTicks: number;
  rvfcTicks: number;
  /** 按计时器次数累加（每次 setInterval(1s) 减 1/60） */
  naiveFullnessDrop: number;
  /** 按帧数累加（每帧按 1/60 秒算） */
  naiveFrameFullnessDrop: number;
  wallFullnessDrop: number;
}

/** 渲染进程 → 主进程 */
export interface RendererToMain {
  hover: boolean;
  drag: boolean;
  cats: { cats: CatInfo[]; switchStats: SwitchStats; mouse: MouseDebug };
  event: { type: string; [k: string]: unknown };
  hiddenReport: HiddenReport;
}

/** 主进程 → 渲染进程 */
export interface MainToRenderer {
  config: { layout: Layout; mode: InterruptMode; hud: boolean; power: GpuPower; preload: Preload; fps: number; res: number };
  ghost: boolean;
  paused: boolean;
  dragCancel: true;
  snapshot: { fullness: number; wallMs: number };
  cmd: { type: string; [k: string]: unknown };
}

export interface OverlayState {
  pid: number;
  hwnd: number;
  ignoring: boolean;
  dragging: boolean;
  ghost: boolean;
  ctrlDown: boolean;
  protection: boolean;
  userHidden: boolean;
  fullscreenHidden: boolean;
  notificationState: number;
  visible: boolean;
  scaleFactor: number;
  workArea: Rect;
  exStyle: number;
  cats: CatInfo[];
  switchStats: SwitchStats | null;
  mouse: MouseDebug | null;
  fullness: number;
  seq: number;
}

export interface LogEvent {
  seq: number;
  t: number;
  type: string;
  [k: string]: unknown;
}
