import type { OverlayBridge } from '../../shared/ipc';
import type { StageFrame } from '../../shared/core-api';
import { createOverlayView } from './view';
import { createTestDriver } from './test-driver';
import { createStageCore } from '../../core/stage';
const bridge = (window as Window & { ttcats?: OverlayBridge }).ttcats;
if (!bridge) throw new Error('ttcats preload');
const [content, snapshot] = await Promise.all([bridge.getContent(), bridge.getSnapshot()]);
const stage =
  new URLSearchParams(window.location.search).get('driver') === 'stage'
    ? createStageCore({
        content,
        snapshot,
        bounds: { width: innerWidth, height: innerHeight },
        now: Date.now(),
        random: Math.random,
      })
    : createTestDriver(content, snapshot);
const update = stage.update.bind(stage);
let decorations: Pick<StageFrame, 'bubbles' | 'effects'> | undefined;
stage.update = (now) => ({ ...update(now), ...decorations });
const view = await createOverlayView(content, stage, bridge);
declare global {
  interface Window {
    overlayTest: typeof view;
    overlayTestDecorations: (next: typeof decorations) => void;
  }
}
window.overlayTest = view;
window.overlayTestDecorations = (next) => {
  decorations = next;
};
window.addEventListener(
  'pagehide',
  () => {
    view.dispose();
  },
  { once: true },
);
