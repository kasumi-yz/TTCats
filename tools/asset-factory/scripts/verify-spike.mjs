// 在素材库里复制 M0-A 小样并替换测试片段，绝不改动 experiments/ 的文件。
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = join(repo, "experiments/overlay-spike");
const metadataPath = resolve(process.argv[2]);
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
assert.equal(
  metadata.width,
  384,
  "本复现小样固定为 384×384，请使用 run-synthetic.py 的输出",
);
assert.equal(metadata.height, 384);
const rootValue = process.env.TTCATS_ASSET_ROOT;
assert(rootValue, "请设置仓库外的 TTCATS_ASSET_ROOT");
const root = resolve(rootValue);
for (let parent = root; ; parent = dirname(parent)) {
  assert(!existsSync(join(parent, ".git")), "复现结果必须放在仓库外的素材库");
  if (dirname(parent) === parent) break;
}
const stage = join(root, "factory-tests", `spike-${Date.now()}`);
mkdirSync(stage, { recursive: true });
for (const name of ["src", "scripts", "assets", "package.json"]) {
  cpSync(join(source, name), join(stage, name), { recursive: true });
}
// 只给外部复现副本添加调试端口文件，保留小样原有渲染和播放代码。
const controlPath = join(stage, "src/shared/control.ts");
const controlSource = readFileSync(controlPath, "utf8");
const controlMarker = "process.stdout.write(`CONTROL_PORT=${port}\\n`);";
assert(
  controlSource.includes(controlMarker),
  "小样控制通道写法已改变，需要更新复现脚本",
);
writeFileSync(
  controlPath,
  "import { writeFileSync } from 'node:fs';\n" +
    controlSource.replace(
      controlMarker,
      `writeFileSync(${JSON.stringify(join(stage, "control-port.txt"))}, String(port));\n${controlMarker}`,
    ),
);
assert(
  existsSync(join(source, "node_modules")),
  "先在 experiments/overlay-spike 执行 npm install",
);
symlinkSync(
  join(source, "node_modules"),
  join(stage, "node_modules"),
  "junction",
);
const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
  cwd: stage,
  encoding: "utf8",
});
assert.equal(build.status, 0, build.stderr);
const manifestPath = join(stage, "assets/clips/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.fps = metadata.fps;
manifest.footAnchor = [
  metadata.footAnchors[0].x / 384,
  metadata.footAnchors[0].y / 384,
];
const loop = manifest.clips.find((clip) => clip.id === "loop_stand");
loop.frames = metadata.frameCount;
const pack = dirname(dirname(metadataPath));
cpSync(join(pack, metadata.video), join(stage, "assets/clips", loop.video));
cpSync(join(pack, metadata.hitMask), join(stage, "assets/clips", loop.mask));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const app = await electron.launch({
  executablePath: require("electron"),
  args: [
    stage,
    "--layout=test",
    "--preload=lazy",
    "--gpu=default",
    "--no-hud",
    "--control",
  ],
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("canvas");
  // 读取小样自己上报的实时片段/帧号，不模拟鼠标键盘。
  const portLine = Number(
    readFileSync(join(stage, "control-port.txt"), "utf8"),
  );
  const samples = [];
  assert(portLine > 0);
  {
    const deadline = Date.now() + 15000;
    let initial;
    do {
      initial = await (
        await fetch(`http://127.0.0.1:${portLine}/state`)
      ).json();
      if (initial.cats.length === 3) break;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    assert.equal(
      initial.cats.length,
      3,
      `小样未完成加载：${JSON.stringify({ initial, errors })}`,
    );
    await fetch(`http://127.0.0.1:${portLine}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "layout",
        layout: "test",
        cats: [
          { id: "cat-a", x: 700, y: 700, scale: 0.8 },
          { id: "cat-b", x: 1100, y: 700, scale: 0.8 },
          { id: "cat-c", x: 1500, y: 700, scale: 0.8 },
        ],
      }),
    });
    for (let i = 0; i < 8; i++) {
      samples.push(
        await (await fetch(`http://127.0.0.1:${portLine}/state`)).json(),
      );
      await page.waitForTimeout(400);
    }
    assert(samples.every((state) => state.cats.length === 3));
    assert(new Set(samples.map((state) => state.cats[0].frame)).size > 1);
  }
  const pixels = await page.evaluate(
    () =>
      new Promise((accept) => {
        requestAnimationFrame(() => {
          const source = document.querySelector("canvas");
          const canvas = document.createElement("canvas");
          canvas.width = source.width;
          canvas.height = source.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(source, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let transparent = 0,
            opaque = 0;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] === 0) transparent++;
            if (data[i] === 255) opaque++;
          }
          accept({
            transparent,
            opaque,
            width: canvas.width,
            height: canvas.height,
          });
        });
      }),
  );
  assert(pixels.transparent > 0 && pixels.opaque > 1000);
  assert.equal(errors.length, 0, errors.join("\n"));
  await page.screenshot({
    path: join(stage, "overlay.png"),
    omitBackground: true,
  });
  const result = {
    spike: "passed",
    pixels,
    samples,
    errors,
    stage,
    metadataPath,
  };
  writeFileSync(join(stage, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      spike: "passed",
      pixels,
      stage,
      stateSamples: samples.length,
    }),
  );
} finally {
  await app.close();
}
