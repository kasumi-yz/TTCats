import type { MainToOverlay } from '../../shared/ipc';

/** 纯视觉反馈；不参与猫的点击遮罩或鼠标租约。 */
export function createPhotoAnimation() {
  let current: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    clearTimeout(timer);
    current?.remove();
    current = undefined;
  };
  return {
    clear,
    play(message: Extract<MainToOverlay, { type: 'photo' }>): void {
      clear();
      const layer = document.createElement('div');
      layer.dataset['photo'] = '';
      Object.assign(layer.style, {
        position: 'fixed',
        inset: '0',
        pointerEvents: 'none',
        overflow: 'hidden',
      });
      const flash = document.createElement('div');
      Object.assign(flash.style, { position: 'absolute', inset: '0', background: 'white' });
      flash.animate([{ opacity: 0.65 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
      const image = document.createElement('img');
      image.src = message.thumbnail;
      const { area } = message;
      Object.assign(image.style, {
        position: 'absolute',
        left: `${area.x}px`,
        top: `${area.y}px`,
        width: `${area.width}px`,
        height: `${area.height}px`,
        transformOrigin: 'top left',
        boxShadow: '0 0 0 3px white, 0 8px 24px #0006',
      });
      const scale = Math.min(240 / area.width, 160 / area.height, 0.3);
      const transform = `translate(${innerWidth - area.width * scale - 24 - area.x}px, ${24 - area.y}px) scale(${scale})`;
      image.animate(
        [
          { transform: 'none', opacity: 0, offset: 0 },
          { transform: 'none', opacity: 0.9, offset: 0.12 },
          { transform, opacity: 1, offset: 0.55 },
          { transform, opacity: 1, offset: 0.8 },
          { transform, opacity: 0, offset: 1 },
        ],
        { duration: 1500, easing: 'ease-out', fill: 'forwards' },
      );
      layer.append(image, flash);
      document.body.append(layer);
      current = layer;
      timer = setTimeout(clear, 1500);
    },
  };
}
