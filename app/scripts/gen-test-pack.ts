// 小尺寸合成片段用于开发和 CI；不需要真实猫照片。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CatSchema, ClipSchema, CLIP_SLOTS, type Pose } from '../src/shared/schemas';
import { encodeHitMaskFrame } from '../src/shared/hitmask';
import { format } from 'prettier';
import { zh } from '../src/shared/strings.zh-CN';

const size = 128;
const fps = 24;
const count = 24;
const scale = 4;
const root = resolve(import.meta.dirname, '../test-content/cats');
type Ellipse = [number, number, number, number];
// 六个姿势形状明显不同，坐标在固定画布内。
const poses: Record<Pose, Ellipse[]> = {
  stand: [
    [64, 70, 35, 18],
    [100, 48, 14, 14],
    [40, 100, 5, 20],
    [85, 100, 5, 20],
  ],
  sit: [
    [64, 84, 22, 34],
    [70, 40, 15, 15],
    [80, 105, 5, 15],
    [40, 113, 12, 7],
  ],
  sleep: [
    [64, 105, 43, 14],
    [103, 106, 15, 13],
    [32, 111, 12, 7],
    [82, 114, 10, 5],
  ],
  dangle: [
    [64, 65, 16, 30],
    [64, 27, 14, 14],
    [53, 104, 5, 18],
    [75, 104, 5, 18],
  ],
  crouch: [
    [64, 98, 36, 16],
    [103, 86, 14, 14],
    [40, 114, 10, 5],
    [84, 114, 10, 5],
  ],
  airborne: [
    [64, 55, 34, 16],
    [103, 38, 14, 14],
    [32, 76, 16, 5],
    [90, 76, 16, 5],
  ],
};

function render(ellipses: Ellipse[]): Buffer {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let alpha = 0;
      for (const [cx, cy, rx, ry] of ellipses) {
        const distance =
          (Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry) - 1) * Math.min(rx, ry);
        alpha = Math.max(alpha, Math.min(1, Math.max(0, 0.5 - distance / 2)));
      }
      const at = (y * size + x) * 4;
      out[at] = 240;
      out[at + 1] = 180;
      out[at + 2] = 80;
      out[at + 3] = Math.round(alpha * 255);
    }
  return out;
}

function ffmpeg(args: string[], input?: Buffer): Buffer {
  const result = spawnSync('ffmpeg', ['-v', 'error', ...args], {
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(zh.content.generationFailed(result.error?.message ?? result.stderr.toString()));
  return result.stdout;
}

const rawInput = [
  '-f',
  'rawvideo',
  '-pix_fmt',
  'rgba',
  '-s',
  `${size}x${size}`,
  '-r',
  String(fps),
  '-i',
  'pipe:0',
];
function encode(frames: Buffer[]): Buffer {
  // WebM 必须写入可寻址文件，以便 ffmpeg 填入时长和索引，桌面层才可跳转播放位置。
  const temporary = mkdtempSync(resolve(import.meta.dirname, '.gen-test-pack-'));
  const video = join(temporary, 'clip.webm');
  try {
    ffmpeg(
      [
        ...rawInput,
        '-c:v',
        'libvpx-vp9',
        '-lossless',
        '1',
        '-pix_fmt',
        'yuva420p',
        '-threads',
        '1',
        '-auto-alt-ref',
        '0',
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-map_metadata',
        '-1',
        video,
      ],
      Buffer.concat(frames),
    );
    return readFileSync(video);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function decode(video: Buffer): Buffer {
  return ffmpeg(
    ['-c:v', 'libvpx-vp9', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    video,
  );
}
function mask(frame: Buffer): Buffer {
  const alpha = Uint8Array.from({ length: size * size }, (_, i) => frame[i * 4 + 3] ?? 0);
  return Buffer.from(encodeHitMaskFrame(alpha, size, size, scale));
}
async function json(file: string, value: unknown): Promise<void> {
  writeFileSync(file, await format(JSON.stringify(value), { parser: 'json', printWidth: 100 }));
}

const first = join(root, 'test-calm');
mkdirSync(join(first, 'clips'), { recursive: true });
mkdirSync(join(first, 'poses'), { recursive: true });
const standards = new Map<Pose, Buffer>();
for (const pose of Object.keys(poses) as Pose[]) {
  const frame = render(poses[pose]);
  // 参考画面与片段使用同一个 YUV420 编解码转换，按最终播放像素严格核对。
  const canonical = decode(encode([frame]));
  standards.set(pose, canonical);
  writeFileSync(
    join(first, 'poses', `${pose}.png`),
    ffmpeg([...rawInput, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], canonical),
  );
}

for (const [name, slot] of Object.entries(CLIP_SLOTS)) {
  const frames: Buffer[] = [];
  const footAnchors = [];
  const speed = name === 'walk' ? 30 : name === 'run' ? 60 : 0;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const blend = t * t * (3 - 2 * t);
    const wiggle = i === 0 || i === count - 1 ? 0 : Math.sin(t * Math.PI * 2);
    const stride = (speed * (count - 1)) / fps;
    // 前后四分之一周期是落地阶段，脚以 speed 向后运动，中间抬脚收回。
    const step = t <= 0.25 ? -stride * t : t >= 0.75 ? stride * (1 - t) : stride * (t - 0.5);
    const shapes = poses[slot.from].map((shape, j) => {
      const target = poses[slot.to][j];
      if (!target) throw new Error(zh.content.endpointMismatch(name));
      const [cx, cy, rx, ry] = shape;
      const [tx, ty, trx, try_] = target;
      return [
        cx + (tx - cx) * blend + (j === 2 ? step : j === 3 ? -step : 0),
        cy +
          (ty - cy) * blend -
          (speed && j >= 2 && t > 0.25 && t < 0.75 ? Math.sin((t - 0.25) * Math.PI * 2) * 8 : 0),
        rx + (trx - rx) * blend,
        ry + (try_ - ry) * blend + (slot.from === slot.to && j === 0 ? wiggle * 2 : 0),
      ] as Ellipse;
    });
    frames.push(render(shapes));
    footAnchors.push({ x: 64 + step, y: 120 });
  }
  const video = encode(frames);
  const decoded = decode(video);
  const bytes = size * size * 4;
  if (
    decoded.length !== count * bytes ||
    !decoded.subarray(0, bytes).equals(standards.get(slot.from) ?? Buffer.alloc(0)) ||
    !decoded.subarray((count - 1) * bytes).equals(standards.get(slot.to) ?? Buffer.alloc(0))
  )
    throw new Error(zh.content.endpointMismatch(name));
  const clip = ClipSchema.parse({
    schemaVersion: 1,
    name,
    variant: 1,
    kind: slot.kind,
    fromPose: slot.from,
    toPose: slot.to,
    optional: slot.need !== 'required',
    video: `clips/${name}.webm`,
    hitMask: `clips/${name}.hitmask.bin`,
    hitMaskScale: scale,
    fps,
    frameCount: count,
    width: size,
    height: size,
    footAnchors,
    mirrorable: true,
    facing: 'right',
    speed,
    keypoints: {},
  });
  writeFileSync(join(first, clip.video), video);
  writeFileSync(
    join(first, clip.hitMask),
    Buffer.concat(
      Array.from({ length: count }, (_, i) => mask(decoded.subarray(i * bytes, (i + 1) * bytes))),
    ),
  );
  await json(join(first, 'clips', `${name}.json`), clip);
}

const ids = ['test-calm', 'test-close', 'test-active'];
const names = ['测试稳稳', '测试贴贴', '测试蹦蹦'];
for (const [index, id] of ids.entries()) {
  const dir = join(root, id);
  if (dir !== first) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(first, 'clips'), join(dir, 'clips'), { recursive: true });
    cpSync(join(first, 'poses'), join(dir, 'poses'), { recursive: true });
  }
  await json(
    join(dir, 'cat.json'),
    CatSchema.parse({
      schemaVersion: 1,
      id,
      name: names[index],
      relativeSize: [1, 0.8, 1.2][index],
      personality: {
        activity: [0.2, 0.4, 0.9][index],
        clinginess: [0.2, 0.9, 0.7][index],
        initiative: [0.2, 0.3, 0.9][index],
        dominance: [0.3, 0.1, 0.8][index],
        patience: [0.9, 0.7, 0.3][index],
      },
      relationships: ids
        .filter((other) => other !== id)
        .map((other) => ({
          cat: other,
          closeness: other === 'test-close' || id === 'test-close' ? 0.8 : 0.3,
          dominance: (index - ids.indexOf(other)) * 0.3,
        })),
      sounds: { meow: [], purr: [] },
    }),
  );
}
console.log(zh.content.generated);
