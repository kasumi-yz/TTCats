"""从两份实际成品解码，记录自动/手工差异并生成同尺寸深浅背景图。"""

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from asset_factory.storage import FactoryError, sha256, write_json


def measure(path):
    path = path.resolve()
    clip = json.loads(path.read_text(encoding="utf-8"))
    folder = path.parent.parent
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    log = json.loads((folder / "export-log.json").read_text(encoding="utf-8"))
    job = folder.parent
    selection_path = job / (
        "auto/selection.json" if manifest["status"] == "pending" else "confirmation.json"
    )
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    if "selection" in selection:
        selection = selection["selection"]
    video = folder / clip["video"]
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-c:v",
        "libvpx-vp9",
        "-i",
        str(video),
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    result = subprocess.run(command, check=True, capture_output=True, timeout=180)
    frames = np.frombuffer(result.stdout, dtype=np.uint8).reshape(
        (clip["frameCount"], clip["height"], clip["width"], 4)
    )
    alpha = frames[..., 3].astype(float) / 255
    seam = float(np.mean(np.abs(alpha[0] - alpha[-1])))
    adjacent = float(np.mean(np.abs(np.diff(alpha, axis=0)))) if len(alpha) > 1 else 0.0
    value = {
        "manifest": str(folder / "manifest.json"),
        "source_sha256": sha256(Path(manifest["assetLog"]["rawVideo"])),
        "video_sha256": sha256(video),
        "status": manifest["status"],
        "range": log["export_range"],
        "fps": clip["fps"],
        "frame_count": clip["frameCount"],
        "duration_seconds": clip["frameCount"] / clip["fps"],
        "width": clip["width"],
        "height": clip["height"],
        "display_height": log["options"]["display_height"],
        "raw_speed": selection["speed"],
        "display_speed": clip["speed"],
        "alpha_seam_mean_error": seam,
        "alpha_adjacent_mean_error": adjacent,
        "alpha_seam_to_adjacent_ratio": seam / adjacent if adjacent > 0 else None,
        "nose_missing_frames": sum(p is None for p in clip["keypoints"].get("nose", [])),
        "assessment": manifest.get("assessment"),
    }
    return value, clip, frames[0], selection


def compare(manual, automatic, destination):
    first, first_clip, first_frame, first_selection = measure(manual)
    second, second_clip, second_frame, second_selection = measure(automatic)
    if first["source_sha256"] != second["source_sha256"]:
        raise FactoryError("比较必须使用同一个原视频，不能替换历史证据")
    destination.mkdir(parents=True, exist_ok=True)
    differences = {}
    for key in (
        "frame_count",
        "duration_seconds",
        "width",
        "height",
        "display_height",
        "raw_speed",
        "display_speed",
        "alpha_seam_mean_error",
    ):
        differences[key] = second[key] - first[key]
    start = max(first["range"]["start"], second["range"]["start"])
    end = min(first["range"]["end"], second["range"]["end"])
    if start < end:
        offsets = [
            abs(first_selection["foot_anchors"][i]["x"] - second_selection["foot_anchors"][i]["x"])
            for i in range(start, end)
        ]
        differences["raw_anchor_x_mean_absolute_error"] = float(np.mean(offsets))
    sheet = Image.new("RGB", (1100, 750))
    draw = ImageDraw.Draw(sheet)
    for row, color in enumerate(((30, 30, 35), (235, 235, 240))):
        for col, (label, clip, frame) in enumerate(
            (
                ("Manual", first_clip, first_frame),
                ("Automatic - pending", second_clip, second_frame),
            )
        ):
            panel = Image.new("RGB", (550, 375), color)
            image = Image.fromarray(frame).resize((clip["width"] // 2, clip["height"] // 2))
            anchor = clip["footAnchors"][0]
            x, y = round(270 - anchor["x"] / 2), round(330 - anchor["y"] / 2)
            panel.paste(image, (x, y), image)
            sheet.paste(panel, (col * 550, row * 375))
            draw.text(
                (col * 550 + 10, row * 375 + 10), label, fill="white" if row == 0 else "black"
            )
    sheet.save(destination / "comparison.png")
    report = {
        "record_version": 1,
        "manual": first,
        "automatic": second,
        "differences": differences,
        "note": "成品解码量测与单帧对照；不代表新画面获用户认可或真实桌面交互通过。",
    }
    write_json(destination / "comparison.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manual", type=Path)
    parser.add_argument("automatic", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(
        json.dumps(compare(args.manual, args.automatic, args.output), ensure_ascii=False, indent=2)
    )
