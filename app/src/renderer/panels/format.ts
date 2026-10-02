// 面板里给人看的时刻、状态说明。都按传进来的时刻算，不自己读当前时间。
import type { SilenceReason, UpdateStatus } from '../../shared/ipc';
import type { DoNotDisturb } from '../../shared/schemas/do-not-disturb';
import { zh } from '../../shared/strings.zh-CN';

const text = zh.panels;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时间的 HH:MM。 */
export function formatClock(time: number): string {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayNumber(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

/** 相对 now 显示某个时刻：当天只写 HH:MM，第二天写"明天 HH:MM"，再往后写完整日期。 */
export function formatMoment(time: number, now: number): string {
  const days = dayNumber(time) - dayNumber(now);
  if (days === 0) return formatClock(time);
  if (days === 1) return text.tomorrow(formatClock(time));
  return new Date(time).toLocaleString('zh-CN');
}

export function doNotDisturbText(state: DoNotDisturb, now: number): string {
  if (state.mode === 'off') return text.doNotDisturbOff;
  if (state.mode === 'untilOff') return text.doNotDisturbUntilOff;
  return text.doNotDisturbUntil(formatMoment(state.until, now));
}

export function silenceText(reasons: readonly SilenceReason[]): string {
  if (reasons.length === 0) return text.soundAllowed;
  return text.soundSilenced(
    reasons.map((reason) => text.silenceReasons[reason]).join(text.reasonSeparator),
  );
}

export function clockOffsetText(offsetMs: number): string {
  const totalMinutes = Math.round(offsetMs / 60_000);
  if (totalMinutes <= 0) return text.noClockOffset;
  return text.clockOffsetValue(
    Math.floor(totalMinutes / 1440),
    Math.floor((totalMinutes % 1440) / 60),
    totalMinutes % 60,
  );
}

export function updateText(status: UpdateStatus, now: number): string {
  const states = text.updateStates;
  switch (status.state) {
    case 'unsupported':
      return states.unsupported;
    case 'off':
      return states.off;
    case 'idle':
      return status.checkedAt === null
        ? states.neverChecked
        : states.upToDate(formatMoment(status.checkedAt, now));
    case 'checking':
      return states.checking;
    case 'downloading':
      return states.downloading(status.version, status.percent);
    case 'downloaded':
      return states.downloaded(status.version);
    case 'error':
      return states.error(status.message, formatMoment(status.at, now));
  }
}

/** 现在能不能点"检查更新"：开发版、正在检查或下载、已经下好时不能点。 */
export function canCheckUpdate(status: UpdateStatus): boolean {
  return status.state === 'off' || status.state === 'idle' || status.state === 'error';
}
