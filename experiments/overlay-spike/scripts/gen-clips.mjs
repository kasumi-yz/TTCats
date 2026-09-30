// 生成合成的"假猫"测试片段：带透明通道的 VP9 WebM（24fps，边缘半透明羽化）
// 以及每一帧的低分辨率点击遮罩。
//
// 用法：node scripts/gen-clips.mjs [--if-missing]
// 需要 PATH 里有 ffmpeg（带 libvpx-vp9）。
//
// 形状由 7 个椭圆拼成（身体、头、四条腿、尾巴），腿之间留有空隙，
// 用来验证"按像素判定"而不是"按矩形判定"。
// 每个片段的第一帧和最后一帧都严格等于某个姿势（ADR-0002 的姿势规则）。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'clips');
const SIZE = 384; // 片段画布边长（像素），约为 100% 缩放时显示尺寸的 2 倍
const FPS = 24;
const MASK_SCALE = 4; // 点击遮罩的缩小倍数：384 → 96
const FEATHER = 2.5; // 羽化宽度（像素）
const FOOT_Y = 0.94; // 落脚锚点（归一化坐标，所有姿势共用）

// 每个姿势：7 个椭圆 [cx, cy, rx, ry]，归一化到 0..1
const POSES = {
  stand: [
    [0.5, 0.58, 0.3, 0.15], // 身体
    [0.78, 0.4, 0.11, 0.11], // 头
    [0.3, 0.78, 0.035, 0.16], // 腿
    [0.4, 0.78, 0.035, 0.16],
    [0.6, 0.78, 0.035, 0.16],
    [0.7, 0.78, 0.035, 0.16],
    [0.17, 0.45, 0.03, 0.14], // 尾巴
  ],
  sit: [
    [0.5, 0.64, 0.17, 0.24],
    [0.55, 0.33, 0.12, 0.12],
    [0.52, 0.8, 0.03, 0.14],
    [0.6, 0.8, 0.03, 0.14],
    [0.38, 0.88, 0.08, 0.06],
    [0.64, 0.88, 0.08, 0.06],
    [0.3, 0.9, 0.14, 0.03],
  ],
  hang: [
    [0.5, 0.5, 0.13, 0.26],
    [0.5, 0.17, 0.11, 0.11],
    [0.43, 0.78, 0.03, 0.12],
    [0.57, 0.78, 0.03, 0.12],
    [0.45, 0.84, 0.035, 0.1],
    [0.55, 0.84, 0.035, 0.1],
    [0.5, 0.9, 0.03, 0.1],
  ],
};

const smooth = (t) => t * t * (3 - 2 * t);
const lerpPose = (a, b, t) => a.map((e, i) => e.map((v, j) => v + (b[i][j] - v) * t));

// 循环片段的"小动作"：p ∈ [0,1)，p=0 时必须正好是姿势本身
const LOOP_WIGGLE = {
  stand: (pose, p) => {
    const s = Math.sin(2 * Math.PI * p);
    const r = pose.map((e) => [...e]);
    r[0][3] *= 1 + 0.05 * s; // 呼吸
    r[6][0] += 0.03 * Math.sin(4 * Math.PI * p); // 甩尾
    r[1][1] += 0.01 * s;
    return r;
  },
  sit: (pose, p) => {
    const r = pose.map((e) => [...e]);
    r[6][0] += 0.04 * Math.sin(2 * Math.PI * p);
    r[1][1] += 0.015 * Math.sin(2 * Math.PI * p);
    return r;
  },
  hang: (pose, p) => {
    const dx = 0.05 * Math.sin(2 * Math.PI * p);
    return pose.map((e, i) => [e[0] + dx * (i === 1 ? 0.3 : 1 + e[1]), e[1], e[2], e[3]]);
  },
};

function renderFrame(ellipses) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const px = ellipses.map(([cx, cy, rx, ry]) => [cx * SIZE, cy * SIZE, rx * SIZE, ry * SIZE]);
  const [hx, hy, hr] = px[1];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let a = 0;
      for (const [cx, cy, rx, ry] of px) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        // 近似的有向距离（像素）：<0 在内部
        const d = (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry);
        const ai = Math.min(1, Math.max(0, 0.5 - d / FEATHER));
        if (ai > a) a = ai;
      }
      if (a <= 0) continue;
      const shade = 1 - 0.3 * (y / SIZE);
      let r = 250 * shade;
      let g = 244 * shade;
      let b = 232 * shade;
      // 眼睛：用来看出朝向和运动
      const ex1 = (x - (hx + hr * 0.35)) ** 2 + (y - (hy - hr * 0.1)) ** 2;
      const ex2 = (x - (hx - hr * 0.15)) ** 2 + (y - (hy - hr * 0.1)) ** 2;
      if (ex1 < (hr * 0.14) ** 2 || ex2 < (hr * 0.14) ** 2) {
        r = g = b = 40;
      }
      const o = (y * SIZE + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

function maskOf(rgba) {
  const w = SIZE / MASK_SCALE;
  const bits = Buffer.alloc(Math.ceil((w * w) / 8));
  for (let my = 0; my < w; my++) {
    for (let mx = 0; mx < w; mx++) {
      let sum = 0;
      for (let y = 0; y < MASK_SCALE; y++) {
        for (let x = 0; x < MASK_SCALE; x++) {
          sum += rgba[((my * MASK_SCALE + y) * SIZE + mx * MASK_SCALE + x) * 4 + 3];
        }
      }
      // 平均不透明度 ≥ 50% 才算猫身上
      if (sum / (MASK_SCALE * MASK_SCALE) >= 128) {
        const i = my * w + mx;
        bits[i >> 3] |= 1 << (i & 7);
      }
    }
  }
  return bits;
}

function encode(file, frames) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${SIZE}x${SIZE}`,
        '-r',
        String(FPS),
        '-i',
        '-',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-b:v',
        '0',
        '-crf',
        '32',
        '-auto-alt-ref',
        '0',
        '-row-mt',
        '1',
        '-an',
        file,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    ff.on('error', reject);
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
    for (const f of frames) ff.stdin.write(f);
    ff.stdin.end();
  });
}

const clips = [];
for (const pose of Object.keys(POSES)) {
  clips.push({ id: `loop_${pose}`, kind: 'loop', fromPose: pose, toPose: pose, frames: 48 });
}
for (const from of Object.keys(POSES)) {
  for (const to of Object.keys(POSES)) {
    if (from !== to) {
      clips.push({ id: `tr_${from}_${to}`, kind: 'transition', fromPose: from, toPose: to, frames: 18 });
    }
  }
}

const manifestPath = join(outDir, 'manifest.json');
if (process.argv.includes('--if-missing') && existsSync(manifestPath)) {
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

const manifest = {
  size: SIZE,
  fps: FPS,
  footAnchor: [0.5, FOOT_Y],
  mask: { width: SIZE / MASK_SCALE, height: SIZE / MASK_SCALE, scale: MASK_SCALE },
  clips: [],
};

for (const clip of clips) {
  const t0 = performance.now();
  const frames = [];
  for (let i = 0; i < clip.frames; i++) {
    let ellipses;
    if (clip.kind === 'loop') {
      ellipses = LOOP_WIGGLE[clip.fromPose](POSES[clip.fromPose], i / clip.frames);
    } else {
      ellipses = lerpPose(POSES[clip.fromPose], POSES[clip.toPose], smooth(i / (clip.frames - 1)));
    }
    frames.push(renderFrame(ellipses));
  }
  const video = `${clip.id}.webm`;
  const mask = `${clip.id}.hitmask.bin`;
  await encode(join(outDir, video), frames);
  writeFileSync(join(outDir, mask), Buffer.concat(frames.map(maskOf)));
  manifest.clips.push({ ...clip, video, mask });
  console.log(`${clip.id}: ${clip.frames} 帧，${Math.round(performance.now() - t0)}ms`);
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`已写入 ${manifestPath}`);
