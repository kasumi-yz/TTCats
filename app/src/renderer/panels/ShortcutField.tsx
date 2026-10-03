import { useState } from 'react';
import { hideAllShortcutProblem, normalizeAccelerator } from '../../shared/accelerator';
import type { AppStatus } from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import { heldModifiers, readKeyPress } from './shortcut-keys';

const text = zh.panels;

/** 给人看的写法，比如 CommandOrControl+Alt+Shift+H → Ctrl+Alt+Shift+H。 */
function readable(accelerator: string): string {
  return normalizeAccelerator(accelerator) ?? accelerator;
}

/**
 * 一键隐藏快捷键：显示当前设置和注册结果，点按钮后按下新的组合键录入。
 * 格式不对时只在这里提示、不发命令；格式对了才发 settings/update，注册结果看 AppStatus。
 */
export function ShortcutField({
  value,
  status,
  onChange,
}: {
  value: string;
  status: AppStatus | undefined;
  onChange: (accelerator: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState<string[]>([]);
  const [problem, setProblem] = useState<string>();

  function stop() {
    setRecording(false);
    setPartial([]);
  }

  let registration: { message: string; failed: boolean } | undefined;
  if (status) {
    const { accelerator, registered } = status.hideAllShortcut;
    if (readable(accelerator) !== readable(value))
      registration = { message: text.shortcutPending, failed: false };
    else if (registered) registration = { message: text.shortcutRegistered, failed: false };
    else registration = { message: text.shortcutFailed(readable(accelerator)), failed: true };
  }

  return (
    <div className="field">
      <span>{text.hideAllShortcut}</span>
      <kbd aria-label={text.hideAllShortcut}>{readable(value)}</kbd>
      <button
        type="button"
        className={recording ? 'recording' : undefined}
        aria-pressed={recording}
        onClick={() => {
          setProblem(undefined);
          setRecording(true);
        }}
        onBlur={stop}
        onKeyDown={(event) => {
          if (!recording) return;
          event.preventDefault();
          const press = {
            code: event.code,
            key: event.key,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          };
          const held = heldModifiers(press);
          if ((event.code === 'Escape' || event.key === 'Escape') && held.length === 0) {
            stop();
            return;
          }
          const result = readKeyPress(press);
          if (result.kind === 'waiting') {
            setPartial(held);
            return;
          }
          stop();
          const found =
            result.accelerator === undefined
              ? zh.validation.acceleratorFormat
              : hideAllShortcutProblem(result.accelerator);
          setProblem(found);
          if (found === undefined && result.accelerator !== undefined) {
            if (readable(result.accelerator) !== readable(value)) onChange(result.accelerator);
          }
        }}
        onKeyUp={(event) => {
          if (recording)
            setPartial(
              heldModifiers({
                code: event.code,
                key: event.key,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
              }),
            );
        }}
      >
        {!recording
          ? text.recordShortcut
          : partial.length === 0
            ? text.recordingShortcut
            : text.recordingPartial(partial.join('+'))}
      </button>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {!problem && registration && (
        <p
          role={registration.failed ? 'alert' : 'status'}
          className={registration.failed ? 'error' : 'muted'}
        >
          {registration.message}
        </p>
      )}
      <p className="muted">{text.hideAllHelp}</p>
    </div>
  );
}
