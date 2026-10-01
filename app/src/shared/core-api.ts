// core/game 和 core/stage 对外的接口，只有类型，没有实现。M1 定稿（#18）。
// 两者都是纯 TypeScript（硬性规则 1）：不读系统时钟、不碰文件和窗口，
// 时间、内容、屏幕大小、随机数都由调用方传进来，所以可以直接做单元测试。
import type { Fact, GameCommand, StageCommand, StageDebugReport, StateSnapshot } from './ipc';
import type { Cat, Clip, GameState, Pose } from './schemas';

/** 已经通过校验、可以使用的全部内容。主进程加载，通过 IPC 发给桌面层和面板。 */
export interface ContentCatalog {
  /** 加载成功的猫，键是猫 id。 */
  cats: Record<string, { cat: Cat; clips: Clip[] }>;
  /** 被整只停用的猫咪包，以及中文原因（说清楚是哪只猫、缺了什么）。给调试台和安全模式看。 */
  disabled: { cat: string; problems: string[] }[];
}

// ============================================================
// core/game：在主进程里运行，是需要存档的状态的唯一管理者（ADR-0004）
// ============================================================

/** core/game 处理完一条输入后的结果。 */
export interface GameOutput {
  /** 需要发给桌面层的命令。 */
  stageCommands: StageCommand[];
  /** 状态是否变了。变了就要存档，并推送新快照。 */
  stateChanged: boolean;
  /** 命令被拒绝时的中文原因。被拒绝的命令不改变状态。 */
  problems: string[];
}

export interface GameCore {
  handleCommand(command: GameCommand, now: number): GameOutput;
  handleFact(fact: Fact, now: number): GameOutput;
  /** 生成要推送的快照。每调用一次 revision 加 1。 */
  snapshot(now: number): StateSnapshot;
  /** 导出当前状态用于存档。 */
  exportState(): GameState;
}

export type CreateGameCore = (options: {
  content: ContentCatalog;
  /** 读到的存档（已经迁移到当前版本并校验过）；第一次运行时不传，用默认状态。 */
  state?: GameState;
  now: number;
}) => GameCore;

// ============================================================
// core/stage：在桌面层里运行，管理可以随时丢弃的画面状态
// ============================================================

/** 桌面层的大小，单位是 CSS 像素。 */
export interface StageBounds {
  width: number;
  height: number;
}

/**
 * 桌面层收到的鼠标左键输入，坐标是桌面层里的 CSS 像素。
 * cat 是桌面层按点击遮罩判断出来的、鼠标下面最靠前的那只猫；不在任何猫身上时是 null。
 * 右键由桌面层直接请主进程弹菜单（OverlayToMain 的 catMenu），不经过 core/stage。
 * 鼠标不在猫身上时，桌面层仍然能收到移动（setIgnoreMouseEvents 的 forward），用来判断鼠标靠近和撸猫。
 */
export type PointerInput =
  | { type: 'move'; x: number; y: number; cat: string | null }
  | { type: 'down'; x: number; y: number; cat: string | null }
  | { type: 'up'; x: number; y: number }
  /** 主进程发现左键已经松开、却没收到 up（MainToOverlay 的 dragCancel）：当作在最后的位置松手。 */
  | { type: 'cancel' };

/** 一只猫这一帧该怎么画。 */
export interface CatPlacement {
  cat: string;
  clip: string;
  variant: number;
  /**
   * 当前片段已经播放了多久（毫秒，按真实时间，已经算上了播放速度）。
   * 渲染层让视频自己播放，只在和这个值相差超过一帧时才校正，不需要每帧跳转。
   */
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

/**
 * 特效：
 * - hearts：撸猫时身边冒出的爱心
 * - cut：用户触发的打断立刻切换片段时，盖住切换处的小特效（ADR-0002）
 */
export type StageEffect = 'hearts' | 'cut';

export interface StageFrame {
  cats: CatPlacement[];
  /** 气泡，显示在猫的头顶。ageMs 是已经显示了多久，渲染层用它做淡入淡出。 */
  bubbles: { cat: string; text: string; ageMs: number }[];
  /** 特效。id 在特效的整个生命期里不变，渲染层用它对应到同一个动画。 */
  effects: { id: number; effect: StageEffect; x: number; y: number; ageMs: number }[];
}

export interface StageCore {
  /** 收到主进程推送的新快照（比如设置变了、某只猫被隐藏了）。 */
  applySnapshot(snapshot: StateSnapshot, now: number): void;
  handleCommand(command: StageCommand, now: number): void;
  handlePointer(input: PointerInput, now: number): void;
  /**
   * 幽灵模式开始或结束（主进程已经算上了松开 Ctrl 后保持的 2 秒）。
   * 幽灵模式下猫不响应新的互动；已经拎起来的猫不会被扔下（ADR-0003）。
   */
  setGhostMode(active: boolean, now: number): void;
  /** 桌面层大小变了（比如分辨率、缩放、任务栏位置变了）。 */
  setBounds(bounds: StageBounds, now: number): void;
  /** 每帧调用。按真实经过的时间推进，不按帧数累加（ADR-0004）。 */
  update(now: number): StageFrame;
  /** 取出这段时间里发生的事实，交给主进程。 */
  drainFacts(): Fact[];
  /** 当前的画面状态，给调试台看。 */
  debugReport(now: number): StageDebugReport;
}

export type CreateStageCore = (options: {
  content: ContentCatalog;
  snapshot: StateSnapshot;
  bounds: StageBounds;
  now: number;
  /** 随机数来源，返回 [0, 1)。测试时可以传固定序列。 */
  random: () => number;
}) => StageCore;
