import { describe, expect, it } from 'vitest';
import {
  DEBUG_PANEL_SHORTCUT,
  hideAllShortcutProblem,
  normalizeAccelerator,
  parseAccelerator,
} from './accelerator';
import { DEFAULT_HIDE_ALL_SHORTCUT } from './schemas/settings';
import { zh } from './strings.zh-CN';

describe('全局快捷键的写法', () => {
  it('默认的一键隐藏快捷键能用，而且和调试台不冲突', () => {
    expect(hideAllShortcutProblem(DEFAULT_HIDE_ALL_SHORTCUT)).toBeUndefined();
    expect(normalizeAccelerator(DEFAULT_HIDE_ALL_SHORTCUT)).toBe('Ctrl+Alt+Shift+H');
    expect(normalizeAccelerator(DEFAULT_HIDE_ALL_SHORTCUT)).not.toBe(
      normalizeAccelerator(DEBUG_PANEL_SHORTCUT),
    );
  });

  it.each([
    ['commandorcontrol+alt+shift+h', 'Ctrl+Alt+Shift+H'],
    ['Shift+Alt+CmdOrCtrl+H', 'Ctrl+Alt+Shift+H'],
    ['Control+k', 'Ctrl+K'],
    ['Meta+Return', 'Super+Enter'],
    ['Alt+escape', 'Alt+Esc'],
    ['Ctrl+Alt+f12', 'Ctrl+Alt+F12'],
    ['Ctrl+Alt+F24', 'Ctrl+Alt+F24'],
    ['Ctrl+Plus', 'Ctrl+Plus'],
    ['Ctrl+Alt+/', 'Ctrl+Alt+/'],
    ['Ctrl+NUM5', 'Ctrl+num5'],
    ['Alt+PageDown', 'Alt+PageDown'],
    ['Ctrl+Alt+7', 'Ctrl+Alt+7'],
  ])('%s 的规范写法是 %s', (input, expected) => {
    expect(normalizeAccelerator(input)).toBe(expected);
    expect(hideAllShortcutProblem(input)).toBeUndefined();
  });

  it.each([
    '',
    '+',
    'Ctrl+',
    'Ctrl++',
    'Ctrl + H',
    ' Ctrl+H',
    'Ctrl+Ctrl+H',
    'Ctrl+Control+H',
    'Meta+Super+H',
    'Ctrl+H+J',
    'Ctrl+Shift',
    'Command+H',
    'Option+H',
    'AltGr+H',
    'Ctrl+Alt+F25',
    'Ctrl+Alt+F0',
    'Ctrl+Alt+Capslock',
    'Ctrl+Alt+VolumeUp',
    'Ctrl+Alt+中',
    'Ctrl+Alt+Ｈ',
    'Ctrl+Alt+HH',
    'Ctrl+Alt+H\n',
  ])('写法不对：%j', (input) => {
    expect(parseAccelerator(input)).toBeUndefined();
    expect(hideAllShortcutProblem(input)).toBe(zh.validation.acceleratorFormat);
  });

  // 普通对象继承来的属性名不能被当成按键或修饰键（#75 审查）
  it.each([
    'Ctrl+__proto__',
    'Ctrl+constructor',
    'Ctrl+toString',
    'Ctrl+hasOwnProperty',
    'Ctrl+valueOf',
    '__proto__+H',
    'constructor+H',
    'Ctrl+__proto__+H',
    'Ctrl+constructor+H',
    'toString+Ctrl+H',
  ])('对象原型上的名字不是合法的按键或修饰键：%s', (input) => {
    expect(parseAccelerator(input)).toBeUndefined();
    expect(normalizeAccelerator(input)).toBeUndefined();
    expect(hideAllShortcutProblem(input)).toBe(zh.validation.acceleratorFormat);
  });

  it.each(['H', 'F5', 'Shift+H', 'shift+Space'])(
    '%s 没有 Ctrl、Alt 或 Super，打字时会误触发',
    (input) => {
      expect(parseAccelerator(input)).toBeDefined();
      expect(hideAllShortcutProblem(input)).toBe(zh.validation.acceleratorNeedsModifier);
    },
  );

  it.each(['Ctrl+Shift+F10', 'shift+control+f10', 'CmdOrCtrl+Shift+F10'])(
    '%s 和调试台的快捷键重复',
    (input) => {
      expect(hideAllShortcutProblem(input)).toBe(zh.validation.acceleratorReserved);
    },
  );
});
