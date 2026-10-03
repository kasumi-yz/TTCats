"""拎起高度映射与落地取帧派生；从解码源帧取样，不生成插值画面。"""

import shutil
from pathlib import Path
from uuid import uuid4

import numpy as np

from .models import ClipOptions, IngestRecord
from .pipeline import frame_paths
from .storage import (
    FactoryError,
    job_path,
    load_record,
    new_directory,
    run_tool,
    sha256,
    write_json,
)


def pickup_map(root, job, options_path=None):
    directory = job_path(root, job)
    record = load_record(directory / "ingest.json", IngestRecord)
    options = load_record(options_path or directory / "auto/options.json", ClipOptions, record.cat)
    points = options.keypoints.get("scruff")
    if not points or len(points) != record.frame_count or any(point is None for point in points):
        raise FactoryError(
            f"猫「{record.cat}」：拎起映射需要完整的逐帧 scruff 后颈轨迹，不能填造缺帧"
        )
    if any(p.x >= record.width or p.y >= record.height for p in points):
        raise FactoryError(f"猫「{record.cat}」：scruff 后颈轨迹超出原始画面")
    heights = np.array([points[0].y - p.y for p in points])
    monotonic = np.maximum.accumulate(np.maximum(heights, 0))
    if monotonic[-1] <= 0:
        raise FactoryError(f"猫「{record.cat}」：后颈没有上移，无法建立鼠标高度映射")
    entries = [{"height": 0.0, "frame": 0}]
    for index, height in enumerate(monotonic[1:], 1):
        if height > entries[-1]["height"]:
            entries.append({"height": float(height), "frame": index})
    value = {
        "record_version": 1,
        "source_sha256": record.source_sha256,
        "options_sha256": sha256(options_path or directory / "auto/options.json"),
        "fps": record.fps,
        "height_to_frame": entries,
        "max_monotonic_correction": float(np.max(np.abs(monotonic - heights))),
        "reverse_speed": 3.0,
        "reasons": [
            "高度映射使用原始像素；游戏应换算显示比例，鼠标停止时暂停选帧。",
            "单调包络仅是建议，仍须审查后颈匹配和接地脚部；保留按下时抓取偏移。",
            "悬空保持画面，半途松手按原 fps 的 3 倍倒回；本命令不修改游戏行为。",
        ],
    }
    destination = directory / f"pickup-map-{uuid4().hex[:8]}.json"
    write_json(destination, value)
    return destination


def land_indices(frame_count, start, end, seconds, fps, curve):
    if not 0 <= start < end <= frame_count:
        raise FactoryError("落地裁剪区间越界，结束帧不包含在内")
    if not np.isfinite(seconds) or seconds <= 0 or not np.isfinite(fps) or not 1 <= fps <= 120:
        raise FactoryError("落地派生需要有限的正时长和 1～120 fps")
    count = round(seconds * fps)
    if not 2 <= count <= 14400:
        raise FactoryError("落地派生帧数必须在 2～14400 之间")
    positions = np.linspace(0, 1, count)
    if curve == "ease-out":
        positions = 1 - (1 - positions) ** 2
    elif curve != "linear":
        raise FactoryError("取帧曲线应为 linear 或 ease-out")
    return np.rint(start + positions * (end - 1 - start)).astype(int).tolist()


def derive_land(root, job, start, end, seconds, fps=48.0, curve="linear"):
    directory = job_path(root, job)
    record = load_record(directory / "ingest.json", IngestRecord)
    if sha256(Path(record.source)) != record.source_sha256:
        raise FactoryError(f"猫「{record.cat}」：源视频哈希已变化，不能派生")
    paths = frame_paths(directory, record, "frames")
    indices = land_indices(record.frame_count, start, end, seconds, fps, curve)
    destination = root / "derivations" / f"land-{uuid4().hex[:16]}"
    with new_directory(destination) as temporary:
        frames = temporary / "frames"
        frames.mkdir()
        for index, source_index in enumerate(indices):
            shutil.copyfile(paths[source_index], frames / f"{index:06d}.png")
        command = [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-framerate",
            str(fps),
            "-i",
            str(frames / "%06d.png"),
            "-an",
            "-c:v",
            "ffv1",
            str(temporary / "raw.mkv"),
        ]
        run_tool(command)
        write_json(
            temporary / "derivation.json",
            {
                "record_version": 1,
                "cat": record.cat,
                "source": record.source,
                "source_sha256": record.source_sha256,
                "derived": str(destination / "raw.mkv"),
                "derived_sha256": sha256(temporary / "raw.mkv"),
                "source_frame_indices": indices,
                "curve": curve,
                "range": {"start": start, "end": end},
                "fps": fps,
                "requested_seconds": seconds,
                "actual_seconds": len(indices) / fps,
                "ffmpeg_command": command,
                "note": "源帧选取、无插帧；原始严格初筛结果保留。派生需重新批处理并重算显示高度。",
            },
        )
    return destination / "raw.mkv"
