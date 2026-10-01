import type { OverlayBridge } from '../../shared/ipc';
import { createOverlayView } from './view';
import { createTestDriver } from './test-driver';
const bridge = (window as Window & { ttcats?: OverlayBridge }).ttcats;
if (!bridge) throw new Error('ttcats preload');
const [content, snapshot] = await Promise.all([bridge.getContent(), bridge.getSnapshot()]);
const view = await createOverlayView(content, createTestDriver(content, snapshot), bridge);
declare global {
  interface Window {
    overlayTest: typeof view;
  }
}
window.overlayTest = view;
window.addEventListener(
  'pagehide',
  () => {
    view.dispose();
  },
  { once: true },
);
