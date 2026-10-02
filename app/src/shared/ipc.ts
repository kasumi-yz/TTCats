// 窗口之间的消息。M1 定稿（#18），M2 新增（#52）。只放已经要做的；事件等到 M3 再加（硬性规则 8）。
//
// 和需要存档的状态有关的消息只有三类（ADR-0004）：
// - 命令（Command）：要求对方做一件事。面板、托盘、右键菜单 → 主进程；主进程 → 桌面层。
// - 事实（Fact）：桌面层告诉主进程"刚才发生了什么"，由主进程决定要不要改存档状态。
// - 状态快照（StateSnapshot）：主进程改完状态后推送给所有窗口。窗口不能自己改需要存档的状态。
//
// 另外还有：
// - 桌面层的窗口控制消息（OverlayToMain / MainToOverlay）：鼠标穿透、幽灵模式、暂停绘制等。
//   它们只管桌面层这个窗口怎么工作，不碰需要存档的状态（ADR-0003）。
// - 程序状态（AppStatus）：版本号、自动更新、快捷键注册结果、显示器列表。不存档、不归 core/game 管，
//   主进程推给面板显示。
//
// 所有时间都是 Unix 毫秒（真实时间），不按帧数累加（ADR-0004）。调试台快进的偏移只在 core/game 内部用，
// 消息和存档里的时刻都不带偏移（见 core-api.ts 的 GameCore）。
// 所有坐标都是桌面层里的 CSS 像素，原点在桌面层左上角。
import type { ContentCatalog } from './core-api';
import type { DisplayInfo } from './display';
import type { CatSound } from './schemas/cat';
import type { Point } from './schemas/common';
import type { DoNotDisturb, DoNotDisturbDuration } from './schemas/do-not-disturb';
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
  /** 主进程 → 面板：AppStatus，有变化就推送整份（M2）。 */
  appStatus: 'ttcats:app-status',
  /** 面板 → 主进程（invoke）：要当前的 AppStatus。面板刚打开时用（M2）。 */
  getAppStatus: 'ttcats:get-app-status',
} as const;

type CatId = string;

// ---------- 命令：发给主进程 ----------

/**
 * 调试台模拟的鼠标互动（硬性规则 5）。
 * nearbyClicks：在这只猫旁边连续点击，次数够它走开（D10，#60）。
 */
export type SimulatedInteraction = 'poke' | 'pet' | 'pickUp' | 'drop' | 'nearbyClicks';

/** 由 core/game 处理的命令。 */
export type GameCommand =
  /** 改设置。改完的整份设置必须通过 SettingsSchema，否则整条命令被拒绝。 */
  | { type: 'settings/update'; patch: Partial<Settings> }
  /**
   * 召唤（Summon）：不写 cat 表示召唤全部显示中的猫。
   * to 是要走到的位置；不写就走到桌面层最后一次看到鼠标的地方。
   * 托盘和右键菜单由主进程按当时的光标位置填上 to。
   * 一键隐藏期间收到召唤：先结束一键隐藏（stageCommands 里先放 cat/entrance），再召唤。
   * 勿扰期间照常召唤，召唤完猫回到角落继续睡（#59）。
   */
  | { type: 'cat/summon'; cat?: CatId; to?: Point }
  /** 显示或隐藏某只猫，改的是 settings.visibleCats。猫走进来或走出去由 core/stage 安排（入场 / 出场）。 */
  | { type: 'cat/setVisible'; cat: CatId; visible: boolean }
  | { type: 'cat/sleep'; cat: CatId }
  /** 开始勿扰模式（D10）。已经开着时，按新的时长重新算。 */
  | { type: 'doNotDisturb/start'; duration: DoNotDisturbDuration }
  /** 结束勿扰模式。没开时什么也不做。 */
  | { type: 'doNotDisturb/end' }
  /**
   * 一键隐藏（HideAll，D10）开或关，全局快捷键触发。开：桌面层立刻隐藏、停止绘制（猫不走出去）；
   * 关：桌面层重新显示，猫从屏幕边重新入场（stageCommands 里放 cat/entrance）。不进存档，重启后照常显示。
   */
  | { type: 'hideAll/toggle' }
  // 调试台（硬性规则 5：每个功能都必须能在调试台里手动触发）
  | { type: 'debug/playClip'; cat: CatId; clip: string; variant?: number }
  | { type: 'debug/simulate'; cat: CatId; interaction: SimulatedInteraction }
  /**
   * 快进时钟：core/game 看到的时间往后跳 minutes 分钟（1～10080，也就是最多 7 天），用来测勿扰到点、安静时段。
   * 可以多次快进，累加。偏移不存档，重启后清零。core/game 收到后立刻按新时间推进一次（相当于 tick）。
   * 没到期的定时勿扰，剩余时间跟着减少（快照和存档里的 until 提前同样的时长，仍是真实时间）。
   */
  | { type: 'debug/advanceClock'; minutes: number }
  /** 模拟开机启动的静默：从现在起 STARTUP_QUIET_MS 内不出声（D10，#67）。 */
  | { type: 'debug/startupQuiet' }
  /** 让全部显示中的猫重新入场（core/game 原样转成 StageCommand 的 cat/entrance）。 */
  | { type: 'debug/entrance' }
  /** 让某只猫发出喵叫或呼噜（core/game 原样转成 StageCommand）。照样受声音开关、安静时段、勿扰的限制。 */
  | { type: 'debug/sound'; cat: CatId; sound: CatSound };

/** 由主进程自己处理、不经过 core/game 的命令。 */
export type MainCommand =
  /** 拍照（Photo，#63）：截下猫所在的那块显示器（一定带上猫），存到"图片\TTCats"，同时复制到剪贴板。 */
  | { type: 'photo/take' }
  /** 导出诊断信息（D13，#64）：弹出保存对话框，把日志、存档、版本、系统信息打包成 zip。 */
  | { type: 'diagnostics/export' }
  /** 检查更新（#68）。设置里关掉了自动更新，手动检查也有效。 */
  | { type: 'update/check' }
  /** 重启并安装已经下好的更新（#68）。没有下好的更新时什么也不做。 */
  | { type: 'update/install' }
  /** 调试台：让桌面层的渲染进程崩溃，用来测试崩溃恢复和安全模式（D13）。 */
  | { type: 'debug/crashOverlay' }
  /**
   * 调试台：模拟前台有全屏程序（D10）。true：和真的全屏一样隐藏桌面层；false：结束模拟，回到按系统判断；
   * 如果因此不再算全屏，猫从屏幕边走回来（和真的全屏结束一样，主进程发 cat/entrance）。
   */
  | { type: 'debug/simulateFullscreen'; active: boolean };

export type ToMainCommand = GameCommand | MainCommand;

/** MainCommand 的全部 type，主进程用 isMainCommand 分流。 */
export const MAIN_COMMAND_TYPES = [
  'photo/take',
  'diagnostics/export',
  'update/check',
  'update/install',
  'debug/crashOverlay',
  'debug/simulateFullscreen',
] as const satisfies readonly MainCommand['type'][];

// 漏写了某个 MainCommand 的 type 时，这里会报类型错误。
type AssertTrue<T extends true> = T;
export type MainCommandTypesComplete = AssertTrue<
  [Exclude<MainCommand['type'], (typeof MAIN_COMMAND_TYPES)[number]>] extends [never] ? true : false
>;

export function isMainCommand(command: ToMainCommand): command is MainCommand {
  return (MAIN_COMMAND_TYPES as readonly string[]).includes(command.type);
}

// ---------- 命令：主进程发给桌面层 ----------

export type StageCommand =
  /** 让猫走到某个位置。core/game 原样转发 GameCommand 里的 to。 */
  | { type: 'cat/summon'; cats: CatId[]; to?: Point }
  | { type: 'cat/sleep'; cat: CatId }
  /**
   * 全部显示中的猫从屏幕外重新入场（Entrance）。用在：全屏结束（主进程发）、一键隐藏结束（core/game 发）、
   * 调试台的 debug/entrance。桌面层刚创建 StageCore 时会自己入场，不需要这条命令。
   */
  | { type: 'cat/entrance' }
  | { type: 'debug/playClip'; cat: CatId; clip: string; variant?: number }
  | { type: 'debug/simulate'; cat: CatId; interaction: SimulatedInteraction }
  /** 喵叫：发一次；呼噜：响几秒后自己停（时长由 core/stage 定）。 */
  | { type: 'debug/sound'; cat: CatId; sound: CatSound };

// ---------- 事实：桌面层发给主进程 ----------

export type Fact = { at: number } & (
  | { type: 'cat/petted'; cat: CatId; durationMs: number }
  | { type: 'cat/poked'; cat: CatId }
  | { type: 'cat/pickedUp'; cat: CatId }
  | { type: 'cat/dropped'; cat: CatId }
);

// ---------- 状态快照：主进程推送给所有窗口 ----------

/**
 * 现在为什么不能出声（D10、D11）：
 * - doNotDisturb：开着勿扰模式
 * - quietHours：在安静时段里
 * - startupQuiet：开机自动启动后的静默（约 1 分钟，STARTUP_QUIET_MS）
 */
export type SilenceReason = 'doNotDisturb' | 'quietHours' | 'startupQuiet';

export interface StateSnapshot {
  /** 每推送一次加 1，窗口可以用它丢掉过期的快照。 */
  revision: number;
  /** 生成快照时的真实时间。 */
  at: number;
  settings: Settings;
  /**
   * 勿扰模式（M2）。until 是真实时间，面板显示的剩余时间就是 until - at，显示结束时刻直接用 until。
   * 桌面层只看 mode 是不是 off：到点由 core/game 的 tick 结束并推送新快照，桌面层不用 until 自己判断。
   */
  doNotDisturb: DoNotDisturb;
  /** 一键隐藏开着没有（M2）。不存档。 */
  hideAll: boolean;
  /**
   * 现在为什么不能出声，由 core/game 根据勿扰模式、安静时段、开机静默算出来（M2）。
   * 空数组表示可以出声；多个原因同时成立时都列出来，按 doNotDisturb、quietHours、startupQuiet 的顺序。
   * 声音开关和音量另看 settings，由桌面层自己按设置处理。
   */
  silencedBy: SilenceReason[];
  /**
   * 调试台快进的时钟偏移（毫秒，M2），只给调试台显示。core/game 看到的时间 = 真实时间 + 它。
   * 没快进过是 0，重启后清零。快照里其他时刻都不带这个偏移。
   */
  clockOffsetMs: number;
}

// ---------- 程序状态：主进程推送给面板 ----------

/**
 * 自动更新的状态（D1、#68）：
 * - unsupported：不是安装版（开发模式），不能自动更新
 * - off：设置里关掉了自动更新，现在也没在手动检查
 * - idle：开着，现在没事做。checkedAt 是上一次检查完、没有新版本的时间；还没检查过是 null
 * - checking：检查中
 * - downloading：下载中，percent 是 0～100
 * - downloaded：已下好，等用户点"重启并更新"，不点也会在下次退出时安装
 * - error：上一次检查或下载失败。message 是给人看的中文说明；下次照常再试
 */
export type UpdateStatus =
  | { state: 'unsupported' }
  | { state: 'off' }
  | { state: 'idle'; checkedAt: number | null }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string; at: number };

/**
 * 程序状态：不存档、不归 core/game 管，但面板要显示（M2）。
 * 单独一个通道，不放进 StateSnapshot：快照只装 core/game 管的状态（ADR-0004），桌面层也用不到这些；
 * 它们由主进程的不同模块（更新、快捷键、显示器）在不同时候改，各改各的不会去碰 core/game。
 * 面板打开时用 getAppStatus 拿一次，之后收 appStatus 推送，按 revision 丢掉过期的。
 */
export interface AppStatus {
  /** 每推送一次加 1。 */
  revision: number;
  /** 程序版本号（app.getVersion()）。 */
  version: string;
  update: UpdateStatus;
  /**
   * 一键隐藏快捷键的注册结果。accelerator 是主进程最近一次尝试注册的快捷键（和 settings.hideAllShortcut 一样时
   * 才说明设置已经生效）；registered 为 false 表示注册失败，多半是被别的程序占用了。
   */
  hideAllShortcut: { accelerator: string; registered: boolean };
  /** 现在接着的全部显示器（D12）。只有一块时也列出来。 */
  displays: DisplayInfo[];
  /** 桌面层现在在哪块显示器上（DisplayInfo.id）；桌面层还没建好时是 null。 */
  overlayDisplayId: number | null;
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
  /**
   * 桌面层被隐藏（前台有全屏程序、一键隐藏、一只猫都不显示、安全模式）时暂停绘制，恢复显示时继续。
   * 全屏、一键隐藏结束后猫从屏幕边走回来，靠紧接着的 StageCommand cat/entrance，不靠这条消息。
   */
  | { type: 'paused'; paused: boolean }
  /** 调试台打开或关闭：要不要定时上报画面状态。 */
  | { type: 'stageDebug'; enabled: boolean }
  /**
   * 鼠标正穿过桌面层时，左键按下了（从松开变成按下的那一刻，M2 #60）。点击照常落到下面的窗口，主进程不拦也不延迟。
   * 幽灵模式下穿过猫的点击也发。拖动中、光标不在桌面层里时不发。桌面层按点击遮罩补上 cat，
   * 转成 PointerInput 的 clickThrough 交给 core/stage，由它判断是不是点在某只猫旁边。
   */
  | { type: 'clickThrough'; x: number; y: number }
  /**
   * 拍好了一张照片（M2 #63），桌面层播放快门动画。照片已经拍完、存好，动画不会出现在照片里。
   * thumbnail：缩略图的 data URL（PNG 或 JPEG），长边不超过 480 像素，宽高比和照片一样。
   * area：照片拍到的范围（整块显示器），用桌面层里的 CSS 像素表示；可能比桌面层大（比如包括了任务栏）。
   * 动画从这个范围开始缩小，播放时桌面层照样让鼠标穿过、不抢焦点（ADR-0003）。
   */
  | {
      type: 'photo';
      thumbnail: string;
      area: { x: number; y: number; width: number; height: number };
    };

/** 桌面层上报的画面状态。只用于调试台显示，不存档。 */
export interface StageDebugReport {
  at: number;
  cats: {
    cat: CatId;
    /** 当前所处的姿势；片段播到一半时是它的开始姿势。 */
    pose: string;
    clip: string;
    variant: number;
    /** 正在做的行为（Behavior），给人看的简短说明。入场、出场、去角落、勿扰睡觉也在这里显示（#59）。 */
    behavior: string;
    x: number;
    y: number;
  }[];
  /**
   * 桌面层的声音播放情况（M2 #61）。core/stage 的 debugReport 不填，由桌面层在上报前填上。
   * playing：正在播放的声音；suspended：音频是否已挂起（没有声音在播时挂起，省 CPU）。
   */
  audio?: { playing: { cat: CatId; sound: CatSound }[]; suspended: boolean };
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
  getAppStatus(): Promise<AppStatus>;
  onSnapshot(listener: (snapshot: StateSnapshot) => void): Unsubscribe;
  onStageDebug(listener: (report: StageDebugReport) => void): Unsubscribe;
  onAppStatus(listener: (status: AppStatus) => void): Unsubscribe;
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
