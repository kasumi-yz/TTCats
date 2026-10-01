import json
from datetime import UTC, datetime

import numpy as np
import pytest
from PIL import Image

from asset_factory import pipeline
from asset_factory.export import encode_hit_mask, finalize, read_slots, validate_clip
from asset_factory.models import Confirmation, IngestRecord
from asset_factory.storage import FactoryError, job_path, load_record, run_tool, write_json


@pytest.fixture
def ready(tmp_path):
    """已经抠好的极小合成候选，覆盖导出边界，不伪装成 AI 结果。"""
    job = "test-export"
    directory = job_path(tmp_path, job)
    matte = directory / "matte"
    matte.mkdir(parents=True)
    paths = []
    for index in range(3):
        rgba = np.zeros((16, 16, 4), dtype=np.uint8)
        rgba[4:12, 4 + index : 10 + index, :3] = (220, 60, 20)
        rgba[4:12, 4 + index : 10 + index, 3] = 255
        rgba[4:12, 3 + index, 3] = 127
        path = matte / f"{index:06d}.png"
        Image.fromarray(rgba).save(path)
        paths.append(path)
    record = IngestRecord(
        cat="测试猫",
        source="synthetic",
        source_sha256="unused",
        generator_log=None,
        fps=8.0,
        frame_count=3,
        width=16,
        height=16,
    )
    write_json(directory / "ingest.json", record.model_dump(mode="json"))
    from asset_factory.imaging import make_suggestion

    selection = make_suggestion(paths, record.fps, record.cat)
    write_json(directory / "suggest" / "suggestion.json", selection.model_dump(mode="json"))
    confirmation = Confirmation(
        selection=selection, accepted=True, manual_seconds=0.0, notes="测试"
    )
    write_json(directory / "confirmation.json", confirmation.model_dump(mode="json"))
    options = {
        "cat_id": "test-cat",
        "asset_log": {
            "generator": "synthetic-fixture",
            "modelFiles": [],
            "prompt": "",
            "params": {},
            "attempt": 1,
            "startPoseFrame": "000000.png",
            "endPoseFrame": "000002.png",
            "rawVideo": "synthetic",
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
        "display_height": 16,
        "hit_mask_scale": 3,
    }
    options_path = tmp_path / "options.json"
    write_json(options_path, options)
    return tmp_path, job, directory, options_path, options, confirmation


def test_unaccepted_candidate_cannot_export(ready):
    root, job, directory, options_path, _, confirmation = ready
    confirmation.accepted = False
    write_json(directory / "confirmation.json", confirmation.model_dump(mode="json"))
    with pytest.raises(FactoryError, match="测试猫.*尚未人工确认"):
        finalize(root, job, options_path)
    assert not (directory / "finalize").exists()


@pytest.mark.parametrize("missing", ["generator", "rawVideo"])
def test_missing_provenance_prevents_export(ready, missing):
    root, job, directory, options_path, options, _ = ready
    del options["asset_log"][missing]
    write_json(options_path, options)
    with pytest.raises(FactoryError, match=f"测试猫.*assetLog.{missing} 缺失"):
        finalize(root, job, options_path)
    assert not (directory / "finalize").exists()


def test_provenance_must_refer_to_this_source(ready):
    root, job, directory, options_path, options, _ = ready
    options["asset_log"]["rawVideo"] = "another-video.mp4"
    write_json(options_path, options)
    with pytest.raises(FactoryError, match="测试猫.*rawVideo"):
        finalize(root, job, options_path)
    assert not (directory / "finalize").exists()


def test_export_mask_matches_encoded_soft_alpha(ready):
    root, job, _, options_path, _, _ = ready
    metadata_path = finalize(root, job, options_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    alpha_path = root / "alpha.raw"
    run_tool(
        [
            "ffmpeg",
            "-v",
            "error",
            "-c:v",
            "libvpx-vp9",
            "-i",
            str(metadata_path.with_suffix(".webm")),
            "-vf",
            "alphaextract",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            str(alpha_path),
        ]
    )
    decoded = np.frombuffer(alpha_path.read_bytes(), dtype=np.uint8).reshape(
        metadata["frameCount"], metadata["height"], metadata["width"]
    )
    expected = b"".join(encode_hit_mask(frame, metadata["hitMaskScale"]) for frame in decoded)
    assert expected == metadata_path.with_suffix(".hitmask.bin").read_bytes()
    log = json.loads((metadata_path.parents[1] / "export-log.json").read_text(encoding="utf-8"))
    assert log["video_bytes"] == metadata_path.with_suffix(".webm").stat().st_size
    assert log["encoding"]["crf"] == 32


@pytest.mark.parametrize(
    "field,value",
    [
        ("from_pose", "sit"),
        ("kind", "transition"),
        ("name", "custom-required"),
    ],
)
def test_slot_semantics_checked_before_encoding(ready, field, value):
    root, job, directory, options_path, options, _ = ready
    options[field] = value
    write_json(options_path, options)
    with pytest.raises(FactoryError, match="测试猫"):
        finalize(root, job, options_path)
    assert not (directory / "finalize").exists()


def test_bad_keypoint_count_prevents_export(ready):
    root, job, _, options_path, options, _ = ready
    options["keypoints"] = {"nose": [None]}
    write_json(options_path, options)
    with pytest.raises(FactoryError, match="测试猫.*关键点 nose"):
        finalize(root, job, options_path)


@pytest.mark.parametrize("with_audio", [False, True])
def test_sound_marker_exports_silent_video(ready, with_audio):
    root, job, directory, options_path, options, _ = ready
    source = root / "source.mkv"
    command = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16:r=8:d=1"]
    if with_audio:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le"]
    run_tool(command + ["-c:v", "ffv1", str(source)])
    record = load_record(directory / "ingest.json", IngestRecord)
    record.source = str(source)
    write_json(directory / "ingest.json", record.model_dump(mode="json"))
    options["sound_start_frame"] = 1
    options["asset_log"]["rawVideo"] = str(source)
    write_json(options_path, options)
    metadata_path = finalize(root, job, options_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["soundStartFrame"] == 1
    streams = json.loads(
        run_tool(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_streams",
                "-of",
                "json",
                str(metadata_path.with_suffix(".webm")),
            ]
        )
    )["streams"]
    assert not any(stream["codec_type"] == "audio" for stream in streams)


def test_manual_anchor_outside_frame_rejected(ready):
    root, job, directory, _, _, confirmation = ready
    confirmation.selection.foot_anchors[0].x = 99.0
    parameters = root / "bad-confirmation.json"
    write_json(parameters, confirmation.model_dump(mode="json"))
    with pytest.raises(FactoryError, match="测试猫.*超出了"):
        pipeline.confirm(root, job, parameters)


def test_fractional_coordinates_are_kept(ready):
    root, job, directory, options_path, _, confirmation = ready
    for point in confirmation.selection.foot_anchors:
        point.x += 0.25
    write_json(directory / "confirmation.json", confirmation.model_dump(mode="json"))
    metadata = json.loads(finalize(root, job, options_path).read_text(encoding="utf-8"))
    validate_clip(metadata, "测试猫")
    assert all(point["x"] == metadata["footAnchors"][0]["x"] for point in metadata["footAnchors"])


@pytest.mark.parametrize("field", ["fps", "name"])
def test_clip_required_error_names_field(ready, field):
    root, job, _, options_path, _, _ = ready
    metadata = json.loads(finalize(root, job, options_path).read_text(encoding="utf-8"))
    del metadata[field]
    with pytest.raises(FactoryError, match=f"测试猫.*{field} 缺失"):
        validate_clip(metadata, "测试猫")


def test_extra_provenance_field_names_field(ready):
    root, job, _, options_path, options, _ = ready
    options["asset_log"]["unexpected"] = True
    write_json(options_path, options)
    with pytest.raises(FactoryError, match="测试猫.*assetLog.unexpected 是额外字段"):
        finalize(root, job, options_path)


def test_partial_slot_read_fails():
    source = """export const CLIP_SLOTS = {
    walk: { kind: 'loop', from: 'stand', to: 'stand', need: 'required' },
    run: { kind: 'loop', /* comment */ from: 'stand', to: 'stand', need: 'optional' }
    } as const"""
    with pytest.raises(FactoryError, match="未被完整读取"):
        read_slots(source)
