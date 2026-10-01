import { mkdirSync, writeFileSync } from 'node:fs';
import { app } from 'electron';
import { computeLedges } from '../ledge';
import {
  enumerateWindows,
  prepareWindowTest,
  usePhysicalCoordinates,
  applicationTargets,
} from './platform/win/windows';
import { monitors } from './platform/win/overlay';

async function main() {
  usePhysicalCoordinates();
  const windows = enumerateWindows(monitors());
  const targets = applicationTargets(windows);
  const results = [];
  for (const [name, window] of targets) {
    if (!window) throw new Error(`没有找到${name}的真实窗口。`);
    const test = prepareWindowTest(window.id);
    try {
      test.move(100, 100);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const a = enumerateWindows(monitors()).find((w) => w.id === window.id);
      test.move(280, 140);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const b = enumerateWindows(monitors()).find((w) => w.id === window.id);
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
        throw new Error(`${name}的窗口顶边或读取到的矩形扣除失败。`);
      test.maximize();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const maximized = enumerateWindows(monitors()).find((w) => w.id === window.id);
      if (!maximized?.maximized || maximized.eligible)
        throw new Error(`${name}的最大化状态识别失败。`);
      results.push({
        name,
        className: b.className,
        dpi: b.dpi,
        windowDpi: b.windowDpi,
        identityConfirmed: name === '设置' ? ['设置', 'Settings'].includes(b.title) : true,
        maximized: { recognized: maximized.maximized, eligible: maximized.eligible },
        buttonsPositionVerified: false,
        buttonsFallback: b.buttonsFallback,
        movement: { dx: b.bounds.left - a.bounds.left, dy: b.bounds.top - a.bounds.top },
        bounds: b.bounds,
        ledges,
      });
      console.log(`${name}：边界跟随、最大化识别与矩形扣除通过；实际按钮位置未验证`);
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
app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
