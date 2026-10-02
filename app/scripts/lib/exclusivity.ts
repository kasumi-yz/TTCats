// 独占检查的判定部分（不查系统，方便单元测试）。查询见 desktop.ts 的 exclusivity()。

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  path: string | null;
}

/** 会影响测量或抢鼠标的程序：别的会话跑的 Electron、素材工厂（Python、ComfyUI）。 */
const COMPETING = /^(electron|python|pythonw|comfyui)\.exe$/i;

/**
 * 找出和本轮测试竞争的进程。只有 ownRoots（本轮自己启动的被测应用、探针窗口）
 * 和它们的子孙进程不算；其他同类进程一律算竞争，哪怕和本轮用的是同一个 electron.exe。
 */
export function competitors(processes: ProcessInfo[], ownRoots: number[]): ProcessInfo[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const roots = new Set(ownRoots);
  const ours = (p: ProcessInfo): boolean => {
    // 沿父进程往上找；记下走过的，防止父子关系成环时死循环
    const seen = new Set<number>();
    for (
      let current: ProcessInfo | undefined = p;
      current;
      current = byPid.get(current.parentPid)
    ) {
      if (roots.has(current.pid)) return true;
      if (seen.has(current.pid)) return false;
      seen.add(current.pid);
    }
    return false;
  };
  return processes.filter((p) => COMPETING.test(p.name) && !ours(p));
}
