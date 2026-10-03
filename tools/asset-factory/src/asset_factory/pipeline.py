import json
import shutil
from fractions import Fraction
from pathlib import Path
from uuid import uuid4

from PIL import Image

from .imaging import decontaminate, make_suggestion, preview
from .matting import MODEL_NAME, BiRefNet
from .models import Confirmation, IngestRecord, MatteRecord, Suggestion
from .storage import (
    FactoryError,
    job_path,
    load_record,
    new_directory,
    operation,
    run_tool,
    sha256,
    write_json,
)


def ingest(
    root: Path,
    source: Path,
    cat: str,
    generator_log: Path | None = None,
    *,
    job_id: str | None = None,
) -> str:
    source = source.resolve()
    if not source.is_file():
        raise FactoryError(f"猫「{cat}」：缺少原始视频 {source}")
    job = job_id or f"clip-{uuid4().hex[:16]}"
    destination = job_path(root, job)
    with operation(root, "ingest", cat, {"source": str(source), "job": job}):
        try:
            streams = json.loads(
                run_tool(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-select_streams",
                        "v:0",
                        "-show_streams",
                        "-of",
                        "json",
                        str(source),
                    ]
                )
            )["streams"]
            stream = streams[0]
            fps = float(Fraction(stream["avg_frame_rate"]))
            if not 0 < fps <= 120:
                raise ValueError("fps")
        except (KeyError, IndexError, ValueError, ZeroDivisionError) as error:
            raise FactoryError(f"猫「{cat}」：原始视频缺少有效视频轨或帧率（1～120）") from error
        with new_directory(destination) as temporary:
            frames = temporary / "frames"
            frames.mkdir()
            run_tool(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-i",
                    str(source),
                    "-map",
                    "0:v:0",
                    "-vf",
                    f"fps={stream['avg_frame_rate']}",
                    "-start_number",
                    "0",
                    str(frames / "%06d.png"),
                ]
            )
            paths = sorted(frames.glob("*.png"))
            if not paths:
                raise FactoryError(f"猫「{cat}」：视频没有解码出任何帧")
            log_name = None
            if generator_log:
                # 原样保留来源档案，不将实验生成器的记录当作正式共享格式。
                try:
                    json.loads(generator_log.read_text(encoding="utf-8"))
                except (OSError, ValueError) as error:
                    raise FactoryError(f"猫「{cat}」：生成器素材档案缺失或不是有效 JSON") from error
                log_name = "generator-log.json"
                shutil.copyfile(generator_log, temporary / log_name)
            record = IngestRecord(
                cat=cat,
                source=str(source),
                source_sha256=sha256(source),
                generator_log=log_name,
                fps=fps,
                frame_count=len(paths),
                width=int(stream["width"]),
                height=int(stream["height"]),
            )
            write_json(temporary / "ingest.json", record.model_dump(mode="json"))
    return job


def frame_paths(job: Path, record: IngestRecord, stage: str) -> list[Path]:
    paths = sorted((job / stage).glob("*.png"))
    if [path.name for path in paths] != [f"{i:06d}.png" for i in range(record.frame_count)]:
        raise FactoryError(f"猫「{record.cat}」：{stage} 帧缺失、编号不连续或数量不符")
    for path in paths:
        with Image.open(path) as image:
            if image.size != (record.width, record.height):
                raise FactoryError(f"猫「{record.cat}」：{path.name} 尺寸与拆帧记录不符")
            if stage == "matte" and image.mode != "RGBA":
                raise FactoryError(f"猫「{record.cat}」：{path.name} 缺少透明通道")
    return paths


def matte(root: Path, job: str, model: Path, model_hash: str, background: tuple[int, int, int]):
    directory = job_path(root, job)
    record = load_record(directory / "ingest.json", IngestRecord)
    with operation(root, "matte", record.cat, {"job": job, "background": background}) as log:
        if (directory / "matte").exists():
            raise FactoryError(f"猫「{record.cat}」：抠图结果已存在，请重新 ingest 建立新任务")
        paths = frame_paths(directory, record, "frames")
        predictor = BiRefNet(model, model_hash)
        matte_record = MatteRecord(
            model=MODEL_NAME,
            model_sha256=model_hash,
            runtime=predictor.version,
            providers=predictor.providers,
            background=background,
        )
        with new_directory(directory / "matte") as temporary:
            for index, path in enumerate(paths):
                with Image.open(path) as image:
                    alpha = predictor.predict(image)
                    decontaminate(image, alpha, background).save(temporary / path.name)
                if index % 24 == 0:
                    print(f"猫「{record.cat}」：抠图 {index + 1}/{len(paths)} 帧", flush=True)
            write_json(temporary / "matte.json", matte_record.model_dump(mode="json"))
        log["model"] = matte_record.model_dump(mode="json")


def suggest(root: Path, job: str, selection: Suggestion | None = None):
    directory = job_path(root, job)
    record = load_record(directory / "ingest.json", IngestRecord)
    with operation(root, "suggest", record.cat, {"job": job}):
        load_record(directory / "matte" / "matte.json", MatteRecord, record.cat)
        paths = frame_paths(directory, record, "matte")
        with new_directory(directory / "suggest") as temporary:
            selection = selection or make_suggestion(paths, record.fps, record.cat)
            write_json(temporary / "suggestion.json", selection.model_dump(mode="json"))
            template = Confirmation(
                selection=selection, manual_seconds=0.0, accepted=False, notes="尚未人工确认"
            )
            write_json(temporary / "confirmation-template.json", template.model_dump(mode="json"))
            preview(paths, temporary)


def confirm(root: Path, job: str, parameters: Path):
    directory = job_path(root, job)
    record = load_record(directory / "ingest.json", IngestRecord)
    with operation(root, "confirm", record.cat, {"job": job}) as log:
        original = load_record(directory / "suggest" / "suggestion.json", Suggestion, record.cat)
        confirmed = load_record(parameters, Confirmation, record.cat)
        selection = confirmed.selection
        if selection.cat != record.cat or len(selection.foot_anchors) != record.frame_count:
            raise FactoryError(f"猫「{record.cat}」：确认文件的猫或逐帧落脚锚点数量不符")
        if any(p.x >= record.width or p.y >= record.height for p in selection.foot_anchors):
            raise FactoryError(f"猫「{record.cat}」：确认的落脚锚点超出了原始画面")
        before, after = original.model_dump(), selection.model_dump()
        log["changed_fields"] = [key for key in before if before[key] != after[key]]
        log["changed_anchor_count"] = sum(
            a != b for a, b in zip(original.foot_anchors, selection.foot_anchors, strict=True)
        )
        log["manual_seconds"] = confirmed.manual_seconds
        log["accepted"] = confirmed.accepted
        log["notes"] = confirmed.notes
        write_json(directory / "confirmation.json", confirmed.model_dump(mode="json"))
