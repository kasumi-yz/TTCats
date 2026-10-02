import { useState } from 'react';

/**
 * 只对当前快照版本有效的本地显示草稿：拖动滑块、改时刻时先显示用户刚选的值，
 * 等主进程推来新版本的快照后改用主进程的值（存档状态以主进程为准）。
 */
function useDraft<T>(revision: number, confirmed: T): [T, (value: T) => void] {
  const [draft, setDraft] = useState<{ revision: number; value: T }>();
  const shown = draft?.revision === revision ? draft.value : confirmed;
  return [
    shown,
    (value) => {
      setDraft({ revision, value });
    },
  ];
}

/** 0～1 之间（或别的范围）的设置，用百分比滑块显示。 */
export function PercentSlider({
  label,
  revision,
  value,
  min = 0,
  max = 1,
  disabled = false,
  onChange,
}: {
  label: string;
  revision: number;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [shown, setShown] = useDraft(revision, value);
  return (
    <label className="field">
      {label}
      <span>{Math.round(shown * 100)}%</span>
      <input
        aria-label={label}
        type="range"
        min={String(min * 100)}
        max={String(max * 100)}
        step="1"
        disabled={disabled}
        value={Math.round(shown * 100)}
        onChange={(event) => {
          const next = Number(event.target.value) / 100;
          setShown(next);
          onChange(next);
        }}
      />
    </label>
  );
}

/** HH:MM 时刻（24 小时制）。没填完整时不发送。 */
export function TimeField({
  label,
  revision,
  value,
  onChange,
}: {
  label: string;
  revision: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useDraft(revision, value);
  return (
    <label className="time">
      {label}
      <input
        type="time"
        step="60"
        value={shown}
        onChange={(event) => {
          const next = event.target.value;
          if (!/^\d{2}:\d{2}$/.test(next)) return;
          setShown(next);
          onChange(next);
        }}
      />
    </label>
  );
}

/** 开关（复选框）。只发命令，显示值以快照为准。 */
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {label}
    </label>
  );
}
