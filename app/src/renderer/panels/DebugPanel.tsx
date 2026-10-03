import { useState } from 'react';
import { normalizeAccelerator } from '../../shared/accelerator';
import type { ContentCatalog } from '../../shared/core-api';
import type { AppStatus, StageDebugReport, StateSnapshot, ToMainCommand } from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import { clockOffsetText, doNotDisturbText, silenceText, updateText } from './format';
import { DoNotDisturbButtons } from './SettingsPanel';

const text = zh.panels;

const SIMULATIONS = ['poke', 'pet', 'pickUp', 'drop', 'nearbyClicks'] as const;
const SOUNDS = ['meow', 'purr'] as const;
/** debug/advanceClock 能快进的范围（分钟），见 ipc.ts。 */
const ADVANCE_MIN = 1;
const ADVANCE_MAX = 10080;

type DebugProps = {
  snapshot: StateSnapshot;
  content: ContentCatalog;
  status: AppStatus | undefined;
  report: StageDebugReport | undefined;
  send: (command: ToMainCommand) => void;
};

export function DebugPanel(props: DebugProps) {
  return (
    <>
      <CatControls {...props} />
      <StageControls {...props} />
      <AppCommands send={props.send} />
      <SavedState {...props} />
      <QuietState snapshot={props.snapshot} />
      <AppState status={props.status} now={props.snapshot.at} />
      <StageState report={props.report} content={props.content} />
      {props.content.disabled.length > 0 && (
        <section className="card">
          <h2>{text.disabledPacks}</h2>
          {props.content.disabled.map((pack) => (
            <div key={pack.cat}>
              <h3>{pack.cat}</h3>
              <ul>
                {pack.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function CommandButton({
  label,
  command,
  send,
  disabled = false,
  className,
}: {
  label: string;
  command: ToMainCommand | undefined;
  send: (command: ToMainCommand) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || !command}
      onClick={() => {
        if (command) send(command);
      }}
    >
      {label}
    </button>
  );
}

function CatControls({ content, send }: DebugProps) {
  const [chosenCat, setChosenCat] = useState('');
  const [chosenClip, setChosenClip] = useState('');
  const cats = Object.values(content.cats);
  const entry = content.cats[chosenCat] ?? cats[0];
  const cat = entry?.cat.id;
  const clips = entry?.clips ?? [];
  const clip = clips.find((item) => `${item.name}:${item.variant}` === chosenClip) ?? clips[0];
  return (
    <section className="card">
      <CommandButton label={text.summonAll} command={{ type: 'cat/summon' }} send={send} />
      <label className="field">
        {text.cat}
        <select
          value={cat ?? ''}
          disabled={!cat}
          onChange={(event) => {
            setChosenCat(event.target.value);
            setChosenClip('');
          }}
        >
          {cats.map((item) => (
            <option key={item.cat.id} value={item.cat.id}>
              {item.cat.name}
            </option>
          ))}
        </select>
      </label>
      {!cat && <p>{text.noCats}</p>}
      <div className="buttons">
        <CommandButton
          label={text.summon}
          command={cat ? { type: 'cat/summon', cat } : undefined}
          send={send}
        />
        <CommandButton
          label={text.sleep}
          command={cat ? { type: 'cat/sleep', cat } : undefined}
          send={send}
        />
        <CommandButton
          label={text.show}
          command={cat ? { type: 'cat/setVisible', cat, visible: true } : undefined}
          send={send}
        />
        <CommandButton
          label={text.hide}
          command={cat ? { type: 'cat/setVisible', cat, visible: false } : undefined}
          send={send}
        />
      </div>
      <label className="field">
        {text.clip}
        <select
          disabled={!clip}
          value={clip ? `${clip.name}:${clip.variant}` : ''}
          onChange={(event) => {
            setChosenClip(event.target.value);
          }}
        >
          {clips.map((item) => (
            <option key={`${item.name}:${item.variant}`} value={`${item.name}:${item.variant}`}>
              {item.name} · {text.variant} {item.variant}
            </option>
          ))}
        </select>
      </label>
      <CommandButton
        label={text.playClip}
        command={
          cat && clip
            ? { type: 'debug/playClip', cat, clip: clip.name, variant: clip.variant }
            : undefined
        }
        send={send}
      />
      <div className="buttons">
        {SIMULATIONS.map((interaction) => (
          <CommandButton
            key={interaction}
            label={text.simulations[interaction]}
            command={cat ? { type: 'debug/simulate', cat, interaction } : undefined}
            send={send}
          />
        ))}
      </div>
      <div className="buttons">
        {SOUNDS.map((sound) => (
          <CommandButton
            key={sound}
            label={text.sounds[sound]}
            command={cat ? { type: 'debug/sound', cat, sound } : undefined}
            send={send}
          />
        ))}
      </div>
      <CommandButton
        label={text.crash}
        className="danger"
        command={{ type: 'debug/crashOverlay' }}
        send={send}
      />
    </section>
  );
}

function StageControls({ snapshot, send }: DebugProps) {
  const [minutes, setMinutes] = useState('60');
  const [invalid, setInvalid] = useState(false);
  return (
    <section className="card">
      <h2>{text.stageControls}</h2>
      <div className="buttons">
        <CommandButton
          label={text.hideAllToggle}
          command={{ type: 'hideAll/toggle' }}
          send={send}
        />
        <CommandButton label={text.entranceAll} command={{ type: 'debug/entrance' }} send={send} />
        <CommandButton
          label={text.fullscreenStart}
          command={{ type: 'debug/simulateFullscreen', active: true }}
          send={send}
        />
        <CommandButton
          label={text.fullscreenEnd}
          command={{ type: 'debug/simulateFullscreen', active: false }}
          send={send}
        />
        <CommandButton
          label={text.startupQuiet}
          command={{ type: 'debug/startupQuiet' }}
          send={send}
        />
      </div>
      <h3>{text.doNotDisturb}</h3>
      <DoNotDisturbButtons active={snapshot.doNotDisturb.mode !== 'off'} send={send} />
      <h3>{text.advanceClock}</h3>
      <form
        className="inline"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const value = Number(minutes);
          const ok = Number.isInteger(value) && value >= ADVANCE_MIN && value <= ADVANCE_MAX;
          setInvalid(!ok);
          if (ok) send({ type: 'debug/advanceClock', minutes: value });
        }}
      >
        <label>
          {text.advanceMinutes}
          <input
            type="number"
            min={ADVANCE_MIN}
            max={ADVANCE_MAX}
            step="1"
            value={minutes}
            onChange={(event) => {
              setMinutes(event.target.value);
            }}
          />
        </label>
        <button type="submit">{text.advanceClock}</button>
      </form>
      {invalid && (
        <p role="alert" className="error">
          {text.advanceInvalid}
        </p>
      )}
      <p className="muted">{text.advanceClockHelp}</p>
    </section>
  );
}

function AppCommands({ send }: { send: (command: ToMainCommand) => void }) {
  return (
    <section className="card">
      <h2>{text.appCommands}</h2>
      <div className="buttons">
        <CommandButton label={text.takePhoto} command={{ type: 'photo/take' }} send={send} />
        <CommandButton
          label={text.exportDiagnostics}
          command={{ type: 'diagnostics/export' }}
          send={send}
        />
        <CommandButton label={text.checkUpdate} command={{ type: 'update/check' }} send={send} />
        <CommandButton
          label={text.installUpdate}
          command={{ type: 'update/install' }}
          send={send}
        />
      </div>
    </section>
  );
}

function onOff(value: boolean): string {
  return value ? text.on : text.off;
}

function SavedState({ snapshot, content }: DebugProps) {
  const settings = snapshot.settings;
  return (
    <section className="card">
      <h2>{text.savedState}</h2>
      <p>
        {text.revision} {snapshot.revision}
      </p>
      <dl>
        <dt>{text.activityLevel}</dt>
        <dd>{text.activityLevels[settings.activityLevel]}</dd>
        <dt>{text.scale}</dt>
        <dd>{Math.round(settings.scale * 100)}%</dd>
        <dt>{text.floorDepth}</dt>
        <dd>{Math.round(settings.floorDepth * 100)}%</dd>
        <dt>{text.capture}</dt>
        <dd>
          <input
            type="checkbox"
            checked={settings.showInScreenCapture}
            disabled
            aria-label={text.capture}
          />
        </dd>
        <dt>{text.purrEnabled}</dt>
        <dd>
          {onOff(settings.purrEnabled)} · {Math.round(settings.purrVolume * 100)}%
        </dd>
        <dt>{text.meowEnabled}</dt>
        <dd>
          {onOff(settings.meowEnabled)} · {Math.round(settings.meowVolume * 100)}%
        </dd>
        <dt>{text.quietHours}</dt>
        <dd>
          {settings.quietHoursStart}～{settings.quietHoursEnd}
        </dd>
        <dt>{text.hideAllShortcut}</dt>
        <dd>{normalizeAccelerator(settings.hideAllShortcut) ?? settings.hideAllShortcut}</dd>
        <dt>{text.launchAtLogin}</dt>
        <dd>{onOff(settings.launchAtLogin)}</dd>
        <dt>{text.autoUpdate}</dt>
        <dd>{onOff(settings.autoUpdate)}</dd>
        <dt>{text.display}</dt>
        <dd>
          {settings.display === null
            ? text.primaryDisplay
            : `${settings.display.label === '' ? `#${settings.display.id}` : settings.display.label} · ${settings.display.width}×${settings.display.height}`}
        </dd>
      </dl>
      {Object.values(content.cats).map(({ cat }) => (
        <p key={cat.id}>
          {cat.name} · {settings.visibleCats.includes(cat.id) ? text.visible : text.hidden}
        </p>
      ))}
    </section>
  );
}

function QuietState({ snapshot }: { snapshot: StateSnapshot }) {
  return (
    <section className="card">
      <h2>{text.quietState}</h2>
      <dl>
        <dt>{text.doNotDisturb}</dt>
        <dd>{doNotDisturbText(snapshot.doNotDisturb, snapshot.at)}</dd>
        <dt>{text.hideAll}</dt>
        <dd>{snapshot.hideAll ? text.hideAllOn : text.hideAllOff}</dd>
        <dt>{text.canMakeSound}</dt>
        <dd>{silenceText(snapshot.silencedBy)}</dd>
        <dt>{text.clockOffset}</dt>
        <dd>{clockOffsetText(snapshot.clockOffsetMs)}</dd>
      </dl>
    </section>
  );
}

function AppState({ status, now }: { status: AppStatus | undefined; now: number }) {
  return (
    <section className="card">
      <h2>{text.appState}</h2>
      {!status ? (
        <p>{text.statusUnavailable}</p>
      ) : (
        <>
          <p>
            {text.revision} {status.revision}
          </p>
          <dl>
            <dt>{text.currentVersion}</dt>
            <dd>{status.version}</dd>
            <dt>{text.updateStatus}</dt>
            <dd>{updateText(status.update, now)}</dd>
            <dt>{text.shortcutState}</dt>
            <dd>
              {(status.hideAllShortcut.registered ? text.shortcutOk : text.shortcutBad)(
                normalizeAccelerator(status.hideAllShortcut.accelerator) ??
                  status.hideAllShortcut.accelerator,
              )}
            </dd>
            <dt>{text.overlayDisplay}</dt>
            <dd>{status.overlayDisplayId ?? text.notCreated}</dd>
            <dt>{text.displays}</dt>
            <dd>
              <ul>
                {status.displays.map((display, index) => (
                  <li key={display.id}>
                    #{display.id} {text.displayName(index + 1, display.label)} ·{' '}
                    {text.displayDetail(display.width, display.height, display.scaleFactor)}
                    {display.primary ? text.displayIsPrimary : ''}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </>
      )}
    </section>
  );
}

function StageState({
  report,
  content,
}: {
  report: StageDebugReport | undefined;
  content: ContentCatalog;
}) {
  const nameOf = (cat: string) => content.cats[cat]?.cat.name ?? cat;
  return (
    <section className="card">
      <h2>{text.stageState}</h2>
      {!report ? (
        <p>{text.waitingReport}</p>
      ) : (
        <>
          <p>
            {text.reportedAt} {new Date(report.at).toLocaleString('zh-CN')}
          </p>
          {report.audio && (
            <p>
              {text.audio}：
              {report.audio.playing.length === 0
                ? text.audioIdle
                : report.audio.playing
                    .map(({ cat, sound }) => `${nameOf(cat)} ${text.sounds[sound]}`)
                    .join(text.reasonSeparator)}
              {report.audio.suspended ? ` · ${text.audioSuspended}` : ''}
            </p>
          )}
          {report.cats.map((cat) => (
            <article key={cat.cat}>
              <h3>{nameOf(cat.cat)}</h3>
              <dl>
                <dt>{text.pose}</dt>
                <dd>
                  {Object.entries(zh.poses).find(([pose]) => pose === cat.pose)?.[1] ?? cat.pose}
                </dd>
                <dt>{text.clip}</dt>
                <dd>{cat.clip}</dd>
                <dt>{text.variant}</dt>
                <dd>{cat.variant}</dd>
                <dt>{text.behavior}</dt>
                <dd>{cat.behavior}</dd>
                <dt>{text.position}</dt>
                <dd>
                  {Math.round(cat.x)}, {Math.round(cat.y)}
                </dd>
              </dl>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
