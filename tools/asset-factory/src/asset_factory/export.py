import json
import math
import re
from pathlib import Path

import numpy as np
from jsonschema import Draft202012Validator
from PIL import Image

from .models import ClipOptions, Confirmation, IngestRecord
from .pipeline import frame_paths
from .storage import (
    FactoryError,
    job_path,
    load_record,
    new_directory,
    operation,
    run_tool,
    write_json,
)


def encode_hit_mask(alpha: np.ndarray, scale: int) -> bytes:
    height, width = alpha.shape
    bits = []
    for y in range(0, height, scale):
        for x in range(0, width, scale):
            cell = alpha[y : y + scale, x : x + scale]
            bits.append(int(np.sum(cell, dtype=np.uint64)) >= 128 * cell.size)
    return np.packbits(bits, bitorder="little").tobytes()


def validate_clip(metadata: dict, cat: str):
    repo = Path(__file__).resolve().parents[4]
    schema = json.loads((repo / "schemas" / "clip.schema.json").read_text(encoding="utf-8"))
    errors = list(Draft202012Validator(schema).iter_errors(metadata))
    if errors:
        paths = [".".join(map(str, error.path)) or "记录（缺失字段或额外字段）" for error in errors]
        raise FactoryError(f"猫「{cat}」：片段资料不符合共享 schema，请检查 {', '.join(paths)}")
    # Zod superRefine 未导出到 JSON Schema；直接读取共享表，避免另定一套片段命名。
    source = (repo / "app/src/shared/schemas/clip.ts").read_text(encoding="utf-8")
    block = source.split("export const CLIP_SLOTS = {", 1)[1].split("} as const", 1)[0]
    slots = re.findall(
        r"(?:'([a-z0-9-]+)'|([a-z0-9-]+)):\s*\{\s*kind: '([^']+)',\s*"
        r"from: '([^']+)',\s*to: '([^']+)'",
        block,
    )
    if not slots:
        raise FactoryError("共享片段表格式已改变，请更新素材工厂的接口读取并重新验证")
    known = {quoted or plain: (kind, start, end) for quoted, plain, kind, start, end in slots}
    name = metadata["name"]
    if name in known:
        if (metadata["kind"], metadata["fromPose"], metadata["toPose"]) != known[name]:
            raise FactoryError(f"猫「{cat}」：片段 {name} 的类型或起止姿势与共享定义不符")
    elif not metadata["optional"]:
        raise FactoryError(f"猫「{cat}」：自定义片段 {name} 必须标为可选")
    same_pose = metadata["fromPose"] == metadata["toPose"]
    if same_pose == (metadata["kind"] == "transition"):
        raise FactoryError(f"猫「{cat}」：过渡片段必须改变姿势，其他片段必须回到原姿势")
    if len(metadata["footAnchors"]) != metadata["frameCount"]:
        raise FactoryError(f"猫「{cat}」：逐帧落脚锚点数量不符")
    for key, points in metadata["keypoints"].items():
        if len(points) != metadata["frameCount"]:
            raise FactoryError(f"猫「{cat}」：关键点 {key} 的逐帧数量不符")
    if metadata.get("soundStartFrame", 0) >= metadata["frameCount"]:
        raise FactoryError(f"猫「{cat}」：声音开始帧超出片段范围")


def finalize(root: Path, job: str, options_path: Path):
    directory = job_path(root, job)
    record = load_record(directory / "ingest.json", IngestRecord)
    with operation(root, "finalize", record.cat, {"job": job}) as log:
        confirmed = load_record(directory / "confirmation.json", Confirmation, record.cat)
        options = load_record(options_path, ClipOptions, record.cat)
        if not confirmed.accepted:
            raise FactoryError(f"猫「{record.cat}」：候选尚未人工确认合格，不能导出")
        selection = confirmed.selection
        if selection.cat != record.cat or len(selection.foot_anchors) != record.frame_count:
            raise FactoryError(f"猫「{record.cat}」：确认记录的猫或落脚锚点数量不符")
        if any(p.x >= record.width or p.y >= record.height for p in selection.foot_anchors):
            raise FactoryError(f"猫「{record.cat}」：落脚锚点超出了原始画面")
        paths = frame_paths(directory, record, "matte")
        start, end = (
            (selection.loop_start, selection.loop_end)
            if options.kind == "loop"
            else (selection.trim_start, selection.trim_end)
        )
        anchors = selection.foot_anchors[start:end]
        selected = paths[start:end]
        # 用锚点作为共同原点，计算所有帧主体的联合边界，不裁掉任何可见毛边。
        bounds = []
        for path, anchor in zip(selected, anchors, strict=True):
            with Image.open(path) as image:
                box = image.getchannel("A").getbbox()
                if box is None:
                    raise FactoryError(f"猫「{record.cat}」：{path.name} 没有可见主体")
                bounds.append(
                    (box[0] - anchor.x, box[1] - anchor.y, box[2] - anchor.x, box[3] - anchor.y)
                )
        left = math.floor(min(b[0] for b in bounds)) - 2
        top = math.floor(min(b[1] for b in bounds)) - 2
        right = math.ceil(max(b[2] for b in bounds)) + 2
        bottom = math.ceil(max(b[3] for b in bounds)) + 2
        canvas_width, canvas_height = right - left, bottom - top
        height = options.display_height * 2
        # VP9 yuva420p 使用偶数尺寸，x/y 比例分别记录，避免四舍五入后锚点偏差。
        width = max(2, round(canvas_width / canvas_height * height / 2) * 2)
        if width > 8192 or width * height > 16_777_216:
            raise FactoryError(f"猫「{record.cat}」：导出画面过大，请降低显示尺寸或检查落脚锚点")
        sx, sy = width / canvas_width, height / canvas_height
        basename = f"{options.name}-{options.variant}"
        metadata = {
            "schemaVersion": 1,
            "name": options.name,
            "variant": options.variant,
            "kind": options.kind,
            "fromPose": options.from_pose,
            "toPose": options.to_pose,
            "optional": options.optional,
            "video": f"clips/{basename}.webm",
            "hitMask": f"clips/{basename}.hitmask.bin",
            "hitMaskScale": options.hit_mask_scale,
            "fps": record.fps,
            "frameCount": len(selected),
            "width": width,
            "height": height,
            "footAnchors": [{"x": -left * sx, "y": -top * sy} for _ in selected],
            "mirrorable": options.mirrorable,
            "facing": options.facing,
            # speed 是 100% 显示尺寸的 px/s；画面按 2 倍尺寸导出，因此再除 2。
            "speed": selection.speed * sx / 2,
            "keypoints": {},
        }
        for key, points in options.keypoints.items():
            if len(points) != record.frame_count:
                raise FactoryError(f"猫「{record.cat}」：关键点 {key} 必须提供原视频每一帧的坐标")
            metadata["keypoints"][key] = [
                None
                if point is None
                else {
                    "x": (point.x - anchor.x - left) * sx,
                    "y": (point.y - anchor.y - top) * sy,
                }
                for point, anchor in zip(points[start:end], anchors, strict=True)
            ]
        if options.sound_start_frame is not None:
            if not start <= options.sound_start_frame < end:
                raise FactoryError(f"猫「{record.cat}」：声音开始帧必须在所选导出区间内")
            metadata["soundStartFrame"] = options.sound_start_frame - start
        validate_clip(metadata, record.cat)
        repo = Path(__file__).resolve().parents[4]
        candidate_schema = json.loads(
            (repo / "schemas/candidate-manifest.schema.json").read_text(encoding="utf-8")
        )
        candidate = {
            "schemaVersion": 1,
            "candidateId": job,
            "cat": options.cat_id,
            "status": "accepted",
            "note": confirmed.notes,
            "assetLog": options.asset_log,
            "clip": metadata,
        }
        errors = list(Draft202012Validator(candidate_schema).iter_errors(candidate))
        if errors:
            fields = ", ".join(
                ".".join(map(str, error.path)) or "asset_log（缺失字段）" for error in errors
            )
            raise FactoryError(
                f"猫「{record.cat}」：候选素材档案不符合共享 schema，请补齐或修正 {fields}"
            )
        if Path(options.asset_log["rawVideo"]).resolve() != Path(record.source).resolve():
            raise FactoryError(f"猫「{record.cat}」：素材档案 rawVideo 与本任务的原始视频不符")
        with new_directory(directory / "finalize") as temporary:
            aligned = temporary / "aligned"
            clips = temporary / "clips"
            aligned.mkdir()
            clips.mkdir()
            mask = clips / f"{basename}.hitmask.bin"
            for index, (path, anchor) in enumerate(zip(selected, anchors, strict=True)):
                with Image.open(path) as image:
                    # 以亚像素平移采样对齐，不按整数舍入锚点。
                    frame = image.transform(
                        (canvas_width, canvas_height),
                        Image.Transform.AFFINE,
                        (1, 0, anchor.x + left, 0, 1, anchor.y + top),
                        resample=Image.Resampling.BICUBIC,
                    ).resize((width, height), Image.Resampling.LANCZOS)
                    frame.save(aligned / f"{index:06d}.png")
            video = clips / f"{basename}.webm"
            command = [
                "ffmpeg",
                "-v",
                "error",
                "-nostdin",
                "-framerate",
                str(record.fps),
                "-i",
                str(aligned / "%06d.png"),
            ]
            if options.sound_start_frame is not None:
                source = Path(record.source)
                if not source.is_file():
                    raise FactoryError(f"猫「{record.cat}」：导出声音需要原始视频，文件已不存在")
                from .storage import sha256

                if sha256(source) != record.source_sha256:
                    raise FactoryError(
                        f"猫「{record.cat}」：原始视频已被修改，不能从其他版本导出声音"
                    )
                command += [
                    "-ss",
                    str(start / record.fps),
                    "-i",
                    str(source),
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:a",
                    "libopus",
                    "-t",
                    str(len(selected) / record.fps),
                ]
            else:
                command += ["-an"]
            command += [
                "-c:v",
                "libvpx-vp9",
                "-pix_fmt",
                "yuva420p",
                "-auto-alt-ref",
                "0",
                "-lossless",
                "1",
                str(video),
            ]
            run_tool(command)
            probe = json.loads(
                run_tool(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-show_streams",
                        "-of",
                        "json",
                        str(video),
                    ]
                )
            )["streams"][0]
            if probe["codec_name"] != "vp9" or str(probe.get("tags", {}).get("alpha_mode")) != "1":
                raise FactoryError(f"猫「{record.cat}」：编码结果缺少 VP9 透明通道标记")
            # 点击遮罩必须匹配最终视频实际解码的 alpha，而不是编码前的 PNG。
            # 用磁盘中间文件逐帧读取，避免把整段 alpha 放进内存。
            alpha_path = temporary / "decoded-alpha.raw"
            run_tool(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-c:v",
                    "libvpx-vp9",
                    "-i",
                    str(video),
                    "-vf",
                    "alphaextract",
                    "-pix_fmt",
                    "gray",
                    "-f",
                    "rawvideo",
                    str(alpha_path),
                ]
            )
            if alpha_path.stat().st_size != width * height * len(selected):
                raise FactoryError(f"猫「{record.cat}」：最终视频的解码帧数与导出区间不符")
            with alpha_path.open("rb") as alpha_stream, mask.open("xb") as mask_stream:
                for _ in selected:
                    alpha = np.frombuffer(alpha_stream.read(width * height), dtype=np.uint8)
                    mask_stream.write(
                        encode_hit_mask(alpha.reshape(height, width), options.hit_mask_scale)
                    )
            alpha_path.unlink()
            expected_bytes = math.ceil(
                math.ceil(width / options.hit_mask_scale)
                * math.ceil(height / options.hit_mask_scale)
                / 8
            ) * len(selected)
            if mask.stat().st_size != expected_bytes:
                raise FactoryError(f"猫「{record.cat}」：点击遮罩文件长度不符")
            write_json(clips / f"{basename}.json", metadata)
            write_json(temporary / "manifest.json", candidate)
            log["export_range"] = {"start": start, "end": end}
            log["duration_seconds"] = len(selected) / record.fps
            log["manual_seconds"] = confirmed.manual_seconds
            log["options"] = options.model_dump(mode="json")
            write_json(temporary / "export-log.json", log)
        return directory / "finalize" / "clips" / f"{basename}.json"
