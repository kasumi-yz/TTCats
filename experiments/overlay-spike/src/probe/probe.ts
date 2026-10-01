// 探针窗口的页面：把收到的鼠标和键盘事件报告给探针主进程。

const probe = (window as unknown as { probe: { send(ev: unknown): void } }).probe;
const color = new URLSearchParams(location.search).get('color') ?? '#3a6ea5';
document.body.style.background = color;

const logEl = document.getElementById('log')!;
const lines: string[] = [];
function show(s: string): void {
  lines.unshift(s);
  lines.length = Math.min(lines.length, 20);
  logEl.textContent = lines.join('\n');
}

for (const type of ['mousedown', 'mouseup', 'click'] as const) {
  window.addEventListener(type, (e) => {
    probe.send({ type, x: e.screenX, y: e.screenY, ctrl: e.ctrlKey });
    show(`${type} ${e.screenX},${e.screenY}${e.ctrlKey ? ' +Ctrl' : ''}`);
  });
}
const ta = document.querySelector('textarea')!;
ta.addEventListener('input', () => probe.send({ type: 'input', value: ta.value }));
