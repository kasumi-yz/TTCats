import { mkdirSync, writeFileSync } from 'node:fs';
import { computeLedges } from '../ledge';
import {
  enumerateWindows,
  prepareWindowTest,
  usePhysicalCoordinates,
} from './platform/win/windows';

async function main() {
  usePhysicalCoordinates();
  const windows = enumerateWindows([]);
  const targets = [
    ['资源管理器', windows.find((w) => w.className === 'CabinetWClass')],
    ['Chrome', windows.find((w) => w.title.endsWith('Google Chrome'))],
    ['微信', windows.find((w) => w.className === 'Qt51514QWindowIcon')],
    ['VS Code', windows.find((w) => w.title.includes('Visual Studio Code'))],
    ['记事本', windows.find((w) => w.className === 'Notepad')],
    ['设置', windows.find((w) => w.className === 'ApplicationFrameWindow')],
  ] as const;
  const results = [];
  for (const [name, window] of targets) {
    if (!window) throw new Error(`没有找到${name}的真实窗口。`);
    const test = prepareWindowTest(window.id);
    try {
      test.move(100, 100);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const a = enumerateWindows([]).find((w) => w.id === window.id);
      test.move(280, 140);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const b = enumerateWindows([]).find((w) => w.id === window.id);
      if (!a || !b || !b.eligible) throw new Error(`${name}恢复后没有可用窗口。`);
      if (
        Math.abs(b.bounds.left - a.bounds.left - 180) > 2 ||
        Math.abs(b.bounds.top - a.bounds.top - 40) > 2
      )
        throw new Error(`${name}的真实边界没有跟随移动。`);
      const ledges = computeLedges([b]);
      if (
        !ledges.length ||
        ledges.some((l) => b.buttons && l.left < b.buttons.right && l.right > b.buttons.left)
      )
        throw new Error(`${name}的窗口顶边或按钮避让失败。`);
      results.push({
        name,
        className: b.className,
        dpi: b.dpi,
        buttonsFallback: b.buttonsFallback,
        movement: { dx: b.bounds.left - a.bounds.left, dy: b.bounds.top - a.bounds.top },
        bounds: b.bounds,
        ledges,
      });
      console.log(`${name}：窗口边界跟随与按钮避让计算通过`);
    } finally {
      test.restore();
    }
  }
  mkdirSync('results', { recursive: true });
  writeFileSync(
    'results/apps.json',
    JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
