import { useEffect, useState } from 'react';
import type { ContentCatalog } from '../../shared/core-api';
import type {
  AppStatus,
  PanelsBridge,
  PanelName,
  StageDebugReport,
  StateSnapshot,
  ToMainCommand,
} from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import { DebugPanel } from './DebugPanel';
import { ProfilePanel } from './ProfilePanel';
import { SettingsPanel } from './SettingsPanel';
import './panels.css';

const text = zh.panels;

/** 按 revision 只留更新的一份，丢掉过期和重复的。 */
function newer<T extends { revision: number }>(current: T | undefined, next: T): T {
  return !current || next.revision > current.revision ? next : current;
}

export function App({
  bridge = (window as Window & { ttcats?: PanelsBridge }).ttcats,
  search = window.location.search,
}: {
  bridge?: PanelsBridge;
  search?: string;
}) {
  const [snapshot, setSnapshot] = useState<StateSnapshot>();
  const [content, setContent] = useState<ContentCatalog>();
  const [status, setStatus] = useState<AppStatus>();
  const [report, setReport] = useState<StageDebugReport>();
  const [error, setError] = useState<string>();
  const query = new URLSearchParams(search);
  const panel = query.get('panel');
  const page: PanelName = panel === 'profile' || panel === 'debug' ? panel : 'settings';

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const receive = (next: StateSnapshot) => {
      if (active) setSnapshot((current) => newer(current, next));
    };
    const receiveStatus = (next: AppStatus) => {
      if (active) setStatus((current) => newer(current, next));
    };
    const unsubscribe = bridge.onSnapshot(receive);
    // 程序状态只有设置和调试台要用；拿不到时这两页照样能改其他设置，相关位置显示中文说明。
    const unsubscribeStatus = page === 'profile' ? undefined : bridge.onAppStatus(receiveStatus);
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
    if (page !== 'profile')
      bridge.getAppStatus().then(receiveStatus, () => {
        // 拿不到就等推送；界面上显示 statusUnavailable。
      });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeStatus?.();
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
            <SettingsPanel snapshot={snapshot} content={content} status={status} send={send} />
          )}
          {page === 'profile' && (
            <ProfilePanel content={content} catId={query.get('cat')} at={snapshot.at} />
          )}
          {page === 'debug' && (
            <DebugPanel
              snapshot={snapshot}
              content={content}
              status={status}
              report={report}
              send={send}
            />
          )}
        </>
      )}
    </main>
  );
}
