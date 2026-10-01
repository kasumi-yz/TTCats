import json
import math
import shutil
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from asset_factory import pipeline
from asset_factory.cli import color
from asset_factory.imaging import decontaminate, make_suggestion, preview
from asset_factory.models import Confirmation, IngestRecord, MatteRecord, Suggestion
from asset_factory.storage import (
    FactoryError,
    asset_root,
    job_path,
    load_record,
    new_directory,
    run_tool,
    sha256,
    write_json,
)


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("TTCATS_ASSET_ROOT", str(tmp_path))
    return asset_root()


@pytest.fixture
def video(root):
    # 测试环境提供本机工具或固定开发依赖；缺工具必须失败，不能跳过处理链验证。
    assert shutil.which("ffmpeg"), "合成视频集成测试需要 PATH 中有 ffmpeg"
    assert shutil.which("ffprobe"), "合成视频集成测试需要 PATH 中有 ffprobe"
    frames = root / "synthetic"
    frames.mkdir()
    for index in range(8):
        image = Image.new("RGB", (64, 48), (0, 180, 220))
        draw = ImageDraw.Draw(image)
        draw.rectangle((10 + index, 10, 25 + index, 35), fill=(220, 60, 20))
        image.save(frames / f"{index:06d}.png")
    source = root / "合成片段.mkv"
    run_tool(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-framerate",
            "8",
            "-i",
            str(frames / "%06d.png"),
            "-c:v",
            "ffv1",
            str(source),
        ]
    )
    return source


class FakeBiRefNet:
    """测试替身：只隔离模型下载/显卡，不把它作为真实 AI 通过证据。"""

    def __init__(self, path, expected_sha256):
        self.version = "test-double"
        self.providers = ["test-double"]

    def predict(self, image):
        rgb = np.asarray(image)
        return Image.fromarray(np.where(rgb[..., 0] > 100, 255, 0).astype(np.uint8))


def test_synthetic_pipeline_and_manual_edits(root, video, monkeypatch):
    generator_log = root / "generator.json"
    write_json(generator_log, {"generator": "synthetic-test", "version": "1"})
    job = pipeline.ingest(root, video, "测试猫", generator_log)
    directory = job_path(root, job)
    ingested = load_record(directory / "ingest.json", IngestRecord)
    assert ingested.frame_count == 8
    assert ingested.fps == 8
    assert ingested.source_sha256 == sha256(video)
    assert (directory / "generator-log.json").read_bytes() == generator_log.read_bytes()
    monkeypatch.setattr(pipeline, "BiRefNet", FakeBiRefNet)
    pipeline.matte(root, job, Path("unused"), "test", (0, 180, 220))
    pipeline.suggest(root, job)
    suggested = load_record(directory / "suggest" / "suggestion.json", Suggestion)
    assert suggested.foot_anchors[0].y == 35
    assert suggested.speed == pytest.approx(8)
    assert suggested.loop_end - suggested.loop_start >= 4
    for name in ("dark", "light"):
        with Image.open(directory / "suggest" / f"preview-{name}.png") as preview:
            assert preview.size == (512, 1536)
    selection = suggested.model_copy(deep=True)
    selection.speed = 7.0
    selection.foot_anchors[0].x += 1
    confirmed = Confirmation(selection=selection, manual_seconds=30.0, accepted=True, notes="测试")
    parameters = root / "人工确认.json"
    write_json(parameters, confirmed.model_dump(mode="json"))
    pipeline.confirm(root, job, parameters)
    logs = [
        json.loads(p.read_text(encoding="utf-8")) for p in (root / "factory-logs").glob("*.json")
    ]
    assert len(logs) == 4
    log = next(item for item in logs if item["stage"] == "confirm")
    assert log["changed_anchor_count"] == 1
    assert set(log["changed_fields"]) == {"speed", "foot_anchors"}
    assert log["manual_seconds"] == 30
    assert all(item["elapsed_seconds"] >= 0 and item["status"] == "success" for item in logs)
    # 上面故意改错一帧锚点验证改动统计；导出前恢复正确锚点再确认。
    confirmed.selection.foot_anchors[0].x -= 1
    write_json(parameters, confirmed.model_dump(mode="json"))
    pipeline.confirm(root, job, parameters)
    from asset_factory.export import finalize, validate_clip

    options = {
        "cat_id": "test-cat",
        "asset_log": {
            "generator": "synthetic-fixture",
            "modelFiles": [],
            "prompt": "",
            "params": {"fps": 8},
            "attempt": 1,
            "startPoseFrame": "000000.png",
            "endPoseFrame": "000007.png",
            "rawVideo": str(video),
            "createdAt": datetime.now(UTC).isoformat(),
        },
        "name": "walk",
        "variant": 1,
        "kind": "loop",
        "from_pose": "stand",
        "to_pose": "stand",
        "optional": False,
        "mirrorable": True,
        "facing": "right",
        "display_height": 32,
        "hit_mask_scale": 4,
        "keypoints": {"nose": [{"x": 20.0 + i, "y": 12.0} for i in range(8)]},
    }
    options_path = root / "options.json"
    write_json(options_path, options)
    metadata_path = finalize(root, job, options_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    validate_clip(metadata, "测试猫")
    assert metadata["height"] == 64
    manifest = json.loads((metadata_path.parents[1] / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["cat"] == "test-cat" and manifest["clip"] == metadata
    assert len(metadata["keypoints"]["nose"]) == metadata["frameCount"]
    assert len(set((p["x"], p["y"]) for p in metadata["footAnchors"])) == 1
    video = metadata_path.with_suffix(".webm")
    decoded = root / "decoded"
    decoded.mkdir()
    # 原生 VP9 解码器可能不读 alpha；显式使用 libvpx-vp9 证明透明数据真实存在。
    run_tool(
        ["ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", str(video), str(decoded / "%06d.png")]
    )
    frames = sorted(decoded.glob("*.png"))
    assert len(frames) == metadata["frameCount"]
    with Image.open(frames[0]) as frame:
        alpha = np.asarray(frame.getchannel("A"))
        assert alpha.min() == 0 and alpha.max() == 255
    # 选取的循环帧按锚点对齐后应完全静止，首尾没有位移跳变。
    with Image.open(frames[0]) as first, Image.open(frames[-1]) as last:
        assert np.array_equal(np.asarray(first), np.asarray(last))
    with pytest.raises(FactoryError, match="已存在"):
        pipeline.suggest(root, job)
    assert (directory / "confirmation.json").is_file()


def test_failed_matte_does_not_publish_partial_results(root, video, monkeypatch):
    job = pipeline.ingest(root, video, "测试猫")

    class Broken(FakeBiRefNet):
        def predict(self, image):
            raise FactoryError("模拟显卡故障")

    monkeypatch.setattr(pipeline, "BiRefNet", Broken)
    with pytest.raises(FactoryError, match="显卡故障"):
        pipeline.matte(root, job, Path("unused"), "test", (0, 180, 220))
    directory = job_path(root, job)
    assert not (directory / "matte").exists()
    assert not list(directory.glob(".processing-*"))
    log = json.loads(next((root / "factory-logs").glob("matte-*.json")).read_text(encoding="utf-8"))
    assert log["status"] == "failed"


def test_missing_frames_rejected(root, video):
    job = pipeline.ingest(root, video, "测试猫")
    directory = job_path(root, job)
    (directory / "frames" / "000003.png").unlink()
    record = load_record(directory / "ingest.json", IngestRecord)
    with pytest.raises(FactoryError, match="测试猫.*缺失"):
        pipeline.frame_paths(directory, record, "frames")


def test_decontaminate_preserves_subject_and_unmixes_fringe():
    # foreground = red, background = cyan, 50% 覆盖率的像素混合。
    rgb = Image.fromarray(np.array([[[255, 0, 0], [128, 127, 127], [0, 255, 255]]], np.uint8))
    alpha = Image.fromarray(np.array([[255, 128, 0]], np.uint8))
    result = np.asarray(decontaminate(rgb, alpha, (0, 255, 255)))
    assert tuple(result[0, 0]) == (255, 0, 0, 255)
    assert tuple(result[0, 1]) == (255, 0, 0, 128)
    assert tuple(result[0, 2]) == (0, 0, 0, 0)


def test_empty_subject_is_not_given_fake_anchor(tmp_path):
    path = tmp_path / "blank.png"
    Image.new("RGBA", (16, 16)).save(path)
    with pytest.raises(FactoryError, match="测试猫.*没有可见主体"):
        make_suggestion([path, path], 24, "测试猫")


@pytest.mark.parametrize("value", ["../escape", "a/b", "C:\\temp", "", "大写", "UPPER"])
def test_job_cannot_escape(root, value):
    with pytest.raises(FactoryError):
        job_path(root, value)


def test_missing_environment_is_chinese(monkeypatch):
    monkeypatch.delenv("TTCATS_ASSET_ROOT", raising=False)
    with pytest.raises(FactoryError, match="未设置"):
        asset_root()


def test_validation_names_cat_and_missing_field(root):
    path = root / "invalid.json"
    write_json(path, {"cat": "测试猫"})
    with pytest.raises(FactoryError, match="测试猫.*frame_count.*缺失"):
        load_record(path, IngestRecord, "测试猫")


def test_transaction_keeps_existing_results(root):
    directory = root / "existing"
    directory.mkdir()
    (directory / "keep.txt").write_text("保留", encoding="utf-8")
    with pytest.raises(FactoryError):
        with new_directory(directory):
            pytest.fail("不得进入覆盖操作")
    assert (directory / "keep.txt").read_text(encoding="utf-8") == "保留"


@pytest.mark.parametrize("value", ["1,2", "256,2,3", "1,x,3", "-1,2,3"])
def test_background_validation(value):
    import argparse

    with pytest.raises(argparse.ArgumentTypeError):
        color(value)


def test_matte_record_rejects_unknown_fields():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        MatteRecord.model_validate({"extra": True})


def test_hit_mask_partial_cells_threshold_and_bit_order():
    from asset_factory.export import encode_hit_mask

    # 第一个 2×2 格恰好半数不透明，均值 127.5 不命中；边缘不满格只算实际像素。
    alpha = np.array([[255, 0, 128], [0, 255, 128], [0, 0, 255]], dtype=np.uint8)
    assert encode_hit_mask(alpha, 2) == bytes([0b1010])
    assert encode_hit_mask(np.full((1, 10), 255, np.uint8), 1) == bytes([255, 3])


def test_asset_root_rejects_other_repository(tmp_path, monkeypatch):
    (tmp_path / ".git").mkdir()
    monkeypatch.setenv("TTCATS_ASSET_ROOT", str(tmp_path / "素材库"))
    with pytest.raises(FactoryError, match="仓库外"):
        asset_root()


def test_loop_suggestion_excludes_repeated_endpoint(tmp_path):
    period = 12
    paths = []
    for index in range(period + 1):
        phase = index * 2 * math.pi / period
        rx, ry = 16 + 5 * math.sin(phase), 16 + 5 * math.cos(phase)
        image = Image.new("RGBA", (80, 80))
        ImageDraw.Draw(image).ellipse((40 - rx, 60 - 2 * ry, 40 + rx, 60), fill=(220, 60, 20, 255))
        path = tmp_path / f"{index:06d}.png"
        image.save(path)
        paths.append(path)
    selection = make_suggestion(paths, 12, "测试猫")
    assert (selection.loop_start, selection.loop_end) == (0, period)


def test_preview_crops_to_subject(tmp_path):
    source = tmp_path / "subject.png"
    image = Image.new("RGBA", (1344, 768))
    ImageDraw.Draw(image).rectangle((650, 350, 673, 373), fill=(255, 0, 0, 255))
    image.save(source)
    preview([source], tmp_path)
    with Image.open(tmp_path / "preview-dark.png") as sheet:
        rgb = np.asarray(sheet)
        red = (rgb[..., 0] > 200) & (rgb[..., 1] < 40)
        assert red[:, :256].sum() > 10000
