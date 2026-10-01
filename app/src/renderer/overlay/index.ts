import { createStageCore } from '../../core/stage';
import type { OverlayBridge } from '../../shared/ipc';
import { createOverlayView } from './view';
import { zh } from '../../shared/strings.zh-CN';

const bridge = (window as Window & { ttcats?: OverlayBridge }).ttcats;
if (!bridge) throw new Error(zh.overlay.bridgeMissing);
const [content, snapshot] = await Promise.all([bridge.getContent(), bridge.getSnapshot()]);
const stage = createStageCore({
  content,
  snapshot,
  bounds: { width: innerWidth, height: innerHeight },
  now: Date.now(),
  random: Math.random,
});
const view = await createOverlayView(content, stage, bridge);
window.addEventListener(
  'pagehide',
  () => {
    view.dispose();
  },
  { once: true },
);
