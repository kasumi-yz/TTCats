// M2 定稿（#52）。
// 全局快捷键的写法：Electron 的 accelerator 字符串，比如 `CommandOrControl+Alt+Shift+H`。
// 设置里的一键隐藏快捷键按这里校验（D10）；主进程注册、面板录入和显示都用同一套规则。
import { zh } from './strings.zh-CN';

/** 调试台的快捷键，由主进程注册（#28）。一键隐藏不能和它重复。 */
export const DEBUG_PANEL_SHORTCUT = 'CommandOrControl+Shift+F10';

/** 规范写法里的修饰键，按这个顺序排列。 */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

/**
 * 修饰键的各种写法（不分大小写）→ 规范写法。Windows 上 CommandOrControl 就是 Ctrl，Meta 就是 Super（Win 键）。
 * 只收 Windows 上有效的写法：Electron 在 Windows 上会忽略 Command、Option，
 * 写了等于没有修饰键，所以不收；Mac 版（第四阶段）再按需要加。
 */
const MODIFIERS: Readonly<Record<string, Modifier>> = {
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
};

/** 有名字的按键（不分大小写）→ 规范写法。Return 和 Enter、Escape 和 Esc 是同一个键。 */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  plus: 'Plus',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  return: 'Enter',
  enter: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Esc',
  esc: 'Esc',
  printscreen: 'PrintScreen',
  numdec: 'numdec',
  numadd: 'numadd',
  numsub: 'numsub',
  nummult: 'nummult',
  numdiv: 'numdiv',
};

/** 可以直接写的标点（Electron 文档列出的那些）。加号是分隔符，要写成 Plus。 */
const PUNCTUATION = new Set(')!@#$%^&*(:;=<,_->.?/~`{][|\\}"');

function normalizeKey(token: string): string | undefined {
  const lower = token.toLowerCase();
  if (/^[a-z0-9](?![\s\S])/.test(lower)) return lower.toUpperCase();
  if (/^f(?:[1-9]|1[0-9]|2[0-4])(?![\s\S])/.test(lower)) return lower.toUpperCase();
  if (/^num[0-9](?![\s\S])/.test(lower)) return lower;
  if (token.length === 1 && PUNCTUATION.has(token)) return token;
  return NAMED_KEYS[lower];
}

export interface Accelerator {
  /** 修饰键，按 Ctrl、Alt、Shift、Super 的顺序，没有重复。 */
  modifiers: Modifier[];
  /** 规范写法的按键，比如 `H`、`F5`、`Space`。 */
  key: string;
}

/** 按 Electron 的写法拆开快捷键；写法不对时返回 undefined。不检查是否缺修饰键、是否被占用。 */
export function parseAccelerator(text: string): Accelerator | undefined {
  const tokens = text.split('+');
  const keyToken = tokens.pop();
  if (keyToken === undefined) return undefined;
  const key = normalizeKey(keyToken);
  if (key === undefined) return undefined;
  const modifiers = new Set<Modifier>();
  for (const token of tokens) {
    const modifier = MODIFIERS[token.toLowerCase()];
    if (modifier === undefined || modifiers.has(modifier)) return undefined;
    modifiers.add(modifier);
  }
  return { modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)), key };
}

/**
 * 规范写法，比如 `ctrl+shift+alt+h` → `Ctrl+Alt+Shift+H`。用来比较两个快捷键是不是同一个，
 * 也可以直接给用户看，或者交给 Electron 注册。写法不对时返回 undefined。
 */
export function normalizeAccelerator(text: string): string | undefined {
  const parsed = parseAccelerator(text);
  return parsed === undefined ? undefined : [...parsed.modifiers, parsed.key].join('+');
}

/**
 * 能不能用作一键隐藏的全局快捷键。能用返回 undefined，不能用返回中文原因：
 * - 写法：`修饰键+…+按键`，用 + 连接，不能有空格，不分大小写。
 *   修饰键：Ctrl（也可以写 Control、CommandOrControl、CmdOrCtrl）、Alt、Shift、Super（Win 键，也可以写 Meta），不能重复。
 *   按键只能有一个，放在最后：字母、数字、F1～F24、Electron 支持的标点、Plus（加号）、Space、Tab、Backspace、
 *   Delete、Insert、Enter（Return）、Up、Down、Left、Right、Home、End、PageUp、PageDown、Esc（Escape）、
 *   PrintScreen、小键盘的 num0～num9、numdec、numadd、numsub、nummult、numdiv。
 * - 至少要有一个 Ctrl、Alt 或 Super：全局快捷键会拦下所有程序里的这个按键，只有 Shift 会和打字冲突。
 * - 不能和调试台的 DEBUG_PANEL_SHORTCUT 重复。
 * 能通过校验不代表一定能注册成功（可能被别的程序占了），注册结果看 AppStatus.hideAllShortcut。
 */
export function hideAllShortcutProblem(text: string): string | undefined {
  const v = zh.validation;
  const parsed = parseAccelerator(text);
  if (parsed === undefined) return v.acceleratorFormat;
  if (!parsed.modifiers.some((m) => m !== 'Shift')) return v.acceleratorNeedsModifier;
  if (normalizeAccelerator(text) === normalizeAccelerator(DEBUG_PANEL_SHORTCUT)) {
    return v.acceleratorReserved;
  }
  return undefined;
}
