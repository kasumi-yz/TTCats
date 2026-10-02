// 录入快捷键：把按键事件换成 Electron 的快捷键写法（规则见 shared/accelerator.ts）。
// 按 event.code（键的位置）认键，不按 event.key：按住 Shift 时 key 会变成另一个符号。

/** 录入时用到的按键事件字段，方便测试时直接构造。 */
export interface KeyPress {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const NAMED_CODES: ReadonlyMap<string, string> = new Map([
  ['Space', 'Space'],
  ['Tab', 'Tab'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Insert', 'Insert'],
  ['Enter', 'Enter'],
  ['NumpadEnter', 'Enter'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['Escape', 'Esc'],
  ['PrintScreen', 'PrintScreen'],
  ['NumpadDecimal', 'numdec'],
  ['NumpadAdd', 'numadd'],
  ['NumpadSubtract', 'numsub'],
  ['NumpadMultiply', 'nummult'],
  ['NumpadDivide', 'numdiv'],
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
  ['Backquote', '`'],
]);

const MODIFIER_CODE = /^(?:Control|Alt|Shift|Meta|OS)(?:Left|Right)?$/;

/** 按住的修饰键，按规范顺序。 */
export function heldModifiers(press: KeyPress): string[] {
  return [
    press.ctrlKey && 'Ctrl',
    press.altKey && 'Alt',
    press.shiftKey && 'Shift',
    press.metaKey && 'Super',
  ].filter((name): name is string => name !== false);
}

/**
 * 录入结果：
 * - waiting：只按了修饰键，继续等
 * - done：accelerator 是拼好的写法（可能不合规，交给 hideAllShortcutProblem 判断）；
 *   按了认不出的键时是 undefined
 */
export type KeyPressResult =
  { kind: 'waiting' } | { kind: 'done'; accelerator: string | undefined };

export function readKeyPress(press: KeyPress): KeyPressResult {
  if (MODIFIER_CODE.test(press.code)) return { kind: 'waiting' };
  const key = keyName(press.code) ?? keyNameFromKey(press.key);
  if (key === undefined) return { kind: 'done', accelerator: undefined };
  const modifiers = heldModifiers(press).map((name) =>
    name === 'Ctrl' ? 'CommandOrControl' : name,
  );
  return { kind: 'done', accelerator: [...modifiers, key].join('+') };
}

/** 有的环境给不出 code（比如部分远程桌面），退回按 key 认：只认字母、数字和与 code 同名的键。 */
function keyNameFromKey(key: string): string | undefined {
  if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase();
  return keyName(key);
}

function keyName(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `num${numpad[1]}`;
  const fn = /^F([0-9]{1,2})$/.exec(code);
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 24) return `F${fn[1]}`;
  return NAMED_CODES.get(code);
}
