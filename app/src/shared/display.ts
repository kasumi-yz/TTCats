// M2 定稿（#52）。
// 猫待在哪块显示器（D12，2026-10-02 用户决定：暂不支持多显示器，有多块时猫只在设置的那一块上，默认主显示器）。
// 主进程摆放桌面层（#65）、面板显示当前选中的是哪一块（#62），都用这里的 findDisplay，保证认法一致。
import type { DisplayRef } from './schemas/settings';

/** 主进程看到的一块显示器（来自 Electron 的 screen.getAllDisplays()）。面板从 AppStatus.displays 拿到。 */
export interface DisplayInfo {
  /** Electron 的 Display.id。同一次运行里不变；Windows 上重启、插拔后可能变。 */
  id: number;
  /** 显示器型号名（Electron 的 Display.label，来自显示器的 EDID），比如 `DELL U2720Q`；拿不到时是空字符串。 */
  label: string;
  /** 物理分辨率（像素），等于 Display.size × scaleFactor 取整。 */
  width: number;
  height: number;
  /** 缩放比例，比如 1.5 表示 150%。 */
  scaleFactor: number;
  /** 是不是 Windows 的主显示器。 */
  primary: boolean;
}

/** 用户在设置里选了某块显示器时，记进 settings.display 的内容。 */
export function displayRefOf(display: DisplayInfo): DisplayRef {
  return { id: display.id, label: display.label, width: display.width, height: display.height };
}

/**
 * 在现有的显示器里找出设置里记住的那一块，按顺序：
 * 1. id 和型号名都一样：就是它（同一次运行里，或者重启后 id 没变）。
 * 2. 型号名不是空的、一样，而且分辨率也一样，只有一块：是它（重启或插拔后 id 变了）。
 * 3. 型号名不是空的、一样，只有一块：是它（用户改了分辨率）。
 * 4. 都对不上：返回 undefined，调用方改用主显示器，但不改设置；那块显示器重新接上后还能认出来，猫再回到它上面。
 * 不单凭 id 认：Windows 重新编号后，同一个 id 可能变成另一块显示器。两块同型号、同分辨率的显示器在 id 变了以后
 * 分不清，也按第 4 条处理。
 */
export function findDisplay<T extends DisplayInfo>(
  ref: DisplayRef,
  displays: readonly T[],
): T | undefined {
  const exact = displays.find((d) => d.id === ref.id && d.label === ref.label);
  if (exact !== undefined) return exact;
  if (ref.label === '') return undefined;
  const sameLabel = displays.filter((d) => d.label === ref.label);
  const sameSize = sameLabel.filter((d) => d.width === ref.width && d.height === ref.height);
  if (sameSize.length === 1) return sameSize[0];
  if (sameLabel.length === 1) return sameLabel[0];
  return undefined;
}

/**
 * 猫应该待在哪块显示器：settings.display 是 null（默认）就用主显示器；
 * 设置的那块认不出来（findDisplay 返回 undefined）也用主显示器。列表里没有主显示器时返回 undefined。
 */
export function chooseDisplay<T extends DisplayInfo>(
  ref: DisplayRef | null,
  displays: readonly T[],
): T | undefined {
  return (ref === null ? undefined : findDisplay(ref, displays)) ?? displays.find((d) => d.primary);
}
