// 草稿，M0 后定稿。
// 窗口之间的消息（ADR-0004）。只有三类：
// - 命令（Command）：要求对方做一件事。面板、托盘、桌面层 → 主进程；主进程 → 桌面层。
// - 事实（Fact）：桌面层告诉主进程"刚才发生了什么"，由主进程决定要不要改存档状态。
// - 状态快照（StateSnapshot）：主进程改完状态后推送给所有窗口。窗口不能自己改需要存档的状态。
// 所有时间都是 Unix 毫秒（真实时间），不按帧数累加（ADR-0004）。
import type { EventConfig, Settings } from './schemas';

/** IPC 通道名。 */
export const IPC_CHANNELS = {
  /** 渲染进程 → 主进程：ToMainCommand */
  command: 'ttcats:command',
  /** 桌面层 → 主进程：Fact */
  fact: 'ttcats:fact',
  /** 主进程 → 桌面层：StageCommand */
  stageCommand: 'ttcats:stage-command',
  /** 主进程 → 所有窗口：StateSnapshot */
  snapshot: 'ttcats:snapshot',
} as const;

type CatId = string;
type EventId = EventConfig['id'];

// ---------- 命令：发给主进程 ----------

export type ToMainCommand =
  | { type: 'settings/update'; patch: Partial<Settings> }
  /** 召唤（Summon）：不写 cat 表示召唤全部显示中的猫。 */
  | { type: 'cat/summon'; cat?: CatId }
  | { type: 'cat/setVisible'; cat: CatId; visible: boolean }
  | { type: 'cat/sleep'; cat: CatId }
  /** 开勿扰模式到某个时刻；null 表示关闭。 */
  | { type: 'doNotDisturb/set'; until: number | null }
  // 调试台（硬性规则 5：每个功能都必须能在调试台里手动触发）
  | { type: 'debug/triggerEvent'; event: EventId; cats?: CatId[] }
  | { type: 'debug/playClip'; cat: CatId; clip: string; variant?: number }
  /** 让 core/game 的时钟快进，用来测试冷却、离线结算等。 */
  | { type: 'debug/advanceClock'; ms: number };

// ---------- 命令：主进程发给桌面层 ----------

export type StageCommand =
  /** 让猫走到鼠标旁边。 */
  | { type: 'cat/summon'; cats: CatId[] }
  | { type: 'cat/sleep'; cat: CatId }
  /** 执行一个事件。事件是否该触发、冷却是否结束，已经由主进程判断过了。 */
  | { type: 'event/run'; event: EventId; cats: CatId[] }
  | { type: 'debug/playClip'; cat: CatId; clip: string; variant?: number };

// ---------- 事实：桌面层发给主进程 ----------

export type Fact = { at: number } & (
  | { type: 'cat/petted'; cat: CatId; durationMs: number }
  | { type: 'cat/poked'; cat: CatId }
  | { type: 'cat/pickedUp'; cat: CatId }
  | { type: 'cat/dropped'; cat: CatId }
  | { type: 'event/finished'; event: EventId; cats: CatId[] }
);

// ---------- 状态快照：主进程推送给所有窗口 ----------

export interface CatStateSnapshot {
  visible: boolean;
}

/** 用户状态：只根据系统空闲时间判断（D6）。 */
export type UserPresence = 'present' | 'away';

export interface StateSnapshot {
  /** 每推送一次加 1，窗口可以用它丢掉过期的快照。 */
  revision: number;
  /** 生成快照时的真实时间。 */
  at: number;
  settings: Settings;
  cats: Record<CatId, CatStateSnapshot>;
  doNotDisturb: boolean;
  userPresence: UserPresence;
  /** 各个事件的冷却结束时刻，只给调试台看。 */
  eventCooldownUntil: Record<EventId, number>;
}

/** preload 暴露给渲染进程的接口（window.ttcats）。 */
export interface RendererBridge {
  sendCommand(command: ToMainCommand): void;
  sendFact(fact: Fact): void;
  onStageCommand(listener: (command: StageCommand) => void): () => void;
  onSnapshot(listener: (snapshot: StateSnapshot) => void): () => void;
}
