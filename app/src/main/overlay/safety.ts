import { OVERLAY_TIMING, type OverlayToMain } from '../../shared/ipc';

export interface SafetyInput {
  now: number;
  inside: boolean;
  leftDown: boolean;
  ctrlDown: boolean;
  paused: boolean;
}

/** 主进程租约兜底；渲染进程挂起也不能占住用户的鼠标。 */
export class OverlaySafety {
  private leaseUntil = 0;
  private dragging = false;
  private releasedAt: number | undefined;
  private ghostUntil = 0;
  private ctrlWasDown = false;

  receive(message: OverlayToMain, input: SafetyInput): void {
    if (message.type === 'hover') {
      this.leaseUntil = message.onCat && input.inside ? input.now + OVERLAY_TIMING.hoverLeaseMs : 0;
    }
    if (message.type === 'drag') {
      this.dragging =
        message.active &&
        input.leftDown &&
        !input.paused &&
        (this.dragging || (input.inside && !this.ghost(input)));
      this.releasedAt = undefined;
      if (!this.dragging) this.leaseUntil = 0;
    }
  }

  private ghost(input: SafetyInput): boolean {
    return input.ctrlDown || input.now < this.ghostUntil;
  }

  poll(input: SafetyInput): { ignore: boolean; ghost: boolean; cancel: boolean } {
    if (this.ctrlWasDown && !input.ctrlDown)
      this.ghostUntil = input.now + OVERLAY_TIMING.ghostHoldMs;
    this.ctrlWasDown = input.ctrlDown;
    let cancel = false;
    if (this.dragging) {
      if (input.leftDown) this.releasedAt = undefined;
      else this.releasedAt ??= input.now;
      if (
        input.paused ||
        (this.releasedAt !== undefined &&
          input.now - this.releasedAt >= OVERLAY_TIMING.dragReleaseGraceMs)
      ) {
        this.dragging = false;
        this.leaseUntil = 0;
        this.releasedAt = undefined;
        cancel = true;
      }
    }
    const ghost = this.ghost(input);
    return {
      ignore:
        input.paused ||
        (!this.dragging && (ghost || !input.inside || input.now >= this.leaseUntil)),
      ghost,
      cancel,
    };
  }
}
