// core/game 和 core/stage 对外的接口，只有类型和几个共用的常数，没有实现。M1 定稿（#18），M2 新增（#52）。
// 两者都是纯 TypeScript（硬性规则 1）：不读系统时钟和时区、不碰文件和窗口，
// 时间、时区、内容、屏幕大小、随机数都由调用方传进来，所以可以直接做单元测试。
import type { Fact, GameCommand, StageCommand, StageDebugReport, StateSnapshot } from './ipc';
import type { Cat, CatSound, Clip, GameState, Pose } from './schemas';

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
  /** 需要发给桌面层的命令，按顺序发。 */
  stageCommands: StageCommand[];
  /** 需要存档的状态（GameState）变了：要存档。为 true 时 snapshotChanged 也一定为 true。 */
  stateChanged: boolean;
  /**
   * 快照的内容变了：要推送新快照（M2）。包括不存档的部分，比如一键隐藏、该不该出声、时钟偏移。
   * 只有它为 true、stateChanged 为 false 时不用存档，免得重复的备份把有用的旧备份挤掉。
   */
  snapshotChanged: boolean;
  /** 命令被拒绝时的中文原因。被拒绝的命令不改变状态。 */
  problems: string[];
}

/**
 * 开机自动启动后静默多久（D10，2026-10-02 用户决定：只管开机后猫入场的那一段，约 1 分钟）。
 * 这段时间不出声；之后照常出声，安静时段和勿扰照样起作用。
 */
export const STARTUP_QUIET_MS = 60_000;

/**
 * 调试台的快进（GameCommand 的 debug/advanceClock）：core/game 看到的时间 = 调用方传进来的 now + 快进的偏移。
 * 偏移由 core/game 自己记，不存档，重启（重新创建 GameCore）后清零；当前值放在快照的 clockOffsetMs 里。
 * - 安静时段、开机静默按 core/game 看到的时间判断。
 * - 勿扰的剩余时间也跟着快进减少，但对外（exportState、快照）的结束时刻 `doNotDisturb.until` 一律是**真实时间**：
 *   每快进 d，没到期的勿扰 until 提前 d。这样存进存档的 until 不带偏移，重启后剩余时间不变（#75 审查）。
 *   比如先快进 7 天、再开 30 分钟勿扰，存档里的 until 是真实时间 + 30 分钟，重启后还剩 30 分钟，不是 7 天多。
 *   #58 要用单元测试覆盖："快进后开始勿扰 → 导出 → 重建"和"开着勿扰 → 快进一部分 → 导出 → 重建"，剩余时间都不变。
 */
export interface GameCore {
  handleCommand(command: GameCommand, now: number): GameOutput;
  handleFact(fact: Fact, now: number): GameOutput;
  /**
   * 按真实时间推进（M2）。主进程大约每秒调用一次（勿扰到点要准时，进出安静时段允许几十秒误差）。
   * 勿扰到点结束：stateChanged 和 snapshotChanged 都为 true；进出安静时段、开机静默结束：snapshotChanged 为 true。
   * now 可以比上一次小（用户改了系统时间）或者大很多（系统睡眠），都要合理处理，比如结束时间已经过了就结束。
   */
  tick(now: number): GameOutput;
  /** 生成要推送的快照。每调用一次 revision 加 1。 */
  snapshot(now: number): StateSnapshot;
  /** 导出当前状态用于存档。里面的时刻都是真实时间，不带快进的偏移。 */
  exportState(): GameState;
}

export type CreateGameCore = (options: {
  content: ContentCatalog;
  /**
   * 读到的存档（已经迁移到当前版本并校验过）；第一次运行时不传，用默认状态。
   * 新建的 GameCore 没有快进偏移，存档里的真实时间直接就是它看到的时间。
   */
  state?: GameState;
  now: number;
  /**
   * 时刻 at（core/game 看到的时间）的本地时间比 UTC 快多少分钟，比如北京时间返回 480（M2）。
   * 安静时段按本地时间算，core/game 自己不读时区（硬性规则 1、6）。主进程传 `(at) => -new Date(at).getTimezoneOffset()`。
   * 传函数而不是一个数：夏令时会让偏移随日期变化，快进时钟后也要按快进后的日期算。
   */
  utcOffsetMinutes: (at: number) => number;
  /**
   * 这次是开机自动启动的（M2，#67）：从 now 起 STARTUP_QUIET_MS 内不出声。
   * 主进程看启动参数决定；桌面层崩溃后重新加载不重新创建 GameCore，不会再静默一次。
   */
  startupQuiet?: boolean;
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
  | { type: 'cancel' }
  /**
   * 鼠标穿过桌面层的左键按下（MainToOverlay 的 clickThrough，M2 #60）。点击已经落到下面的窗口了，
   * 这里只用来判断"在猫旁边连续点击"（D10）：点得够多，猫自己走开。cat 是桌面层按点击遮罩判断出来的、
   * 点击位置下面最靠前的那只猫（幽灵模式下可能点在猫身上），不在任何猫身上时是 null。
   */
  | { type: 'clickThrough'; x: number; y: number; cat: string | null };

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

/**
 * 声音提示（M2，D11）：让桌面层开始或停止播放某只猫的声音。桌面层按设置（开关、音量）和快照的
 * silencedBy 决定真的播不播；不该出声时不开始新的，正在播的停掉（呼噜淡出）。
 *
 * 什么时候发（片段和声音的对应见 clip.ts 的 CLIP_SOUNDS）：
 * - 喵叫：播放 meow（叫一声）片段、播到片段元数据 soundStartFrame 那一帧时发 start（没写就是片段开头）。
 *   猫的反应本该播叫一声片段、但这只猫没有可用的片段，只冒了气泡时，冒气泡的同时发 start。
 *   喵叫只播一遍，不发 stop。
 * - 呼噜：purr（被撸时呼噜）片段第一次播到 soundStartFrame 那一帧时发 start（没写就是开头），
 *   片段循环播放时不再发；切到别的片段时发 stop。桌面层在 start 和 stop 之间循环播放，怎么淡出由桌面层定。
 * - 调试台的 debug/sound：喵叫发一次 start；呼噜发 start，响几秒后发 stop。
 * - file 从这只猫 cat.json 的 sounds 里对应那一类随机挑一个；那一类一个文件都没有时不发提示。
 * - 猫出场、被隐藏、被移除时不发 stop，桌面层看到它不在 StageFrame.cats 里了就自己停掉它的声音。
 */
export type SoundCue =
  | {
      cat: string;
      sound: CatSound;
      action: 'start';
      /** 猫咪包里的路径（cat.json 的 sounds 里的一项），桌面层用 ttcats-content:// 地址读取。 */
      file: string;
    }
  | { cat: string; sound: CatSound; action: 'stop' };

export interface StageFrame {
  cats: CatPlacement[];
  /** 气泡，显示在猫的头顶。ageMs 是已经显示了多久，渲染层用它做淡入淡出。 */
  bubbles: { cat: string; text: string; ageMs: number }[];
  /** 特效。id 在特效的整个生命期里不变，渲染层用它对应到同一个动画。 */
  effects: { id: number; effect: StageEffect; x: number; y: number; ageMs: number }[];
  /**
   * 上一次 update 以后新产生的声音提示，按发生的先后排列，每条只出现一次（M2）。
   * 产生时刻离这次 update 的 now 超过 1 秒的 start 直接丢掉（比如桌面层暂停绘制以后恢复），不补播；stop 不丢。
   */
  sounds: SoundCue[];
}

/**
 * M2 新增的画面行为（#59），都由 core/stage 自己安排，不需要新的方法：
 * - 入场（Entrance）：创建 StageCore 时（程序启动、桌面层重新加载），显示中的猫从屏幕外依次走进来，
 *   按性格参数的活跃从高到低（2026-10-02 用户决定），一样时按 visibleCats 里的顺序。不按名字写死（ADR-0005）。
 *   收到 StageCommand 的 cat/entrance 时，全部显示中的猫再从屏幕外重新入场。
 * - 出场（Exit）/ 显示：快照里 visibleCats 去掉某只猫，它走到最近的屏幕边走出去，出去以后再移除；
 *   加上某只猫，它从屏幕边走进来。
 * - 勿扰模式：快照里 doNotDisturb.mode 不是 off 时，猫都聚到地板的一个角落睡觉，不做自主行为；
 *   点、撸、拎、召唤照常有效，结束后回到角落继续睡。
 * 一键隐藏、全屏时桌面层整个暂停绘制，core/stage 不用管；恢复后由 cat/entrance 让猫走回来。
 */
export interface StageCore {
  /** 收到主进程推送的新快照（比如设置变了、某只猫被隐藏了、勿扰模式开始或结束）。 */
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

/** 创建以后，显示中的猫从屏幕外依次入场（见 StageCore 上面的说明）。 */
export type CreateStageCore = (options: {
  content: ContentCatalog;
  snapshot: StateSnapshot;
  bounds: StageBounds;
  now: number;
  /** 随机数来源，返回 [0, 1)。测试时可以传固定序列。 */
  random: () => number;
}) => StageCore;
