import type { AppStatus } from '../shared/ipc';

/** #65 更新显示器、#68 更新自动更新状态；每次只覆盖自己的字段。 */
export function createAppStatus(
  initial: Omit<AppStatus, 'revision'>,
  publish: (status: AppStatus) => void,
) {
  let status: AppStatus = { ...initial, revision: 0 };
  return {
    current: (): AppStatus => structuredClone(status),
    update(patch: Partial<Omit<AppStatus, 'revision' | 'version'>>): void {
      status = structuredClone({ ...status, ...patch, revision: status.revision + 1 });
      publish(structuredClone(status));
    },
  };
}
