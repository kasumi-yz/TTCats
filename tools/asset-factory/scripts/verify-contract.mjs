// 直接用桌宠的共享实现读取素材工厂输出；运行前在仓库根目录 npm ci。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ClipSchema } from "../../../app/src/shared/schemas/clip.ts";
import { CandidateManifestSchema } from "../../../app/src/shared/schemas/candidate-manifest.ts";
import {
  encodeHitMaskFrame,
  hitMaskAt,
  hitMaskLayout,
} from "../../../app/src/shared/hitmask.ts";

const metadataPath = resolve(process.argv[2]);
const metadata = ClipSchema.parse(
  JSON.parse(readFileSync(metadataPath, "utf8")),
);
const pack = dirname(dirname(metadataPath));
const manifest = CandidateManifestSchema.parse(
  JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8")),
);
assert.deepEqual(manifest.clip, metadata);
const video = join(pack, metadata.video);
const mask = readFileSync(join(pack, metadata.hitMask));
const layout = hitMaskLayout(metadata);
assert.equal(mask.length, layout.totalBytes, "点击遮罩长度必须与共享格式一致");
const result = spawnSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-c:v",
    "libvpx-vp9",
    "-i",
    video,
    "-vf",
    "alphaextract",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
  ],
  { maxBuffer: metadata.width * metadata.height * (metadata.frameCount + 1) },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr.toString());
const pixels = metadata.width * metadata.height;
assert.equal(
  result.stdout.length,
  pixels * metadata.frameCount,
  "WebM 的帧数必须匹配资料",
);
let transparent = 0;
let opaque = 0;
for (let frame = 0; frame < metadata.frameCount; frame++) {
  const alpha = result.stdout.subarray(frame * pixels, (frame + 1) * pixels);
  const expected = encodeHitMaskFrame(
    alpha,
    metadata.width,
    metadata.height,
    metadata.hitMaskScale,
  );
  const actual = mask.subarray(
    frame * layout.frameBytes,
    (frame + 1) * layout.frameBytes,
  );
  assert.deepEqual(
    new Uint8Array(actual),
    expected,
    `第 ${frame} 帧遮罩与共享实现不一致`,
  );
  transparent += alpha.filter((a) => a === 0).length;
  opaque += alpha.filter((a) => a === 255).length;
}
assert(transparent > 0 && opaque > 0, "视频必须同时有透明背景和不透明主体");
assert.equal(hitMaskAt(mask, layout, 0, -1, 0), false);
assert.equal(hitMaskAt(mask, layout, 0, metadata.width, 0), false);
const differences = [];
for (let frame = 0; frame < metadata.frameCount; frame++) {
  const next = (frame + 1) % metadata.frameCount;
  let difference = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    difference += Math.abs(
      result.stdout[frame * pixels + pixel] -
        result.stdout[next * pixels + pixel],
    );
  }
  differences.push(difference / pixels);
}
const loopSeamDifference = differences.at(-1);
const adjacentMeanDifference =
  differences.slice(0, -1).reduce((a, b) => a + b, 0) /
  (metadata.frameCount - 1);
if (process.argv.includes("--check-loop")) {
  assert.equal(metadata.kind, "loop");
  assert(
    differences.every((value) => value > 0),
    "动态合成循环不能包含重复相邻帧或静止接缝",
  );
  assert(
    loopSeamDifference <= adjacentMeanDifference * 2,
    "合成循环接缝变化不能超过普通相邻变化的两倍",
  );
}
console.log(
  JSON.stringify(
    {
      sharedSchema: "passed",
      candidateManifest: "passed",
      sharedHitMask: "passed",
      decodedAlpha: "passed",
      frameCount: metadata.frameCount,
      width: metadata.width,
      height: metadata.height,
      frameBytes: layout.frameBytes,
      maskBytes: mask.length,
      transparentPixels: transparent,
      opaquePixels: opaque,
      loopSeamDifference,
      adjacentMeanDifference,
      minimumAdjacentDifference: Math.min(...differences),
    },
    null,
    2,
  ),
);
