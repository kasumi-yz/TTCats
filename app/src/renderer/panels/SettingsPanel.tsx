import { useState } from 'react';
import type { ContentCatalog } from '../../shared/core-api';
import { displayRefOf, findDisplay } from '../../shared/display';
import type { AppStatus, StateSnapshot, ToMainCommand } from '../../shared/ipc';
import { DoNotDisturbDurationSchema } from '../../shared/schemas/do-not-disturb';
import { ActivityLevelSchema, type Settings } from '../../shared/schemas/settings';
import { zh } from '../../shared/strings.zh-CN';
import { PercentSlider, TimeField, Toggle } from './controls';
import { canCheckUpdate, doNotDisturbText, updateText } from './format';
import { ShortcutField } from './ShortcutField';

const text = zh.panels;

const TABS = ['cats', 'sound', 'quiet', 'display', 'app'] as const;
type Tab = (typeof TABS)[number];

type SettingsProps = {
  snapshot: StateSnapshot;
  content: ContentCatalog;
  status: AppStatus | undefined;
  send: (command: ToMainCommand) => void;
};

/** 设置窗口：按分组用标签页切换，窗口不会太长；底部固定放"导出诊断信息"。 */
export function SettingsPanel(props: SettingsProps) {
  const [tab, setTab] = useState<Tab>('cats');
  return (
    <>
      <nav className="tabs" role="tablist" aria-label={text.settingsTabs}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`tab-${name}`}
            aria-selected={tab === name}
            aria-controls="settings-tabpanel"
            onClick={() => {
              setTab(name);
            }}
          >
            {text.tabs[name]}
          </button>
        ))}
      </nav>
      <section
        className="card"
        role="tabpanel"
        id="settings-tabpanel"
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'cats' && <CatsGroup {...props} />}
        {tab === 'sound' && <SoundGroup {...props} />}
        {tab === 'quiet' && <QuietGroup {...props} />}
        {tab === 'display' && <DisplayGroup {...props} />}
        {tab === 'app' && <AppGroup {...props} />}
      </section>
      <footer className="card footer">
        <button
          type="button"
          onClick={() => {
            props.send({ type: 'diagnostics/export' });
          }}
        >
          {text.exportDiagnostics}
        </button>
        <p className="muted">{text.exportDiagnosticsHelp}</p>
      </footer>
    </>
  );
}

function updater(send: SettingsProps['send']) {
  return (patch: Partial<Settings>) => {
    send({ type: 'settings/update', patch });
  };
}

function CatsGroup({ snapshot, content, send }: SettingsProps) {
  const settings = snapshot.settings;
  const update = updater(send);
  const cats = Object.values(content.cats);
  return (
    <>
      <fieldset>
        <legend>{text.visibleCats}</legend>
        {cats.length === 0 && <p>{text.noCats}</p>}
        {cats.map(({ cat }) => (
          <Toggle
            key={cat.id}
            label={cat.name}
            checked={settings.visibleCats.includes(cat.id)}
            onChange={(visible) => {
              send({ type: 'cat/setVisible', cat: cat.id, visible });
            }}
          />
        ))}
      </fieldset>
      <label className="field">
        {text.activityLevel}
        <select
          value={settings.activityLevel}
          onChange={(event) => {
            update({ activityLevel: ActivityLevelSchema.parse(event.target.value) });
          }}
        >
          {ActivityLevelSchema.options.map((level) => (
            <option key={level} value={level}>
              {text.activityLevels[level]}
            </option>
          ))}
        </select>
      </label>
      <PercentSlider
        label={text.scale}
        revision={snapshot.revision}
        value={settings.scale}
        min={0.5}
        max={2}
        onChange={(scale) => {
          update({ scale });
        }}
      />
      <PercentSlider
        label={text.floorDepth}
        revision={snapshot.revision}
        value={settings.floorDepth}
        onChange={(floorDepth) => {
          update({ floorDepth });
        }}
      />
    </>
  );
}

function SoundGroup({ snapshot, send }: SettingsProps) {
  const settings = snapshot.settings;
  const update = updater(send);
  return (
    <>
      <Toggle
        label={text.purrEnabled}
        checked={settings.purrEnabled}
        onChange={(purrEnabled) => {
          update({ purrEnabled });
        }}
      />
      <PercentSlider
        label={text.purrVolume}
        revision={snapshot.revision}
        value={settings.purrVolume}
        disabled={!settings.purrEnabled}
        onChange={(purrVolume) => {
          update({ purrVolume });
        }}
      />
      <Toggle
        label={text.meowEnabled}
        checked={settings.meowEnabled}
        onChange={(meowEnabled) => {
          update({ meowEnabled });
        }}
      />
      <PercentSlider
        label={text.meowVolume}
        revision={snapshot.revision}
        value={settings.meowVolume}
        disabled={!settings.meowEnabled}
        onChange={(meowVolume) => {
          update({ meowVolume });
        }}
      />
      <fieldset>
        <legend>{text.quietHours}</legend>
        <div className="times">
          <TimeField
            label={text.quietHoursStart}
            revision={snapshot.revision}
            value={settings.quietHoursStart}
            onChange={(quietHoursStart) => {
              update({ quietHoursStart });
            }}
          />
          <TimeField
            label={text.quietHoursEnd}
            revision={snapshot.revision}
            value={settings.quietHoursEnd}
            onChange={(quietHoursEnd) => {
              update({ quietHoursEnd });
            }}
          />
        </div>
        <p className="muted">{text.quietHoursHelp}</p>
      </fieldset>
    </>
  );
}

function QuietGroup({ snapshot, status, send }: SettingsProps) {
  const dnd = snapshot.doNotDisturb;
  return (
    <>
      <fieldset>
        <legend>{text.doNotDisturb}</legend>
        <p className="muted">{text.doNotDisturbHelp}</p>
        <p role="status">{doNotDisturbText(dnd, snapshot.at)}</p>
        <DoNotDisturbButtons active={dnd.mode !== 'off'} send={send} />
      </fieldset>
      <fieldset>
        <legend>{text.hideAll}</legend>
        <ShortcutField
          value={snapshot.settings.hideAllShortcut}
          status={status}
          onChange={(hideAllShortcut) => {
            send({ type: 'settings/update', patch: { hideAllShortcut } });
          }}
        />
      </fieldset>
    </>
  );
}

/** 开始勿扰的四个时长；开着时显示"重新计时"和"结束勿扰"。设置窗口和调试台共用。 */
export function DoNotDisturbButtons({
  active,
  send,
}: {
  active: boolean;
  send: (command: ToMainCommand) => void;
}) {
  return (
    <div className="buttons">
      <span>{active ? text.doNotDisturbRestart : text.doNotDisturbStart}</span>
      {DoNotDisturbDurationSchema.options.map((duration) => (
        <button
          key={duration}
          type="button"
          onClick={() => {
            send({ type: 'doNotDisturb/start', duration });
          }}
        >
          {text.doNotDisturbDurations[duration]}
        </button>
      ))}
      {active && (
        <button
          type="button"
          onClick={() => {
            send({ type: 'doNotDisturb/end' });
          }}
        >
          {text.doNotDisturbEnd}
        </button>
      )}
    </div>
  );
}

const PRIMARY = 'primary';
const MISSING = 'missing';

function DisplayGroup({ snapshot, status, send }: SettingsProps) {
  const settings = snapshot.settings;
  const update = updater(send);
  return (
    <>
      {!status ? (
        <p>{text.statusUnavailable}</p>
      ) : status.displays.length <= 1 ? (
        <p>{text.singleDisplay}</p>
      ) : (
        <DisplaySelect status={status} settings={settings} update={update} />
      )}
      <Toggle
        label={text.capture}
        checked={settings.showInScreenCapture}
        onChange={(showInScreenCapture) => {
          update({ showInScreenCapture });
        }}
      />
      <p className="muted">{text.captureHelp}</p>
    </>
  );
}

function DisplaySelect({
  status,
  settings,
  update,
}: {
  status: AppStatus;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const chosen =
    settings.display === null ? undefined : findDisplay(settings.display, status.displays);
  const value = settings.display === null ? PRIMARY : chosen ? String(chosen.id) : MISSING;
  return (
    <>
      <label className="field">
        {text.display}
        <select
          value={value}
          onChange={(event) => {
            const picked = event.target.value;
            if (picked === PRIMARY) {
              update({ display: null });
              return;
            }
            const display = status.displays.find((item) => String(item.id) === picked);
            if (display) update({ display: displayRefOf(display) });
          }}
        >
          <option value={PRIMARY}>{text.primaryDisplay}</option>
          {status.displays.map((display, index) => (
            <option key={display.id} value={String(display.id)}>
              {text.displayName(index + 1, display.label)}（
              {text.displayDetail(display.width, display.height, display.scaleFactor)}）
              {display.primary ? text.displayIsPrimary : ''}
            </option>
          ))}
          {value === MISSING && (
            <option value={MISSING} disabled>
              {text.displayMissing}
            </option>
          )}
        </select>
      </label>
      {value === MISSING && <p className="muted">{text.displayMissingHelp}</p>}
    </>
  );
}

function AppGroup({ snapshot, status, send }: SettingsProps) {
  const settings = snapshot.settings;
  const update = updater(send);
  return (
    <>
      <Toggle
        label={text.launchAtLogin}
        checked={settings.launchAtLogin}
        onChange={(launchAtLogin) => {
          update({ launchAtLogin });
        }}
      />
      <p className="muted">{text.launchAtLoginHelp}</p>
      <Toggle
        label={text.autoUpdate}
        checked={settings.autoUpdate}
        onChange={(autoUpdate) => {
          update({ autoUpdate });
        }}
      />
      {!status ? (
        <p>{text.statusUnavailable}</p>
      ) : (
        <UpdateBlock status={status} now={snapshot.at} send={send} />
      )}
    </>
  );
}

/** 版本号、更新状态和更新按钮。设置窗口和调试台共用。 */
export function UpdateBlock({
  status,
  now,
  send,
}: {
  status: AppStatus;
  now: number;
  send: (command: ToMainCommand) => void;
}) {
  const update = status.update;
  return (
    <>
      <dl>
        <dt>{text.currentVersion}</dt>
        <dd>{status.version}</dd>
        <dt>{text.updateStatus}</dt>
        <dd role="status">{updateText(update, now)}</dd>
      </dl>
      {update.state === 'downloading' && (
        <progress aria-label={text.updateStatus} max={100} value={update.percent} />
      )}
      <div className="buttons">
        <button
          type="button"
          disabled={!canCheckUpdate(update)}
          onClick={() => {
            send({ type: 'update/check' });
          }}
        >
          {text.checkUpdate}
        </button>
        {update.state === 'downloaded' && (
          <button
            type="button"
            onClick={() => {
              send({ type: 'update/install' });
            }}
          >
            {text.installUpdate}
          </button>
        )}
      </div>
    </>
  );
}
