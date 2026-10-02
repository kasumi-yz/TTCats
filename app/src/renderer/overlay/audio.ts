import type { SoundCue, StageFrame } from '../../shared/core-api';
import type { StageDebugReport, StateSnapshot } from '../../shared/ipc';
import type { CatSound } from '../../shared/schemas';
import { contentUrl } from '../../shared/content-url';
import { zh } from '../../shared/strings.zh-CN';

type Start = Extract<SoundCue, { action: 'start' }>;
interface Voice {
  cue: Start;
  at: number;
  source?: AudioBufferSourceNode;
  gain?: GainNode;
}

/** 音频只由桌面层持有；没有播放时不留下运行中的 AudioContext。 */
export class OverlayAudio {
  private context: AudioContext | undefined;
  private transition = Promise.resolve();
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly voices = new Map<string, Voice>();
  private readonly sounding = new Set<Voice>();
  private snapshot: StateSnapshot | undefined;
  private visible = new Set<string>();
  private paused = false;
  private disposed = false;

  constructor(
    private readonly failed: (error: unknown) => void,
    private readonly createContext: () => AudioContext = () => new AudioContext(),
    private readonly read: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = () => performance.now(),
  ) {}

  applySnapshot(snapshot: StateSnapshot): void {
    if (this.snapshot && snapshot.revision <= this.snapshot.revision) return;
    this.snapshot = snapshot;
    this.reconcile();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) for (const [key, voice] of this.voices) this.stop(key, voice);
  }

  update(frame: StageFrame): void {
    this.visible = new Set(frame.cats.map((cat) => cat.cat));
    this.reconcile();
    for (const cue of frame.sounds) {
      const key = `${cue.cat}:${cue.sound}`;
      const previous = this.voices.get(key);
      if (previous) this.stop(key, previous);
      if (cue.action === 'start' && this.allowed(cue)) {
        const voice: Voice = { cue, at: this.now() };
        this.voices.set(key, voice);
        void this.start(key, voice);
      }
    }
  }

  inspect(): NonNullable<StageDebugReport['audio']> {
    return {
      playing: [...this.sounding].map(({ cue }) => ({ cat: cue.cat, sound: cue.sound })),
      suspended: !this.context || this.context.state !== 'running',
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const [key, voice] of this.voices) this.stop(key, voice, false);
    for (const voice of this.sounding) voice.source?.stop();
    this.buffers.clear();
    this.enqueue(async () => {
      await this.context?.close();
    });
  }

  private allowed(cue: Start): boolean {
    const snapshot = this.snapshot;
    return (
      !!snapshot &&
      !this.disposed &&
      !this.paused &&
      !snapshot.hideAll &&
      snapshot.silencedBy.length === 0 &&
      this.visible.has(cue.cat) &&
      snapshot.settings.visibleCats.includes(cue.cat) &&
      snapshot.settings[cue.sound === 'purr' ? 'purrEnabled' : 'meowEnabled'] &&
      this.volume(cue.sound) > 0
    );
  }

  private volume(sound: CatSound): number {
    return this.snapshot?.settings[sound === 'purr' ? 'purrVolume' : 'meowVolume'] ?? 0;
  }

  private reconcile(): void {
    for (const [key, voice] of this.voices) {
      if (!this.allowed(voice.cue)) this.stop(key, voice);
      else if (voice.gain && this.context)
        voice.gain.gain.setValueAtTime(this.volume(voice.cue.sound), this.context.currentTime);
    }
  }

  private enqueue(operation: () => Promise<void>, failed = this.failed): void {
    this.transition = this.transition.then(operation).catch(failed);
  }

  private idle(): void {
    this.enqueue(async () => {
      if (!this.disposed && this.sounding.size === 0 && this.context?.state === 'running')
        await this.context.suspend();
    });
  }

  private async start(key: string, voice: Voice): Promise<void> {
    try {
      if (!this.context) {
        this.context = this.createContext();
        this.idle();
      }
      const context = this.context;
      const url = contentUrl(voice.cue.cat, voice.cue.file);
      let buffer = this.buffers.get(url);
      if (!buffer) {
        buffer = this.read(url, { signal: AbortSignal.timeout(10_000) }).then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return context.decodeAudioData(await response.arrayBuffer());
        });
        this.buffers.set(url, buffer);
        void buffer.catch(() => {
          this.buffers.delete(url);
        });
      }
      const decoded = await buffer;
      this.enqueue(
        async () => {
          const valid = () =>
            this.voices.get(key) === voice &&
            this.allowed(voice.cue) &&
            this.now() - voice.at <= 1000;
          if (!valid()) {
            if (this.voices.get(key) === voice) this.voices.delete(key);
            return;
          }
          await context.resume();
          // resume、解码期间可能已经被隐藏或静音，不能让迟到的请求出声。
          if (!valid()) {
            if (this.voices.get(key) === voice) this.voices.delete(key);
            this.idle();
            return;
          }
          const source = context.createBufferSource();
          const gain = context.createGain();
          voice.source = source;
          voice.gain = gain;
          source.buffer = decoded;
          source.loop = voice.cue.sound === 'purr';
          gain.gain.setValueAtTime(this.volume(voice.cue.sound), context.currentTime);
          source.connect(gain);
          gain.connect(context.destination);
          source.onended = () => {
            source.disconnect();
            gain.disconnect();
            this.sounding.delete(voice);
            if (this.voices.get(key) === voice) this.voices.delete(key);
            this.idle();
          };
          this.sounding.add(voice);
          source.start();
        },
        (error: unknown) => {
          this.failVoice(key, voice, error);
        },
      );
    } catch (error) {
      this.failVoice(key, voice, error);
    }
  }

  private failVoice(key: string, voice: Voice, error: unknown): void {
    if (this.voices.get(key) === voice) this.voices.delete(key);
    voice.source?.disconnect();
    voice.gain?.disconnect();
    this.sounding.delete(voice);
    this.failed(
      new Error(zh.overlayAudio.failed(voice.cue.cat, voice.cue.file, String(error)), {
        cause: error,
      }),
    );
    this.idle();
  }

  private stop(key: string, voice: Voice, fade = true): void {
    this.voices.delete(key);
    if (!voice.source || !voice.gain || !this.context) return;
    const at = this.context.currentTime;
    if (fade && voice.cue.sound === 'purr') {
      voice.gain.gain.cancelScheduledValues(at);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
      voice.gain.gain.linearRampToValueAtTime(0, at + 0.15);
      voice.source.stop(at + 0.15);
    } else voice.source.stop();
  }
}
