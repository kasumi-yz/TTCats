import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeLedges, movementSpeed, type WindowInfo } from './ledge';
const window = (
  id: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
  eligible = true,
): WindowInfo => ({
  id,
  pid: 1,
  title: id,
  className: '',
  bounds: { left, top, right, bottom },
  buttons: null,
  buttonsFallback: false,
  dpi: 96,
  eligible,
  reason: '',
  maximized: false,
  fullscreen: false,
});
test('窗口顶边不能出现在遮挡窗口或标题栏按钮下面', () => {
  const target = window('target', 0, 100, 1000, 500);
  target.buttons = { left: 850, right: 1000, top: 100, bottom: 140 };
  assert.deepEqual(computeLedges([window('above', 300, 0, 600, 200, false), target]), [
    { id: 'target', left: 0, right: 300, y: 100 },
    { id: 'target', left: 600, right: 850, y: 100 },
  ]);
});
test('多重遮挡、完全遮挡和负坐标不产生假的窗口顶边', () => {
  assert.deepEqual(
    computeLedges([
      window('a', -300, 0, 100, 200, false),
      window('b', 50, 50, 400, 250, false),
      window('c', -200, 100, 300, 500),
    ]),
    [],
  );
});
test('下层窗口和恰好结束在顶边的窗口不挡住窗口顶边', () => {
  assert.deepEqual(
    computeLedges([
      window('a', 0, 0, 100, 100, false),
      window('b', 0, 100, 100, 200),
      window('c', 0, 80, 100, 300, false),
    ]),
    [{ id: 'b', left: 0, right: 100, y: 100 }],
  );
});
for (const scale of [1, 1.25, 1.5])
  test(`快速拖动阈值在 ${scale * 100}% DPI 下保持一致`, () => {
    const a = { left: -100, top: 20, right: 300, bottom: 400 };
    const b = { ...a, left: a.left + 100 * scale };
    assert.equal(movementSpeed(a, b, 100, 96 * scale), 1000);
  });
