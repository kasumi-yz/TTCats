import { Texture, VideoSource } from 'pixi.js';
import type { Clip, Pose } from '../../shared/schemas';
import { contentUrl } from '../../shared/content-url';
import { hitMaskLayout } from '../../shared/hitmask';
import { zh } from '../../shared/strings.zh-CN';

export class ClipMedia {
  frame = 0;
  private callback = 0;
  private disposed = false;
  private constructor(
    readonly clip: Clip,
    readonly video: HTMLVideoElement,
    readonly mask: Uint8Array,
    readonly texture: Texture,
  ) {
    const presented = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      if (this.disposed) return;
      this.frame = Math.min(clip.frameCount - 1, Math.floor(metadata.mediaTime * clip.fps + 0.001));
      texture.source.update();
      this.callback = video.requestVideoFrameCallback(presented);
    };
    this.callback = video.requestVideoFrameCallback(presented);
  }

  static async load(cat: string, clip: Clip): Promise<ClipMedia> {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = clip.kind === 'loop';
    video.crossOrigin = 'anonymous';
    const loaded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        finish(new Error(zh.overlay.loadFailed(cat, clip.video)));
      }, 10000);
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        if (error) reject(error);
        else resolve();
      };
      const ready = (): void => {
        finish();
      };
      const failed = (): void => {
        finish(new Error(zh.overlay.loadFailed(cat, clip.video)));
      };
      video.addEventListener('loadeddata', ready);
      video.addEventListener('error', failed);
    });
    video.src = contentUrl(cat, clip.video);
    video.load();
    try {
      const [response] = await Promise.all([fetch(contentUrl(cat, clip.hitMask)), loaded]);
      if (!response.ok) throw new Error(zh.overlay.loadFailed(cat, clip.hitMask));
      const mask = new Uint8Array(await response.arrayBuffer());
      if (mask.byteLength !== hitMaskLayout(clip).totalBytes)
        throw new Error(zh.overlay.badMask(cat, clip.hitMask));
      const source = new VideoSource({ resource: video, autoPlay: false });
      source.autoUpdate = false; // 只在实际呈现新视频帧时上传，避免另开无限帧率的 shared ticker。
      return new ClipMedia(clip, video, mask, new Texture({ source }));
    } catch (error) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      throw error;
    }
  }

  freezeForPose(pose: Pose): void {
    this.video.pause();
    const frame =
      this.clip.kind === 'transition' && pose === this.clip.fromPose ? 0 : this.clip.frameCount - 1;
    this.video.currentTime = frame / this.clip.fps;
  }

  sync(timeMs: number, rate: number): void {
    const duration = this.clip.frameCount / this.clip.fps;
    const target = Math.min(timeMs / 1000, duration - 1 / this.clip.fps);
    const drift = Math.abs(this.video.currentTime - target);
    const error = this.clip.kind === 'loop' ? Math.min(drift, Math.abs(duration - drift)) : drift;
    if (!this.video.seeking && error > 1 / this.clip.fps) this.video.currentTime = target;
    this.video.playbackRate = rate;
    if (this.video.paused && (this.clip.kind === 'loop' || target < duration - 1 / this.clip.fps))
      void this.video.play().catch(console.error);
  }

  dispose(): void {
    this.disposed = true;
    this.video.cancelVideoFrameCallback(this.callback);
    this.video.pause();
    this.texture.destroy(true);
    this.video.removeAttribute('src');
    this.video.load();
  }
}
