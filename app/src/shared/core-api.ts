// core/game 和 core/stage 对外的接口，只有类型和几个共用的常数，没有实现。M1 定稿（#18），M2 新增（#52），M3、M4 新增（#106）。
// 两者都是纯 TypeScript（硬性规则 1）：不读系统时钟和时区、不碰文件和窗口，
// 时间、时区、内容、屏幕大小、窗口顶边、随机数都由调用方传进来，所以可以直接做单元测试。
import type { Fact, GameCommand, StageCommand, StageDebugReport, StateSnapshot } from './ipc';
import type { Cat, CatSound, Clip, EventConfig, EventEffect, GameState, Pose } from './schemas';

/** 已经通过校验、可以使用的全部内容。主进程加载，通过 IPC 发给桌面层和面板。 */
export interface ContentCatalog {
  /** 加载成功的猫，键是猫 id。 */
  cats: Record<string, { cat: Cat; clips: Clip[] }>;
  /** 被整只停用的猫咪包，以及中文原因（说清楚是哪只猫、缺了什么）。给调试台和安全模式看。 */
  disabled: { cat: string; problems: string[] }[];
  /**
   * 通过校验的事件配置，键是事件 id（M3）。没通过校验的事件不在这里，原因写进日志（说清楚是哪个事件、缺了什么）。
   * core/game 按它判断触发，core/stage 按它执行步骤，调试台按它列出全部事件。
   */
  events: Record<string, EventConfig>;
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
 * 用户状态的信号（M3，D6）。主进程只读系统空闲时间，以及锁屏、解锁、系统睡眠、唤醒，不读别的（比如在用什么软件）：
 * - idle：系统已经空闲了多久（毫秒，Electron 的 powerMonitor.getSystemIdleTime() × 1000）。主进程定期读，频率由 #111 定，要省 CPU。
 * - locked / unlocked：锁屏、解锁。
 * - suspended / resumed：系统睡眠、唤醒。
 * "你离开了""你回来了""你坐太久了"由 core/game 根据这些信号和时间判断，阈值写在 core/game 的 README 里。
 */
export type UserStateSignal =
  | { type: 'idle'; idleMs: number }
  | { type: 'locked' }
  | { type: 'unlocked' }
  | { type: 'suspended' }
  | { type: 'resumed' };

/**
 * 调试台的快进（GameCommand 的 debug/advanceClock）：core/game 看到的时间 = 调用方传进来的 now + 快进的偏移。
 * 偏移由 core/game 自己记，不存档，重启（重新创建 GameCore）后清零；当前值放在快照的 clockOffsetMs 里。
 * - 安静时段、开机静默按 core/game 看到的时间判断。
 * - 勿扰的剩余时间也跟着快进减少，但对外（exportState、快照）的结束时刻 `doNotDisturb.until` 一律是**真实时间**：
 *   每快进 d，没到期的勿扰 until 提前 d。这样存进存档的 until 不带偏移，重启后剩余时间不变（#75 审查）。
 *   比如先快进 7 天、再开 30 分钟勿扰，存档里的 until 是真实时间 + 30 分钟，重启后还剩 30 分钟，不是 7 天多。
 *   #58 要用单元测试覆盖："快进后开始勿扰 → 导出 → 重建"和"开着勿扰 → 快进一部分 → 导出 → 重建"，剩余时间都不变。
 * - 事件的冷却也一样（M3）：每快进 d，冷却剩余时间少 d；存档和快照里的 events.lastTriggeredAt 一律是真实时间。
 *   触发条件里的日期、时刻、"当天"都按快进后的时间算。
 *
 * 事件（M3，D6）由 core/game 安排：
 * - 什么时候触发、谁参与、冷却，按 content.events 的配置和 `schemas/event.ts` 的说明判断；冷却和早安记录存档（GameState.events）。
 * - 触发时在 GameOutput.stageCommands 里放 StageCommand `event/start`（带 core/game 编的 run 号），并且 stateChanged 为 true。
 *   tick、handleUserState、handleCommand 都可能触发。
 * - 不触发的时候：勿扰模式、一键隐藏、全屏（setFullscreen）、没有显示中的猫、还没收到过 stage/created（桌面层还没准备好，
 *   命令会丢）。安全模式下主进程不再调用 tick 和 handleUserState，所以也不会触发。这些时候错过的定时事件一律不补发（D16）。
 *   "你离开了"本来就是没人操作时触发的，照常触发。
 * - 同一只猫同一时间只参与一个事件。core/game 按猫记下它在哪一次事件（run）里：
 *   - 发出 event/start 时记上；收到这只猫这一次的 event/ended 时去掉。
 *   - 收到 event/started 时按它重新记上（桌面层重新加载前后发出的命令，可能被新的 StageCore 收到并开始演）。
 *     同一只猫以 run 号大的那次为准：比它小的 started、ended 不改记录。
 *   - 收到 stage/created（桌面层新建了 StageCore，原来正在演的事件全没了、不会再有 ended）时，全部记录清空。
 *     这些事件不补演，冷却照算。
 *   - **不按时间自己回收**：停在 stay 这一步的猫（比如"你离开了"睡着）离开多久都算在事件里，随机事件不会挑它，
 *     直到被打断、被优先级高的事件（比如"你回来了"）接管，或者桌面层重新加载。
 * - 优先级高的事件（"你离开了""你回来了"）可以接管正在演别的事件的猫：直接发新的 event/start，由 core/stage 让猫退出旧的。
 *   #107 要用单元测试覆盖："你离开了"之后过了很久（比如 8 小时）还在睡、随机事件不挑它；收到 stage/created 后记录清空、
 *   之后能重新触发；stage/created 之后再收到旧命令的 event/started 时重新记上。
 */
export interface GameCore {
  handleCommand(command: GameCommand, now: number): GameOutput;
  /**
   * 桌面层的事实。事件的 stage/created、event/started、event/ended 用来知道哪只猫还在事件里（M3，规则见上面）。
   */
  handleFact(fact: Fact, now: number): GameOutput;
  /**
   * 用户状态的信号（M3）。主进程定期送 idle，锁屏、解锁、睡眠、唤醒时马上送。
   * 判断出"离开了""回来了""坐太久了"时触发对应的事件（userState 触发条件）。
   * 当天第一次见到用户（程序刚启动后的第一次 idle、睡眠或锁屏后回来）也在这里判断早安。
   */
  handleUserState(signal: UserStateSignal, now: number): GameOutput;
  /**
   * 前台有全屏程序、桌面层被自动隐藏（D10）开始或结束（M3），包括调试台的模拟全屏。全屏期间不触发事件，结束后不补发。
   * 全屏不算离线（D16）。不存档，重新创建 GameCore 时当作没有全屏。
   */
  setFullscreen(active: boolean, now: number): GameOutput;
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
  /** 随机数来源，返回 [0, 1)（M3：随机事件、按性格参数挑猫）。测试时可以传固定序列。 */
  random: () => number;
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
 * 一个可以站的窗口的顶边（窗口顶边 Ledge，M4，D4）。坐标是桌面层里的 CSS 像素，和 StageBounds 一样，原点在桌面层左上角。
 */
export interface LedgeWindow {
  /**
   * 窗口的 id，这个窗口存在期间不变（比如窗口句柄）。窗口关掉以后，同一个 id 可能被新窗口用上，
   * 所以猫站的窗口从列表里消失过一次，就算这个窗口没了。
   */
  id: string;
  /**
   * 窗口可见上边缘整条线的左右端点和高度（y），没扣掉遮挡和标题栏按钮，**也不裁到桌面层范围之内**：
   * 窗口有一部分在屏幕外时，left 可以小于 0、right 可以大于桌面层宽度，是窗口真实的边界。
   * 窗口移动时整条线跟着平移：前后两份 Ledges 里同一个窗口的位置差除以 at 的差，就是窗口移动的速度。
   * #114、#115 要测：窗口一部分移出屏幕后继续移动，left 不被夹在 0，猫照常跟着走、速度照常算。
   */
  left: number;
  right: number;
  top: number;
  /**
   * 这条边上猫可以站的段，从左到右、互不重叠，都在 left～right 之内。已经扣掉了被别的窗口挡住的部分和标题栏按钮区（D4），
   * 并且裁到桌面层的左右范围之内（只有这里裁，left、right 不裁）。
   * 可能是空数组（整条边都被挡住了，或者都在屏幕外）。猫的宽度够不够站，由 core/stage 判断。
   */
  segments: { left: number; right: number }[];
}

/**
 * 某一刻全部可以站的窗口顶边（M4）。主进程读窗口列表算出来（#114），通过 MainToOverlay 的 ledges 推给桌面层（#116），
 * 桌面层交给 StageCore.setLedges。
 */
export interface Ledges {
  /** 主进程读到这份窗口列表的时刻（真实时间）。算窗口移动速度用它，不用桌面层收到消息的时刻。 */
  at: number;
  /**
   * 可以站的窗口，按前后顺序从最前到最后。只列可见的普通窗口：最小化、最大化、全屏、被系统隐藏（比如在别的虚拟桌面上）、
   * 已经关掉的窗口都不在里面。猫站的窗口不在列表里了，猫就掉下来，不用区分原因。
   * 只算桌面层所在的那块显示器（D12）；顶边不在桌面层上下范围之内的窗口不列。
   */
  windows: LedgeWindow[];
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
 * - cut：用户触发的打断立刻切换片段时，盖住切换处的小特效（ADR-0002）
 * - 事件能放的特效（EventEffect，M3）：hearts（爱心，撸猫时也用）、bug（飞虫）、confetti（彩纸和小星星）、
 *   lantern（灯笼）、gift（小礼物盒）。各自出现在哪、怎么动见 `schemas/event.ts` 的 EventEffectSchema。
 * 特效只画、不挡鼠标。地板装饰（lantern、gift）画在猫的后面，其余的画在猫的前面。
 */
export type StageEffect = 'cut' | EventEffect;

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
  /**
   * 特效。id 在特效的整个生命期里不变，渲染层用它对应到同一个动画。
   * x、y 是特效现在的位置（飞虫每帧都在变）；ageMs 是已经播了多久，durationMs 是一共播多久（M3），渲染层用它们做动画进度和淡出。
   */
  effects: {
    id: number;
    effect: StageEffect;
    x: number;
    y: number;
    ageMs: number;
    durationMs: number;
  }[];
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
 *
 * 事件执行（M3，#108），收到 StageCommand 的 event/start 时：
 * - 每只参与的猫各自按事件配置的 steps 顺序执行，同时开始（要错开就靠 wait 的随机时长），步骤的含义见 `schemas/event.ts`。
 *   猫先按 ADR-0002 的普通规则衔接：等当前片段回到姿势再接下去，不硬切。
 * - 缺片段：requiredClips 里的片段缺了，这只猫不演（ended: missingClip）；playClip 的片段缺了跳过这一步；
 *   moveTo 跑没有 run 时改成走。不能卡住、不能抛错。
 * - 打断：事件进行中，这只猫被点、撸、拎起、召唤、叫去睡觉，调试台对它播放片段或模拟互动，勿扰开始，它被隐藏，
 *   收到 cat/entrance，或者它被新的 event/start 接管时，它马上退出事件（ended: interrupted），用户触发的按 ADR-0002 立刻切。
 *   同一事件里的其他猫照常演完。
 * - 收到命令时没法参加的猫（不在桌面上、正在入场或出场、悬空或下落）不演（ended: unavailable）。
 * - 事实：StageCore 新建后的第一条事实是 stage/created（程序启动、桌面层重新加载各一次），core/game 靠它清掉旧的事件记录。
 *   每次 event/start，至少一只猫开始演时发一次 event/started；之后命令里的每只猫各有且只有一条 event/ended（见 ipc.ts 的 Fact）。
 *   桌面层要先订阅 StageCommand、再开始取事实（drainFacts），这样 stage/created 之后发来的命令都能收到。
 * - 事件放的特效、气泡在事件结束或猫退出后照样播完自己的时长。
 * - 长时间暂停（隐藏后恢复，LONG_GAP_MS）后不把落下的步骤一下子全补上。
 * - 停在 stay 这一步时不做自主行为、不理鼠标靠近，直到被打断或接管；不管停多久都不算演完，不发 ended。
 * - #108 要用单元测试覆盖：停在 stay 的猫过很久（比如 8 小时，中间有长时间暂停）还在睡、不发 ended；
 *   新建的 StageCore 第一条事实是 stage/created；目标特效已经播完时 face、moveTo 按 schemas/event.ts 的规则降级。
 * - debugReport 的 event 写出每只猫正在做哪个事件的第几步。
 *
 * 窗口模式（M4，#115，D4），只在快照的 settings.surfaceMode 为 window 时：
 * - 表面（Surface）是地板和 setLedges 收到的窗口顶边。猫在窗口顶边上只能在它站的那一段里走。
 * - 跳跃（Jump）：蹲下蓄力 → 腾空（沿程序算的抛物线）→ 落地三段，片段见 clip.ts 的 CLIP_SLOTS。
 *   缺蹲下蓄力（jump-crouch）或腾空（airborne）片段的猫不上窗口。
 * - 站的窗口慢慢移动时猫跟着平移；移动太快、窗口从列表里消失、脚下那一段没了（被挡住、变短）时猫掉下来，
 *   落到地板或下面的窗口顶边上。速度阈值由 core/stage 定。
 * - 拎起来在窗口顶边附近松手，猫站到这个窗口上。
 * - 切回地板模式时，窗口上的猫下到地板。勿扰、入场出场、召唤、事件仍在地板上进行，窗口上的猫先下来。
 * - debugReport 的 surface 写出每只猫站在哪个表面上。地板模式下都在地板上（悬空、下落时是 null）。
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
  /**
   * 收到最新的窗口顶边（M4）。窗口模式、桌面层在显示时主进程才推送，频率由 #116 定；每次都是完整的一份，不是增量。
   * 地板模式下不用它。桌面层刚创建或重新加载后、收到第一份之前，当作没有窗口顶边。
   */
  setLedges(ledges: Ledges, now: number): void;
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
