import { describe, expect, it } from 'vitest';
import { chooseDisplay, displayRefOf, findDisplay, type DisplayInfo } from './display';

function display(overrides: Partial<DisplayInfo>): DisplayInfo {
  return {
    id: 1,
    label: 'BUILT-IN',
    width: 2880,
    height: 1800,
    scaleFactor: 1.5,
    primary: false,
    ...overrides,
  };
}

const laptop = display({ id: 1, label: 'BUILT-IN', primary: true });
const dell = display({ id: 2, label: 'DELL U3423WE', width: 3440, height: 1440, scaleFactor: 1 });

describe('认出设置里记住的显示器', () => {
  it('没设置时用主显示器', () => {
    expect(chooseDisplay(null, [dell, laptop])).toBe(laptop);
  });

  it('同一次运行里按 id 和型号名认出副屏', () => {
    expect(chooseDisplay(displayRefOf(dell), [laptop, dell])).toBe(dell);
  });

  it('重启后 id 变了，按型号名和分辨率认出来', () => {
    const renumbered = { ...dell, id: 99 };
    expect(findDisplay(displayRefOf(dell), [laptop, renumbered])).toBe(renumbered);
  });

  it('改了分辨率，型号名只有一块时也认得出来', () => {
    const resized = { ...dell, id: 99, width: 2560, height: 1080 };
    expect(findDisplay(displayRefOf(dell), [laptop, resized])).toBe(resized);
  });

  it('副屏拔掉后用主显示器，接回来以后又认出它', () => {
    const ref = displayRefOf(dell);
    expect(findDisplay(ref, [laptop])).toBeUndefined();
    expect(chooseDisplay(ref, [laptop])).toBe(laptop);
    const back = { ...dell, id: 7 };
    expect(chooseDisplay(ref, [laptop, back])).toBe(back);
  });

  it('不单凭 id 认：同一个 id 换成了别的显示器时不算', () => {
    const other = display({ id: 2, label: 'LG 27GL850', width: 2560, height: 1440 });
    expect(findDisplay(displayRefOf(dell), [laptop, other])).toBeUndefined();
    expect(chooseDisplay(displayRefOf(dell), [laptop, other])).toBe(laptop);
  });

  it('两块同型号、同分辨率的显示器在 id 变了以后分不清，用主显示器', () => {
    const a = { ...dell, id: 10 };
    const b = { ...dell, id: 11 };
    expect(findDisplay(displayRefOf(dell), [laptop, a, b])).toBeUndefined();
    expect(findDisplay(displayRefOf(dell), [laptop, a, { ...b, width: 1920 }])).toBe(a);
  });

  it('拿不到型号名的显示器只能按 id 认', () => {
    const remote = display({ id: 5, label: '', width: 1920, height: 1080 });
    expect(findDisplay(displayRefOf(remote), [laptop, remote])).toBe(remote);
    expect(findDisplay(displayRefOf(remote), [laptop, { ...remote, id: 6 }])).toBeUndefined();
  });

  it('列表里没有主显示器时返回 undefined，由调用方处理', () => {
    expect(chooseDisplay(null, [dell])).toBeUndefined();
  });
});
