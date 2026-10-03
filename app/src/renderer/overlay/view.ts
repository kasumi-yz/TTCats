import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { CatPlacement, ContentCatalog, StageCore } from '../../shared/core-api';
import type { OverlayBridge, Unsubscribe } from '../../shared/ipc';
import { OVERLAY_TIMING } from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import { ClipCache } from './cache';
import { hitCat } from './coordinates';
import { ClipMedia } from './media';
import { createPhotoAnimation } from './photo';
import { OverlayAudio } from './audio';

interface CatView {
  cache: ClipCache<ClipMedia>;
  sprite: Sprite;
  current?: ClipMedia;
  key?: string;
  wanted?: string;
  placement?: CatPlacement;
  // 镜像相对素材的原始朝向计算，等待新素材时必须沿用当前画面的值。
  shownMirrored: boolean;
  generation: number;
}

export async function createOverlayView(
  content: ContentCatalog,
  stage: StageCore,
  bridge: OverlayBridge,
) {
  const errors: string[] = [];
  const failed = (error: unknown): void => {
    errors.push(String(error));
    console.error(error);
  };
  const audio = new OverlayAudio(failed);
  const unsubscribe: Unsubscribe[] = [
    bridge.onSnapshot((snapshot) => {
      stage.applySnapshot(snapshot, Date.now());
      audio.applySnapshot(snapshot);
    }),
    bridge.onStageCommand((command) => {
      stage.handleCommand(command, Date.now());
    }),
  ];
  const app = new Application();
  try {
    const current = await bridge.getSnapshot();
    stage.applySnapshot(current, Date.now());
    audio.applySnapshot(current);
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio,
      autoDensity: true,
      preference: 'webgl',
      powerPreference: 'low-power',
    });
  } catch (error) {
    audio.dispose();
    unsubscribe.forEach((off) => {
      off();
    });
    throw error;
  }
  document.body.append(app.canvas);
  app.ticker.maxFPS = 30;
  const photo = createPhotoAnimation();
  const cats = new Map<string, CatView>();
  let drawnOrder: string[] = [];
  const decorations = new Container();
  const bubbles = new Map<
    string,
    { container: Container; text: Text; background: Graphics; value: string }
  >();
  const effects = new Map<number, { graphics: Graphics; effect: string }>();
  app.stage.addChild(decorations);
  let paused = false;
  let ghost = false;
  let debug = false;
  let lastDebug = 0;
  let dragging: number | undefined;
  let pointer = { x: -1, y: -1 };
  let disposed = false;
  let drew = 0;
  const makeCat = (cat: string): CatView => {
    const sprite = new Sprite();
    sprite.visible = false;
    app.stage.addChild(sprite);
    return {
      sprite,
      shownMirrored: false,
      generation: 0,
      cache: new ClipCache(async (key) => {
        const clip = content.cats[cat]?.clips.find((c) => `${c.name}:${c.variant}` === key);
        if (!clip) throw new Error(zh.overlay.missingClip(cat, key));
        return ClipMedia.load(cat, clip);
      }),
    };
  };
  const hit = (point = pointer, includeGhost = false): string | null => {
    if (!includeGhost && ghost && dragging === undefined) return null;
    for (let i = drawnOrder.length - 1; i >= 0; i--) {
      const cat = drawnOrder[i];
      const view = cat === undefined ? undefined : cats.get(cat);
      if (!view) continue;
      const media = view.current;
      const p = view.placement;
      if (
        media &&
        p &&
        view.sprite.visible &&
        hitCat(point, { ...p, mirrored: view.shownMirrored }, media.clip, media.mask, media.frame)
      )
        return cat ?? null;
    }
    return null;
  };
  let lastHover: boolean | undefined;
  const renew = (force = true): void => {
    if (paused && debug && Date.now() - lastDebug >= 500) {
      lastDebug = Date.now();
      bridge.sendOverlay({
        type: 'stageDebug',
        report: { ...stage.debugReport(lastDebug), audio: audio.inspect() },
      });
    }
    const onCat = !paused && hit() !== null;
    if (force || onCat !== lastHover) {
      bridge.sendOverlay({ type: 'hover', onCat });
      lastHover = onCat;
    }
  };
  const cancel = (): void => {
    stage.handlePointer({ type: 'cancel' }, Date.now());
    const capture = dragging;
    dragging = undefined;
    if (capture !== undefined && app.canvas.hasPointerCapture(capture))
      app.canvas.releasePointerCapture(capture);
    bridge.sendOverlay({ type: 'drag', active: false });
    bridge.sendOverlay({ type: 'hover', onCat: false });
    lastHover = false;
  };
  const abort = new AbortController();
  const eventOptions = { signal: abort.signal };
  window.addEventListener(
    'mousemove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!paused) stage.handlePointer({ type: 'move', ...pointer, cat: hit() }, Date.now());
      renew(false);
    },
    eventOptions,
  );
  app.canvas.addEventListener(
    'pointerdown',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      const cat = hit();
      if (event.button !== 0 || !cat || paused || ghost) return;
      stage.handlePointer({ type: 'down', ...pointer, cat }, Date.now());
      dragging = event.pointerId;
      app.canvas.setPointerCapture(event.pointerId);
      bridge.sendOverlay({ type: 'drag', active: true });
    },
    eventOptions,
  );
  app.canvas.addEventListener(
    'pointerup',
    (event) => {
      if (event.pointerId !== dragging) return;
      pointer = { x: event.clientX, y: event.clientY };
      stage.handlePointer({ type: 'up', ...pointer }, Date.now());
      const capture = dragging;
      dragging = undefined;
      if (app.canvas.hasPointerCapture(capture)) app.canvas.releasePointerCapture(capture);
      bridge.sendOverlay({ type: 'drag', active: false });
      bridge.sendOverlay({ type: 'hover', onCat: false });
      lastHover = false;
    },
    eventOptions,
  );
  app.canvas.addEventListener('pointercancel', cancel, eventOptions);
  app.canvas.addEventListener(
    'lostpointercapture',
    () => {
      if (dragging !== undefined) cancel();
    },
    eventOptions,
  );
  app.canvas.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      pointer = { x: event.clientX, y: event.clientY };
      const cat = hit();
      if (cat && !paused && !ghost) bridge.sendOverlay({ type: 'catMenu', cat });
    },
    eventOptions,
  );
  window.addEventListener(
    'resize',
    () => {
      stage.setBounds({ width: innerWidth, height: innerHeight }, Date.now());
    },
    eventOptions,
  );

  const draw = (): void => {
    if (disposed || paused) return;
    const now = Date.now();
    const frame = stage.update(now);
    audio.update(frame);
    drawnOrder = frame.cats.map((p) => p.cat);
    const visible = new Set(frame.cats.map((p) => p.cat));
    for (const [cat, view] of cats) {
      if (!visible.has(cat)) {
        view.generation++;
        view.cache.dispose();
        view.sprite.destroy();
        cats.delete(cat);
      }
    }
    for (const p of frame.cats) {
      let view = cats.get(p.cat);
      if (!view) {
        view = makeCat(p.cat);
        cats.set(p.cat, view);
      }
      view.placement = p;
      const key = `${p.clip}:${p.variant}`;
      if (key !== view.wanted) {
        view.wanted = key;
        const generation = ++view.generation;
        view.current?.freezeForPose(p.pose);
        const target = view;
        void view.cache
          .request(key)
          .then((media) => {
            if (disposed || generation !== target.generation) return;
            target.current?.video.pause();
            target.current = media;
            target.key = key;
            target.cache.activate(key);
            if (target.placement) {
              target.shownMirrored = target.placement.mirrored;
              const scale = target.placement.scale;
              target.sprite.scale.set(target.shownMirrored ? -scale : scale, scale);
            }
            const anchor = media.clip.footAnchors[media.frame];
            if (anchor) target.sprite.pivot.set(anchor.x, anchor.y);
            target.sprite.texture = media.texture;
            target.sprite.visible = true;
            if (!paused && target.placement)
              media.sync(target.placement.clipTimeMs, target.placement.playbackRate);
          })
          .catch(failed);
      }
      const media = view.current;
      if (!media) continue;
      if (key === view.key) {
        view.shownMirrored = p.mirrored;
        media.sync(p.clipTimeMs, p.playbackRate);
      }
      const anchor = media.clip.footAnchors[media.frame];
      if (anchor) view.sprite.pivot.set(anchor.x, anchor.y);
      view.sprite.position.set(p.x, p.y);
      view.sprite.scale.set(view.shownMirrored ? -p.scale : p.scale, p.scale);
      view.sprite.alpha = ghost ? 0.35 : 1;
      app.stage.setChildIndex(view.sprite, app.stage.children.length - 1);
    }
    app.stage.setChildIndex(decorations, app.stage.children.length - 1);
    const bubbleCats = new Set(frame.bubbles.map((bubble) => bubble.cat));
    for (const [cat, bubble] of bubbles) {
      if (!bubbleCats.has(cat) || !cats.has(cat)) {
        bubble.container.destroy({ children: true });
        bubbles.delete(cat);
      }
    }
    for (const bubble of frame.bubbles) {
      const view = cats.get(bubble.cat);
      const p = view?.placement;
      const anchor = view?.current?.clip.footAnchors[view.current.frame];
      if (!p || !anchor) continue;
      let shown = bubbles.get(bubble.cat);
      if (!shown) {
        const container = new Container();
        const background = new Graphics();
        const text = new Text({
          text: bubble.text,
          style: { fontFamily: 'sans-serif', fontSize: 16, fill: 0x333333 },
        });
        text.anchor.set(0.5, 1);
        text.position.set(0, -6);
        container.addChild(background, text);
        decorations.addChild(container);
        shown = { container, background, text, value: '' };
        bubbles.set(bubble.cat, shown);
      }
      if (shown.value !== bubble.text) {
        shown.text.text = bubble.text;
        shown.value = bubble.text;
        const width = shown.text.width + 16;
        const height = shown.text.height + 12;
        shown.background
          .clear()
          .roundRect(-width / 2, -height, width, height, 8)
          .fill({ color: 0xffffff, alpha: 0.95 });
      }
      shown.container.position.set(p.x, p.y - anchor.y * p.scale - 8);
      shown.container.alpha = Math.min(1, bubble.ageMs / 150);
    }
    const effectIds = new Set(frame.effects.map((effect) => effect.id));
    for (const [id, effect] of effects) {
      if (!effectIds.has(id)) {
        effect.graphics.destroy();
        effects.delete(id);
      }
    }
    for (const effect of frame.effects) {
      let shown = effects.get(effect.id);
      if (shown && shown.effect !== effect.effect) {
        shown.graphics.destroy();
        shown = undefined;
      }
      if (!shown) {
        const graphics = new Graphics();
        if (effect.effect === 'hearts') {
          graphics
            .moveTo(0, 5)
            .bezierCurveTo(-18, -7, -8, -18, 0, -10)
            .bezierCurveTo(8, -18, 18, -7, 0, 5)
            .fill(0xff769e);
        } else {
          graphics.circle(-8, 0, 12).circle(8, 2, 14).circle(0, -10, 11).fill(0xeeeeee);
        }
        decorations.addChild(graphics);
        shown = { graphics, effect: effect.effect };
        effects.set(effect.id, shown);
      }
      const graphics = shown.graphics;
      const age = effect.ageMs / (effect.effect === 'cut' ? 300 : 1200);
      graphics.position.set(effect.x, effect.y - age * 35);
      graphics.alpha = Math.max(0, 1 - age);
      graphics.scale.set(1 + age);
      decorations.addChild(graphics);
    }
    for (const fact of stage.drainFacts()) bridge.sendFact(fact);
    if (debug && now - lastDebug >= 500) {
      bridge.sendOverlay({
        type: 'stageDebug',
        report: { ...stage.debugReport(now), audio: audio.inspect() },
      });
      lastDebug = now;
    }
    drew++;
  };
  app.ticker.add(draw);
  unsubscribe.push(
    bridge.onOverlay((message) => {
      if (message.type === 'photo' && !paused) photo.play(message);
      if (message.type === 'clickThrough' && !paused) {
        stage.handlePointer({ ...message, cat: hit(message, true) }, Date.now());
      }
      if (message.type === 'ghost') {
        ghost = message.active;
        stage.setGhostMode(ghost, Date.now());
        renew();
      }
      if (message.type === 'dragCancel') cancel();
      if (message.type === 'stageDebug') debug = message.enabled;
      if (message.type === 'paused') {
        if (paused && !message.paused) audio.update(stage.update(Date.now()));
        paused = message.paused;
        audio.setPaused(paused);
        if (paused) {
          photo.clear();
          cancel();
          app.stop();
          for (const view of cats.values()) view.current?.video.pause();
        } else {
          app.start();
        }
        renew();
      }
    }),
  );
  const timer = setInterval(renew, OVERLAY_TIMING.hoverRenewMs);
  return {
    app,
    inspect: () => ({
      drew,
      paused,
      ghost,
      dragging: dragging !== undefined,
      errors,
      audio: audio.inspect(),
      cats: [...cats.entries()].map(([cat, view]) => ({
        cat,
        ...view.placement,
        frame: view.current?.frame,
        current: view.key,
        wanted: view.wanted,
        cache: view.cache.keys(),
        visible: view.sprite.visible,
        videoTime: view.current?.video.currentTime,
      })),
    }),
    dispose(): void {
      disposed = true;
      photo.clear();
      audio.dispose();
      abort.abort();
      clearInterval(timer);
      unsubscribe.forEach((off) => {
        off();
      });
      for (const view of cats.values()) view.cache.dispose();
      app.destroy(true, { children: true });
    },
  };
}
