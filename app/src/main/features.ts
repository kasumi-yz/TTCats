import type { MainCommand, StateSnapshot } from '../shared/ipc';
import type { MainCommandHandlers } from './ipc-router';
import type { TrayMenuSection } from './tray-menu';

/**
 * 主进程功能的接线（#98）：每个功能在自己的模块里返回一个 MainFeature，
 * 入口按登记顺序把它们接到快照推送、托盘、主进程命令和退出清理上。
 * 只填自己用得到的字段；不要为了凑齐字段写空函数。
 */
export interface MainFeature {
  /** 快照变化后调用。按登记顺序，在面板收到快照之后、托盘刷新之前。 */
  readonly onSnapshot?: (snapshot: StateSnapshot) => void;
  /** 托盘菜单段。按登记顺序排在猫的菜单之后、设置和退出之前。 */
  readonly menuSection?: TrayMenuSection;
  /** 本功能负责的 MainCommand 处理函数；每种命令全程序只能有一个功能负责。 */
  readonly mainCommands?: Partial<MainCommandHandlers>;
  /** 桌面层和托盘就绪后调用，按登记顺序。 */
  readonly start?: () => void;
  /** 退出清理：存档完成后按登记顺序同步执行，不能吞掉异常。 */
  readonly dispose?: () => void;
}

type CommandsOf<Feature> = Feature extends { readonly mainCommands?: infer Handlers }
  ? Handlers extends object
    ? Extract<keyof Handlers, MainCommand['type']>
    : never
  : never;

type DuplicateCommands<
  Features extends readonly unknown[],
  Seen extends string = never,
> = Features extends readonly [infer Head, ...infer Rest]
  ? (CommandsOf<Head> & Seen) | DuplicateCommands<Rest, Seen | CommandsOf<Head>>
  : never;

/** 编译期检查：每种 MainCommand 恰好由一个功能负责。报错时看属性名就知道缺了或重复了哪个。 */
type CommandCoverage<Features extends readonly MainFeature[]> = [
  Exclude<MainCommand['type'], CommandsOf<Features[number]>>,
] extends [never]
  ? [DuplicateCommands<Features>] extends [never]
    ? unknown
    : { duplicateMainCommands: DuplicateCommands<Features> }
  : { missingMainCommands: Exclude<MainCommand['type'], CommandsOf<Features[number]>> };

export function combineFeatures<const Features extends readonly MainFeature[]>(
  features: Features & CommandCoverage<Features>,
) {
  const list: readonly MainFeature[] = features;
  const mainCommands = Object.assign(
    {},
    ...list.map((feature) => feature.mainCommands ?? {}),
  ) as MainCommandHandlers;
  return {
    mainCommands,
    menuSections: list.flatMap((feature) => (feature.menuSection ? [feature.menuSection] : [])),
    onSnapshot(snapshot: StateSnapshot): void {
      for (const feature of list) feature.onSnapshot?.(snapshot);
    },
    start(): void {
      for (const feature of list) feature.start?.();
    },
    disposeSteps: list.flatMap((feature) =>
      feature.dispose
        ? [
            () => {
              feature.dispose?.();
            },
          ]
        : [],
    ),
  };
}
