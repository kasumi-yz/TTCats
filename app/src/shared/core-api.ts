// 草稿，M0 后定稿。
// core/game 和 core/stage 对外的接口，只有类型，没有实现。
// 两者都是纯 TypeScript（硬性规则 1）：不读系统时钟、不碰文件和窗口，
// 时间、系统状态、内容都由调用方传进来，所以可以直接做单元测试。
import type { Fact, StageCommand, StateSnapshot, ToMainCommand } from './ipc';
import type { Cat, Clip, EventConfig, Pose, Settings } from './schemas';

/** 已经通过校验的全部内容。 */
export interface ContentCatalog {
  cats: Record<string, { cat: Cat; clips: Clip[] }>;
  events: EventConfig[];
}

// ============================================================
// core/game：在主进程里运行，是需要存档的状态的唯一管理者（ADR-0004）
// ============================================================

/**
 * 需要存档的游戏状态。存档本身（版本号、迁移、备份）在 M1 做；
 * 以后阶段要加的字段靠存档迁移再加，这里不预留（硬性规则 8）。
 */
export interface GameState {
  settings: Settings;
  cats: Record<string, { visible: boolean; hiddenAt?: number }>;
  /** 各个事件上次触发的时刻。 */
  eventLastRunAt: Record<string, number>;
  /** 上次启动的本地日期（YYYY-MM-DD），用来判断"当天第一次开机"。 */
  lastLaunchDate?: string;
}

/** 主进程从操作系统读到的情况，由 platform/ 提供，每次 tick 传进来。 */
export interface SystemObservation {
  /** 用户空闲了多久（毫秒）。 */
  idleMs: number;
  /** 前台是否有全屏程序。 */
  fullscreen: boolean;
  /** 本地时区相对 UTC 的偏移（分钟），用来算"今天几点"。 */
  utcOffsetMinutes: number;
}

/** core/game 处理完一条输入后的结果。 */
export interface GameOutput {
  /** 需要发给桌面层的命令。 */
  stageCommands: StageCommand[];
  /** 状态是否变了。变了就要存档，并推送新快照。 */
  stateChanged: boolean;
}

export interface GameCore {
  handleCommand(command: ToMainCommand, now: number): GameOutput;
  handleFact(fact: Fact, now: number): GameOutput;
  /** 定时调用（间隔由主进程决定），用来判断事件触发、用户离开和回来等。 */
  tick(now: number, system: SystemObservation): GameOutput;
  snapshot(now: number): StateSnapshot;
  /** 导出当前状态用于存档。 */
  exportState(): GameState;
}

export type CreateGameCore = (options: {
  content: ContentCatalog;
  /** 读到的存档；第一次运行时不传。 */
  state?: GameState;
  now: number;
}) => GameCore;

// ============================================================
// core/stage：在桌面层里运行，管理可以随时丢弃的画面状态
// ============================================================

/** 桌面层可用的区域，单位是 CSS 像素。 */
export interface StageBounds {
  width: number;
  height: number;
}

/** 桌面层收到的鼠标输入，坐标是桌面层里的 CSS 像素。 */
export type PointerInput =
  | { type: 'move'; x: number; y: number }
  | { type: 'down'; x: number; y: number; button: 'left' | 'right'; cat: string | null }
  | { type: 'up'; x: number; y: number; button: 'left' | 'right' };

/** 一只猫这一帧该怎么画。 */
export interface CatPlacement {
  cat: string;
  clip: string;
  variant: number;
  /** 当前片段已经播放了多久（毫秒），渲染层据此定位视频帧。 */
  clipTimeMs: number;
  /** 当前片段的播放速度，0.9～1.1（D7 防止看腻）。 */
  playbackRate: number;
  /** 落脚锚点在桌面层里的位置。 */
  x: number;
  y: number;
  /** 最终缩放 = 用户设置的缩放 × 相对体型 × 远近缩放。 */
  scale: number;
  mirrored: boolean;
  /** 纵深，越大越靠前，渲染时按它排序。 */
  depth: number;
  /** 当前所处的姿势；片段播到一半时是它的开始姿势。 */
  pose: Pose;
}

export interface StageFrame {
  cats: CatPlacement[];
  bubbles: { cat: string; text: string }[];
  effects: { effect: string; x: number; y: number }[];
}

export interface StageCore {
  applySnapshot(snapshot: StateSnapshot): void;
  handleCommand(command: StageCommand): void;
  handlePointer(input: PointerInput, now: number): void;
  /** 每帧调用。按真实经过的时间推进，不按帧数累加（ADR-0004）。 */
  update(now: number): StageFrame;
  /** 取出这段时间里发生的事实，交给主进程。 */
  drainFacts(): Fact[];
}

export type CreateStageCore = (options: {
  content: ContentCatalog;
  bounds: StageBounds;
  now: number;
  /** 随机数来源，测试时可以传固定序列。 */
  random: () => number;
}) => StageCore;
