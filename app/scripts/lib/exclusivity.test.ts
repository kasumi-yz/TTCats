import { describe, expect, it } from 'vitest';
import { competitors, type ProcessInfo } from './exclusivity';

const electron = String.raw`C:\TTCats-wt\issue29\node_modules\electron\dist\electron.exe`;
const proc = (
  pid: number,
  parentPid: number,
  name = 'electron.exe',
  path: string | null = electron,
): ProcessInfo => ({
  pid,
  parentPid,
  name,
  path,
});

describe('性能和交互测试的独占检查', () => {
  it('开测前没有放行名单：同一个工作树里的 Electron 也算竞争', () => {
    expect(competitors([proc(10, 1)], []).map((p) => p.pid)).toEqual([10]);
  });

  it('只放过本轮启动的进程和它的子进程（GPU、渲染进程等）', () => {
    const list = [proc(10, 1), proc(11, 10), proc(12, 11), proc(20, 1)];
    expect(competitors(list, [10]).map((p) => p.pid)).toEqual([20]);
  });

  it('同一个 electron.exe 路径、但不是本轮启动的测试进程，仍然被拦下', () => {
    const list = [proc(10, 1), proc(30, 5), proc(31, 30)];
    expect(competitors(list, [10]).map((p) => p.pid)).toEqual([30, 31]);
  });

  it('素材工厂的 Python 和 ComfyUI 也算竞争，其他程序不算', () => {
    const list = [
      proc(40, 1, 'python.exe', null),
      proc(41, 1, 'ComfyUI.exe', null),
      proc(42, 1, 'Claude.exe', null),
      proc(43, 1, 'node.exe', null),
    ];
    expect(competitors(list, []).map((p) => p.pid)).toEqual([40, 41]);
  });

  it('父子关系成环时不会死循环', () => {
    expect(competitors([proc(50, 51), proc(51, 50)], []).map((p) => p.pid)).toEqual([50, 51]);
  });
});
