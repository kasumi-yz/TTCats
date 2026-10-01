"""真实 GPU 集成复现：仅自动接受本脚本绘制的合成球，不接受真实猫的候选。"""

import json
from datetime import UTC, datetime
from uuid import uuid4

from PIL import Image, ImageDraw

from asset_factory.export import finalize
from asset_factory.matting import MODEL_FILE
from asset_factory.models import Confirmation, Suggestion
from asset_factory.pipeline import confirm, ingest, matte, suggest
from asset_factory.storage import asset_root, job_path, load_record, run_tool, write_json

root = asset_root()
source_dir = root / "factory-tests" / f"synthetic-{uuid4().hex[:12]}"
source_dir.mkdir(parents=True)
for frame in range(17):
    # 周期 16，首尾完全相同；经过对齐的主体是恒定圆形。
    offset = frame if frame <= 8 else 16 - frame
    image = Image.new("RGB", (64, 64), (0, 180, 220))
    draw = ImageDraw.Draw(image)
    draw.ellipse((14 + offset, 20, 38 + offset, 44), fill=(220, 60, 20))
    image.save(source_dir / f"{frame:06d}.png")
source = source_dir / "synthetic.mkv"
run_tool(
    [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-framerate",
        "8",
        "-i",
        str(source_dir / "%06d.png"),
        "-c:v",
        "ffv1",
        str(source),
    ]
)
write_json(source_dir / "generator.json", {"generator": "synthetic-fixture", "version": 1})
job = ingest(root, source, "合成测试", source_dir / "generator.json")
model_dir = root / "models" / "birefnet-general-lite"
manifest = json.loads((model_dir / "model.json").read_text(encoding="utf-8"))
matte(root, job, model_dir / MODEL_FILE, manifest["sha256"], (0, 180, 220))
suggest(root, job)
directory = job_path(root, job)
selection = load_record(directory / "suggest" / "suggestion.json", Suggestion, "合成测试")
selection.loop_start, selection.loop_end = 0, 17
parameters = source_dir / "confirmation.json"
write_json(
    parameters,
    Confirmation(
        selection=selection,
        accepted=True,
        manual_seconds=0.0,
        notes="仅对本脚本绘制的合成球自动确认，用于链路验证，不是人挑选真实猫候选的记录。",
    ).model_dump(mode="json"),
)
confirm(root, job, parameters)
options = source_dir / "options.json"
write_json(
    options,
    {
        "cat_id": "synthetic-test",
        "asset_log": {
            "generator": "synthetic-fixture",
            "modelFiles": [],
            "prompt": "",
            "params": {"fps": 8},
            "attempt": 1,
            "startPoseFrame": str(source_dir / "000000.png"),
            "endPoseFrame": str(source_dir / "000016.png"),
            "rawVideo": str(source),
            "createdAt": datetime.now(UTC).isoformat(),
        },
        "name": "idle-stand",
        "variant": 1,
        "kind": "loop",
        "from_pose": "stand",
        "to_pose": "stand",
        "optional": False,
        "mirrorable": True,
        "facing": "right",
        "display_height": 192,
        "hit_mask_scale": 4,
    },
)
metadata = finalize(root, job, options)
print(json.dumps({"job": job, "metadata": str(metadata)}, ensure_ascii=False))
