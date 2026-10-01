import { useEffect, useState } from 'react';
import type { ContentCatalog } from '../../shared/core-api';
import type {
  PanelsBridge,
  StageDebugReport,
  StateSnapshot,
  ToMainCommand,
} from '../../shared/ipc';
import { ActivityLevelSchema, type Settings } from '../../shared/schemas/settings';
import { zh } from '../../shared/strings.zh-CN';
import './panels.css';

const text = zh.panels;

export function App({
  bridge = (window as Window & { ttcats?: PanelsBridge }).ttcats,
  search = window.location.search,
}: {
  bridge?: PanelsBridge;
  search?: string;
}) {
  const [snapshot, setSnapshot] = useState<StateSnapshot>();
  const [content, setContent] = useState<ContentCatalog>();
  const [report, setReport] = useState<StageDebugReport>();
  const [error, setError] = useState<string>();
  const query = new URLSearchParams(search);
  const panel = query.get('panel');
  const page = panel === 'profile' || panel === 'debug' ? panel : 'settings';

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const receive = (next: StateSnapshot) => {
      if (active)
        setSnapshot((current) => (!current || next.revision > current.revision ? next : current));
    };
    const unsubscribe = bridge.onSnapshot(receive);
    const unsubscribeDebug =
      page === 'debug'
        ? bridge.onStageDebug((next) => {
            if (active)
              setReport((current) => (!current || next.at >= current.at ? next : current));
          })
        : undefined;
    void Promise.all([bridge.getSnapshot(), bridge.getContent()])
      .then(([initial, catalog]) => {
        if (!active) return;
        receive(initial);
        setContent(catalog);
      })
      .catch(() => {
        if (active) setError(text.loadFailed);
      });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeDebug?.();
    };
  }, [bridge, page]);

  function send(command: ToMainCommand) {
    try {
      bridge?.sendCommand(command);
      setError(undefined);
    } catch {
      setError(text.commandFailed);
    }
  }

  return (
    <main className="panel" data-testid="placeholder">
      <header>
        <p className="brand">{zh.app.name}</p>
        <h1>{text[page]}</h1>
      </header>
      {!bridge && <p role="alert">{text.unavailable}</p>}
      {error && <p role="alert">{error}</p>}
      {bridge && !error && (!snapshot || !content) && <p role="status">{text.loading}</p>}
      {snapshot && content && (
        <>
          {page === 'settings' && (
            <SettingsPanel snapshot={snapshot} content={content} send={send} />
          )}
          {page === 'profile' && (
            <ProfilePanel content={content} catId={query.get('cat')} at={snapshot.at} />
          )}
          {page === 'debug' && (
            <DebugPanel snapshot={snapshot} content={content} report={report} send={send} />
          )}
        </>
      )}
    </main>
  );
}

type PanelProps = {
  snapshot: StateSnapshot;
  content: ContentCatalog;
  send: (command: ToMainCommand) => void;
};

function SettingsPanel({ snapshot, content, send }: PanelProps) {
  const settings = snapshot.settings;
  const cats = Object.values(content.cats);
  const update = (patch: Partial<Settings>) => {
    send({ type: 'settings/update', patch });
  };
  return (
    <section className="card">
      <fieldset>
        <legend>{text.visibleCats}</legend>
        {cats.length === 0 && <p>{text.noCats}</p>}
        {cats.map(({ cat }) => (
          <label className="check" key={cat.id}>
            <input
              type="checkbox"
              checked={settings.visibleCats.includes(cat.id)}
              onChange={(event) => {
                send({ type: 'cat/setVisible', cat: cat.id, visible: event.target.checked });
              }}
            />
            {cat.name}
          </label>
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
      <label className="field">
        {text.scale}
        <span>{Math.round(settings.scale * 100)}%</span>
        <input
          aria-label={text.scale}
          type="range"
          min="50"
          max="200"
          step="1"
          value={settings.scale * 100}
          onChange={(event) => {
            update({ scale: Number(event.target.value) / 100 });
          }}
        />
      </label>
      <label className="field">
        {text.floorDepth}
        <span>{Math.round(settings.floorDepth * 100)}%</span>
        <input
          aria-label={text.floorDepth}
          type="range"
          min="0"
          max="100"
          step="1"
          value={settings.floorDepth * 100}
          onChange={(event) => {
            update({ floorDepth: Number(event.target.value) / 100 });
          }}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.showInScreenCapture}
          onChange={(event) => {
            update({ showInScreenCapture: event.target.checked });
          }}
        />
        {text.capture}
      </label>
      <p className="muted">{text.captureHelp}</p>
    </section>
  );
}

function ProfilePanel({
  content,
  catId,
  at,
}: {
  content: ContentCatalog;
  catId: string | null;
  at: number;
}) {
  const cat = catId ? content.cats[catId]?.cat : undefined;
  if (!cat) return <p role="status">{text.catMissing}</p>;
  let age = text.unknown;
  if (cat.birthday) {
    const today = new Date(at);
    const birth = new Date(`${cat.birthday}T00:00:00`);
    const anniversaryPassed =
      today.getMonth() > birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
    const years = today.getFullYear() - birth.getFullYear() - (anniversaryPassed ? 0 : 1);
    age = birth.getTime() > at ? text.notBorn : text.ageYears(years);
  }
  return (
    <section className="card">
      <h2>{cat.name}</h2>
      <dl>
        <dt>{text.birthday}</dt>
        <dd>{cat.birthday ?? text.unknown}</dd>
        <dt>{text.homeDate}</dt>
        <dd>{cat.homeDate ?? text.unknown}</dd>
        <dt>{text.age}</dt>
        <dd>{age}</dd>
      </dl>
      <h3>{text.personality}</h3>
      {Object.entries(cat.personality).map(([key, value]) => (
        <label className="field" key={key}>
          {text.personalityLabels[key as keyof typeof cat.personality]}
          <span>{Math.round(value * 100)}%</span>
          <meter min="0" max="1" value={value} />
        </label>
      ))}
    </section>
  );
}

function DebugPanel({
  snapshot,
  content,
  report,
  send,
}: PanelProps & { report: StageDebugReport | undefined }) {
  const [chosenCat, setChosenCat] = useState('');
  const [chosenClip, setChosenClip] = useState('');
  const cats = Object.values(content.cats);
  const entry = content.cats[chosenCat] ?? cats[0];
  const catId = entry?.cat.id;
  const clips = entry?.clips ?? [];
  const clip = clips.find((item) => `${item.name}:${item.variant}` === chosenClip) ?? clips[0];
  return (
    <>
      <section className="card">
        <button
          onClick={() => {
            send({ type: 'cat/summon' });
          }}
        >
          {text.summonAll}
        </button>
        <label className="field">
          {text.cat}
          <select
            value={catId ?? ''}
            disabled={!catId}
            onChange={(event) => {
              setChosenCat(event.target.value);
              setChosenClip('');
            }}
          >
            {cats.map(({ cat }) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        </label>
        {!catId && <p>{text.noCats}</p>}
        <div className="buttons">
          <button
            disabled={!catId}
            onClick={() => {
              if (catId) send({ type: 'cat/summon', cat: catId });
            }}
          >
            {text.summon}
          </button>
          <button
            disabled={!catId}
            onClick={() => {
              if (catId) send({ type: 'cat/sleep', cat: catId });
            }}
          >
            {text.sleep}
          </button>
          <button
            disabled={!catId}
            onClick={() => {
              if (catId) send({ type: 'cat/setVisible', cat: catId, visible: true });
            }}
          >
            {text.show}
          </button>
          <button
            disabled={!catId}
            onClick={() => {
              if (catId) send({ type: 'cat/setVisible', cat: catId, visible: false });
            }}
          >
            {text.hide}
          </button>
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
        <button
          disabled={!catId || !clip}
          onClick={() => {
            if (catId && clip)
              send({ type: 'debug/playClip', cat: catId, clip: clip.name, variant: clip.variant });
          }}
        >
          {text.playClip}
        </button>
        <div className="buttons">
          {(['poke', 'pet', 'pickUp', 'drop'] as const).map((interaction) => (
            <button
              key={interaction}
              disabled={!catId}
              onClick={() => {
                if (catId) send({ type: 'debug/simulate', cat: catId, interaction });
              }}
            >
              {text.interactions[interaction]}
            </button>
          ))}
        </div>
        <button
          className="danger"
          onClick={() => {
            send({ type: 'debug/crashOverlay' });
          }}
        >
          {text.crash}
        </button>
      </section>
      <section className="card">
        <h2>{text.savedState}</h2>
        <p>
          {text.revision} {snapshot.revision}
        </p>
        <dl>
          <dt>{text.activityLevel}</dt>
          <dd>{text.activityLevels[snapshot.settings.activityLevel]}</dd>
          <dt>{text.scale}</dt>
          <dd>{Math.round(snapshot.settings.scale * 100)}%</dd>
          <dt>{text.floorDepth}</dt>
          <dd>{Math.round(snapshot.settings.floorDepth * 100)}%</dd>
          <dt>{text.capture}</dt>
          <dd>
            <input
              type="checkbox"
              checked={snapshot.settings.showInScreenCapture}
              disabled
              aria-label={text.capture}
            />
          </dd>
        </dl>
        {cats.map(({ cat }) => (
          <p key={cat.id}>
            {cat.name} ·{' '}
            {snapshot.settings.visibleCats.includes(cat.id) ? text.visible : text.hidden}
          </p>
        ))}
      </section>
      <section className="card">
        <h2>{text.stageState}</h2>
        {!report ? (
          <p>{text.waitingReport}</p>
        ) : (
          <>
            <p>
              {text.reportedAt} {new Date(report.at).toLocaleString('zh-CN')}
            </p>
            {report.cats.map((cat) => (
              <article key={cat.cat}>
                <h3>{content.cats[cat.cat]?.cat.name ?? cat.cat}</h3>
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
                    {cat.x}, {cat.y}
                  </dd>
                </dl>
              </article>
            ))}
          </>
        )}
      </section>
      {content.disabled.length > 0 && (
        <section className="card">
          <h2>{text.disabledPacks}</h2>
          {content.disabled.map((pack) => (
            <article key={pack.cat}>
              <h3>{pack.cat}</h3>
              <ul>
                {pack.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
