// 窗口之间的消息。M1 定稿（#18），只放 M1 用到的；勿扰、事件等到 M2、M3 再加（硬性规则 8）。
//
// 和需要存档的状态有关的消息只有三类（ADR-0004）：
// - 命令（Command）：要求对方做一件事。面板、托盘、右键菜单 → 主进程；主进程 → 桌面层。
// - 事实（Fact）：桌面层告诉主进程"刚才发生了什么"，由主进程决定要不要改存档状态。
// - 状态快照（StateSnapshot）：主进程改完状态后推送给所有窗口。窗口不能自己改需要存档的状态。
//
// 另外还有桌面层的窗口控制消息（OverlayToMain / MainToOverlay）：鼠标穿透、幽灵模式、暂停绘制等。
// 它们只管桌面层这个窗口怎么工作，不碰需要存档的状态（ADR-0003）。
//
// 所有时间都是 Unix 毫秒（真实时间），不按帧数累加（ADR-0004）。
// 所有坐标都是桌面层里的 CSS 像素，原点在桌面层左上角。
import type { ContentCatalog } from './core-api';
import type { Point } from './schemas/common';
import type { Settings } from './schemas/settings';

/** IPC 通道名。 */
export const IPC_CHANNELS = {
  /** 面板、桌面层 → 主进程：ToMainCommand */
  command: 'ttcats:command',
  /** 桌面层 → 主进程：Fact */
  fact: 'ttcats:fact',
  /** 主进程 → 桌面层：StageCommand */
  stageCommand: 'ttcats:stage-command',
  /** 主进程 → 所有窗口：StateSnapshot */
  snapshot: 'ttcats:snapshot',
  /** 窗口 → 主进程（invoke）：要当前的 StateSnapshot。窗口刚打开时用。 */
  getSnapshot: 'ttcats:get-snapshot',
  /** 窗口 → 主进程（invoke）：要已加载的内容 ContentCatalog。 */
  getContent: 'ttcats:get-content',
  /** 桌面层 → 主进程：OverlayToMain */
  overlayToMain: 'ttcats:overlay-to-main',
  /** 主进程 → 桌面层：MainToOverlay */
  mainToOverlay: 'ttcats:main-to-overlay',
  /** 主进程 → 面板：StageDebugReport（桌面层上报的画面状态，转给调试台） */
  stageDebug: 'ttcats:stage-debug',
} as const;

type CatId = string;

// ---------- 命令：发给主进程 ----------

/** 调试台模拟的鼠标互动（硬性规则 5）。 */
export type SimulatedInteraction = 'poke' | 'pet' | 'pickUp' | 'drop';

/** 由 core/game 处理的命令。 */
export type GameCommand =
  /** 改设置。改完的整份设置必须通过 SettingsSchema，否则整条命令被拒绝。 */
  | { type: 'settings/update'; patch: Partial<Settings> }
  /**
   * 召唤（Summon）：不写 cat 表示召唤全部显示中的猫。
   * to 是要走到的位置；不写就走到桌面层最后一次看到鼠标的地方。
   * 托盘和右键菜单由主进程按当时的光标位置填上 to。
   */
  | { type: 'cat/summon'; cat?: CatId; to?: Point }
  /** 显示或隐藏某只猫，改的是 settings.visibleCats。 */
  | { type: 'cat/setVisible'; cat: CatId; visible: boolean }
  | { type: 'cat/sleep'; cat: CatId }
  // 调试台（硬性规则 5：每个功能都必须能在调试台里手动触发）
  | { type: 'debug/playClip'; cat: CatId; clip: string; variant?: number }
  | { type: 'debug/simulate'; cat: CatId; interaction: SimulatedInteraction };

/** 由主进程自己处理、不经过 core/game 的命令。 */
export type MainCommand =
  /** 调试台：让桌面层的渲染进程崩溃，用来测试崩溃恢复和安全模式（D13）。 */
  { type: 'debug/crashOverlay' };

export type ToMainCommand = GameCommand | MainCommand;

// ---------- 命令：主进程发给桌面层 ----------

export type StageCommand =
  /** 让猫走到某个位置。core/game 原样转发 GameCommand 里的 to。 */
  | { type: 'cat/summon'; cats: CatId[]; to?: Point }
  | { type: 'cat/sleep'; cat: CatId }
  | { type: 'debug/playClip'; cat: CatId; clip: string; variant?: number }
  | { type: 'debug/simulate'; cat: CatId; interaction: SimulatedInteraction };

// ---------- 事实：桌面层发给主进程 ----------

export type Fact = { at: number } & (
  | { type: 'cat/petted'; cat: CatId; durationMs: number }
  | { type: 'cat/poked'; cat: CatId }
  | { type: 'cat/pickedUp'; cat: CatId }
  | { type: 'cat/dropped'; cat: CatId }
);

// ---------- 状态快照：主进程推送给所有窗口 ----------

export interface StateSnapshot {
  /** 每推送一次加 1，窗口可以用它丢掉过期的快照。 */
  revision: number;
  /** 生成快照时的真实时间。 */
  at: number;
  settings: Settings;
}

// ---------- 桌面层的窗口控制 ----------

/**
 * 鼠标穿透和幽灵模式用到的时间（ADR-0003，数值来自 M0-A 实测）。主进程和桌面层按同一套数值工作。
 * 防卡死要求：鼠标不在猫身上、也没有在拖动时，200ms 内恢复鼠标穿过。
 */
export const OVERLAY_TIMING = {
  /** 鼠标在猫身上时，桌面层每隔这么久续一次租约。 */
  hoverRenewMs: 50,
  /** 租约的有效期。过期还没续，主进程就恢复鼠标穿过（桌面层卡死也能兜底）。 */
  hoverLeaseMs: 120,
  /** 主进程检查租约、光标位置、左键和 Ctrl 的间隔。 */
  watchdogMs: 20,
  /** 拖动中左键松开超过这么久、桌面层还没报告松手，主进程就当作松手处理。 */
  dragReleaseGraceMs: 60,
  /** 松开 Ctrl 以后，幽灵模式再保持这么久。 */
  ghostHoldMs: 2000,
} as const;

export type OverlayToMain =
  /**
   * 鼠标是不是在猫身上（按点击遮罩判断）。在猫身上时，每 hoverRenewMs 发一次 onCat: true 续租约；
   * 离开时发一次 onCat: false。主进程收到 true、并且确认光标确实在桌面层里，才临时关闭鼠标穿过。
   */
  | { type: 'hover'; onCat: boolean }
  /** 开始或结束拖动（拎起）。拖动期间主进程不恢复鼠标穿过，改为检查左键是否已经松开。 */
  | { type: 'drag'; active: boolean }
  /** 右键点中了某只猫，请主进程在光标处弹出这只猫的右键菜单（D5）。 */
  | { type: 'catMenu'; cat: CatId }
  /** 画面状态，给调试台看。只在主进程发了 stageDebug enabled: true 以后才定时发。 */
  | { type: 'stageDebug'; report: StageDebugReport };

export type MainToOverlay =
  /** 幽灵模式开始或结束（已经算上了松开 Ctrl 后保持的 2 秒）。 */
  | { type: 'ghost'; active: boolean }
  /** 主进程发现左键已经松开，但桌面层没报告松手：当作松手处理（比如 pointerup 丢了）。 */
  | { type: 'dragCancel' }
  /** 桌面层被隐藏（比如前台有全屏程序）时暂停绘制，恢复显示时继续。 */
  | { type: 'paused'; paused: boolean }
  /** 调试台打开或关闭：要不要定时上报画面状态。 */
  | { type: 'stageDebug'; enabled: boolean };

/** 桌面层上报的画面状态。只用于调试台显示，不存档。 */
export interface StageDebugReport {
  at: number;
  cats: {
    cat: CatId;
    /** 当前所处的姿势；片段播到一半时是它的开始姿势。 */
    pose: string;
    clip: string;
    variant: number;
    /** 正在做的行为（Behavior），给人看的简短说明。 */
    behavior: string;
    x: number;
    y: number;
  }[];
}

// ---------- preload 暴露给渲染进程的接口 ----------

/** preload 把桥挂在 window 的这个属性上。 */
export const BRIDGE_KEY = 'ttcats';

export type Unsubscribe = () => void;

/** 面板（设置、资料卡、调试台）用的桥。 */
export interface PanelsBridge {
  sendCommand(command: ToMainCommand): void;
  getSnapshot(): Promise<StateSnapshot>;
  getContent(): Promise<ContentCatalog>;
  onSnapshot(listener: (snapshot: StateSnapshot) => void): Unsubscribe;
  onStageDebug(listener: (report: StageDebugReport) => void): Unsubscribe;
}

/** 桌面层用的桥。 */
export interface OverlayBridge {
  sendCommand(command: ToMainCommand): void;
  sendFact(fact: Fact): void;
  sendOverlay(message: OverlayToMain): void;
  getSnapshot(): Promise<StateSnapshot>;
  getContent(): Promise<ContentCatalog>;
  onSnapshot(listener: (snapshot: StateSnapshot) => void): Unsubscribe;
  onStageCommand(listener: (command: StageCommand) => void): Unsubscribe;
  onOverlay(listener: (message: MainToOverlay) => void): Unsubscribe;
}

/** preload 实际挂上去的桥。桌面层只用 OverlayBridge 的部分，面板只用 PanelsBridge 的部分。 */
export type RendererBridge = OverlayBridge & PanelsBridge;

/** 面板窗口的种类。主进程打开面板时，用地址里的 ?panel=…&cat=… 告诉页面显示哪一个。 */
export type PanelName = 'settings' | 'profile' | 'debug';
