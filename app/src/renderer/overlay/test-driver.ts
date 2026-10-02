// 固定位置的窗口与输入链路验收驱动；正式入口与默认性能测量不使用。
import type { ContentCatalog, StageCore, CatPlacement } from '../../shared/core-api';
import type { Fact, StateSnapshot } from '../../shared/ipc';
import type { Clip } from '../../shared/schemas';

export function createTestDriver(content: ContentCatalog, initial: StateSnapshot): StageCore {
  let snapshot = initial;
  let bounds = { width: innerWidth, height: innerHeight };
  let ghost = false;
  let dragging: string | undefined;
  const facts: Fact[] = [];
  const states = new Map<
    string,
    { clip: Clip; at: number; x: number; y: number; fixed: boolean }
  >();
  const first = (cat: string, name: string): Clip => {
    const clip = content.cats[cat]?.clips.find((c) => c.name === name);
    if (!clip) throw new Error(cat + ':' + name);
    return clip;
  };
  Object.keys(content.cats).forEach((cat, i) =>
    states.set(cat, {
      clip: first(cat, 'idle-stand'),
      at: Date.now(),
      x: bounds.width * (0.35 + i * 0.15),
      y: bounds.height - 25,
      fixed: false,
    }),
  );
  return {
    applySnapshot(next) {
      snapshot = next;
    },
    setBounds(next) {
      bounds = next;
    },
    setGhostMode(active) {
      ghost = active;
    },
    handleCommand(command, now) {
      if (command.type !== 'debug/playClip') return;
      const state = states.get(command.cat);
      if (state) {
        state.clip = first(command.cat, command.clip);
        state.at = now;
        state.fixed = true;
      }
    },
    handlePointer(input, now) {
      if (input.type === 'down' && input.cat && !ghost) {
        dragging = input.cat;
        facts.push({ type: 'cat/pickedUp', cat: input.cat, at: now });
      }
      if (input.type === 'move' && dragging) {
        const state = states.get(dragging);
        if (state) {
          state.x = input.x;
          state.y = input.y + 45;
        }
      }
      if ((input.type === 'up' || input.type === 'cancel') && dragging) {
        facts.push({ type: 'cat/dropped', cat: dragging, at: now });
        dragging = undefined;
      }
    },
    update(now) {
      const cats: CatPlacement[] = [];
      for (const [cat, state] of states) {
        if (!snapshot.settings.visibleCats.includes(cat)) continue;
        if (!state.fixed && now - state.at >= 4000) {
          const clips = content.cats[cat]?.clips ?? [];
          const next = clips[(clips.indexOf(state.clip) + 1) % clips.length];
          if (next) state.clip = next;
          state.at = now;
        }
        const duration = (state.clip.frameCount / state.clip.fps) * 1000;
        cats.push({
          cat,
          clip: state.clip.name,
          variant: state.clip.variant,
          clipTimeMs:
            state.clip.kind === 'loop'
              ? (now - state.at) % duration
              : Math.min(now - state.at, duration),
          playbackRate: 1,
          x: state.x,
          y: state.y,
          scale: 1.5,
          mirrored: false,
          depth: cats.length,
          pose: state.clip.fromPose,
        });
      }
      return { cats, bubbles: [], effects: [] };
    },
    drainFacts() {
      return facts.splice(0);
    },
    debugReport(now) {
      return { at: now, cats: [] };
    },
  };
}
