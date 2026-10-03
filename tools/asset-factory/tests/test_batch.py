import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from test_pipeline import FakeBiRefNet

from asset_factory import batch, generation, pipeline
from asset_factory.automation import display_height, track_landmark
from asset_factory.batch_models import Landmark
from asset_factory.derivation import derive_land, land_indices, pickup_map
from asset_factory.models import Point
from asset_factory.storage import FactoryError, run_tool, sha256, write_json


@pytest.fixture
def example(tmp_path, monkeypatch):
    frames = tmp_path / "source-frames"
    frames.mkdir()
    for index in range(10):
        image = Image.new("RGB", (64, 48), (0, 180, 220))
        draw = ImageDraw.Draw(image)
        draw.rectangle((10 + index, 10, 26 + index, 35), fill=(220, 60, 20))
        draw.rectangle((15 + index, 14, 18 + index, 18), fill=(10, 10, 10))
        image.save(frames / f"{index:06d}.png")
    source = tmp_path / "source.mkv"
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
    pose = frames / "000000.png"
    log = {
        "generator": "synthetic-test",
        "modelFiles": [],
        "prompt": "",
        "params": {},
        "attempt": 1,
        "startPoseFrame": str(pose),
        "endPoseFrame": str(pose),
        "rawVideo": str(source),
        "createdAt": "2026-10-03T00:00:00Z",
    }
    config = {
        "id": "synthetic-batch",
        "cat": {
            "id": "test-cat",
            "name": "测试猫",
            "appearance": "测试外貌",
            "background": [0, 180, 220],
            "width": 64,
            "height": 48,
            "stand_height": 26.0,
            "display_height": 16,
            "rear_foot": {"x": 12.0, "y": 35.0},
            "ground_y": 35.0,
            "poses": {"stand": str(pose)},
        },
        "clips": [
            {
                "name": "walk",
                "kind": "loop",
                "from_pose": "stand",
                "to_pose": "stand",
                "anchor_mode": "translation",
                "inputs": [{"seed": 42, "path": str(source), "asset_log": log}],
            }
        ],
    }
    path = tmp_path / "config.json"
    write_json(path, config)
    root = tmp_path / "library"
    model = root / "models/birefnet-general-lite/model.json"
    write_json(model, {"sha256": "test"})
    monkeypatch.setattr(pipeline, "BiRefNet", FakeBiRefNet)
    return root, path, config, source


def test_resume_after_matte_and_all_candidates_remain_pending(example, monkeypatch):
    root, path, config, _ = example
    config["clips"][0]["inputs"].append({**config["clips"][0]["inputs"][0], "seed": 43})
    write_json(path, config)
    original = pipeline.suggest
    calls = []

    def interrupted(*args):
        calls.append(args[1])
        raise KeyboardInterrupt()

    monkeypatch.setattr(pipeline, "suggest", interrupted)
    with pytest.raises(KeyboardInterrupt):
        batch.run_batch(root, path)
    state_path = root / "batches/synthetic-batch/state.json"
    job = json.loads(state_path.read_text(encoding="utf-8"))["tasks"]["walk-42"]["job"]
    matte_time = (root / "factory" / job / "matte/matte.json").stat().st_mtime_ns
    monkeypatch.setattr(pipeline, "suggest", original)
    report = json.loads(batch.run_batch(root, path).read_text(encoding="utf-8"))
    assert report["complete"] and len(report["candidates"]) == 2
    assert report["candidates"][0]["job"] == job
    assert (root / "factory" / job / "matte/matte.json").stat().st_mtime_ns == matte_time
    manifests = [Path(c["manifest"]) for c in report["candidates"]]
    hashes = [sha256(p) for p in manifests]
    for candidate in manifests:
        value = json.loads(candidate.read_text(encoding="utf-8"))
        assert value["status"] == "pending"
        assert 0 <= value["assessment"]["score"] <= 100
        assert "脚是否打滑" in " ".join(value["assessment"]["reasons"])
        assert not (candidate.parent.parent / "confirmation.json").exists()
        directory = candidate.parent.parent
        assert (directory / "auto/selection.json").read_bytes() == (
            directory / "suggest/suggestion.json"
        ).read_bytes()
    again = json.loads(batch.run_batch(root, path).read_text(encoding="utf-8"))
    assert again == report
    assert [sha256(p) for p in manifests] == hashes
    assert len(list((root / "factory").iterdir())) == 2
    # 分数再差也不是接受或淘汰，不能从现有 finalize 绕过人工确认。
    with pytest.raises(FactoryError, match="confirmation"):
        from asset_factory.export import finalize

        finalize(root, job, root / "factory" / job / "auto/options.json")


def test_input_changes_and_corrupt_outputs_are_refused(example):
    root, path, config, _ = example
    report = json.loads(batch.run_batch(root, path).read_text(encoding="utf-8"))
    candidate = Path(report["candidates"][0]["manifest"])
    candidate.write_text("{}", encoding="utf-8")
    with pytest.raises(FactoryError, match="尚未完成"):
        batch.run_batch(root, path)
    errors = json.loads((root / "batches/synthetic-batch/report.json").read_text(encoding="utf-8"))[
        "failures"
    ]
    assert "变化或缺失" in errors[0]["error"]
    config["cat"]["background"] = [0, 181, 220]
    write_json(path, config)
    with pytest.raises(FactoryError, match="配置或输入已变化"):
        batch.run_batch(root, path)


def test_config_validation_names_the_cat(example):
    _, path, config, _ = example
    del config["cat"]["stand_height"]
    write_json(path, config)
    with pytest.raises(FactoryError, match="测试猫.*stand_height"):
        batch.load_config(path)


@pytest.mark.parametrize("content", ["[]", '{"cat": null}', "invalid-json"])
def test_malformed_config_is_a_chinese_error(tmp_path, content):
    path = tmp_path / "bad.json"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(FactoryError, match="猫「未知猫」"):
        batch.load_config(path)


def test_os_lock_released_after_process_exit(tmp_path):
    script = (
        "from pathlib import Path; from asset_factory.batch import batch_lock; "
        "import sys, os; "
        "\nwith batch_lock(Path(sys.argv[1])): "
        "print('locked', flush=True); sys.stdin.readline(); os._exit(7)"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", script, str(tmp_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdout.readline().strip() == "locked"
        with pytest.raises(FactoryError, match="另一个工厂"):
            with batch.batch_lock(tmp_path):
                pytest.fail("不应获得别的进程的锁")
    finally:
        proc.stdin.write("\n")
        proc.stdin.flush()
        proc.wait(timeout=10)
    with batch.batch_lock(tmp_path):
        assert (tmp_path / "batch.lock").exists()


@pytest.mark.parametrize("lost_response", [False, True])
def test_generation_resume_does_not_resubmit(example, monkeypatch, lost_response):
    root, path, config, source = example
    config["clips"][0].pop("inputs")
    config["clips"][0].update(prompt="原文 {appearance}", seeds=[42])
    config["cat"].update(height=64, width=64)
    write_json(path, config)
    module = generation.generator_module()
    submitted, client_ids = [], []
    workflow = json.loads(module.WORKFLOW.read_text(encoding="utf-8"))
    info = {node["class_type"]: {"input": {"required": {}}} for node in workflow.values()}
    for node in workflow.values():
        for key in ("unet_name", "clip_name", "vae_name"):
            if key in node["inputs"]:
                info[node["class_type"]]["input"]["required"].setdefault(key, [[]])[0].append(
                    node["inputs"][key]
                )

    class Client:
        def __init__(self, url):
            pass

        def upload(self, file):
            return file.name

        def json(self, route, payload=None):
            if route == "/object_info":
                return info
            if route == "/system_stats":
                return {"system": {"comfyui_version": "test"}}
            if route == "/prompt":
                submitted.append(payload)
                client_ids.append(payload["client_id"])
                if lost_response:
                    raise module.GeneratorError("模拟服务端收到提交，但响应丢失")
                return {"prompt_id": "stable-id"}
            if route == "/queue":
                return {"queue_running": [[1, "stable-id", {}, {"client_id": client_ids[0]}]]}
            return {}

        def request(self, route, **kwargs):
            return io.BytesIO(source.read_bytes())

    monkeypatch.setattr(module, "ComfyClient", Client)
    interruptions = [] if lost_response else [True]

    def wait(*args):
        if interruptions:
            interruptions.pop()
            raise module.GeneratorError("模拟查询中断，生成仍在运行")
        return {"outputs": {"16": {"images": [{"type": "output", "filename": "clip.mp4"}]}}}

    monkeypatch.setattr(module, "wait_for_result", wait)
    parsed, _ = batch.load_config(path)
    from asset_factory.batch_models import TaskState

    task = TaskState(key="walk-42")
    checkpoints = []

    def save():
        checkpoints.append(task.model_dump())

    with pytest.raises(module.GeneratorError):
        generation.generate(root, parsed, parsed.clips[0], 42, path.parent, task, save)
    assert task.phase == ("submitting" if lost_response else "queued")
    if not lost_response:
        assert task.prompt_id == "stable-id"
    generation.generate(root, parsed, parsed.clips[0], 42, path.parent, task, save)
    assert len(submitted) == 1 and task.phase == "generated"
    assert task.asset_log["prompt"] == "原文 测试外貌"
    assert task.asset_log["attempt"] == 1 and task.source_sha256 == sha256(source)
    assert "workflow" in task.asset_log and "modelFiles" in task.asset_log


def test_lost_submit_response_uses_client_identity():
    class Client:
        def json(self, route):
            return (
                {"queue_running": [[1, "task-1", {}, {"client_id": "mine"}]]}
                if route == "/queue"
                else {}
            )

    assert generation.recover_submission(Client(), "mine") == "task-1"
    with pytest.raises(FactoryError, match="未重复生成"):
        generation.recover_submission(Client(), "other")


def test_land_derivation_and_pickup_map(example):
    root, path, _, _ = example
    report = json.loads(batch.run_batch(root, path).read_text(encoding="utf-8"))
    job = report["candidates"][0]["job"]
    directory = root / "factory" / job
    derived = derive_land(root, job, 1, 9, 0.9)
    log = json.loads((derived.parent / "derivation.json").read_text(encoding="utf-8"))
    assert log["actual_seconds"] == pytest.approx(43 / 48)
    assert len(log["source_frame_indices"]) == 43
    assert log["source_frame_indices"][0] == 1 and log["source_frame_indices"][-1] == 8
    assert log["derived_sha256"] == sha256(derived)
    options = json.loads((directory / "auto/options.json").read_text(encoding="utf-8"))
    options["keypoints"]["scruff"] = [{"x": 20.0, "y": float(30 - index)} for index in range(10)]
    options_path = root / "scruff-options.json"
    write_json(options_path, options)
    mapping = json.loads(pickup_map(root, job, options_path).read_text(encoding="utf-8"))
    assert mapping["height_to_frame"][-1] == {"height": 9.0, "frame": 9}
    assert mapping["reverse_speed"] == 3.0
    options["keypoints"]["scruff"][4] = None
    write_json(options_path, options)
    with pytest.raises(FactoryError, match="完整"):
        pickup_map(root, job, options_path)


def test_display_ratio_and_untrusted_landmark(example):
    root, path, _, _ = example
    report = json.loads(batch.run_batch(root, path).read_text(encoding="utf-8"))
    directory = root / "factory" / report["candidates"][0]["job"]
    profile = batch.load_config(path)[0].cat
    paths = sorted((directory / "matte").glob("*.png"))
    height, union = display_height(paths, [Point(x=12.0, y=35.0)] * len(paths), profile)
    assert height == round(union * 16 / 26)
    # 背景里的点不能被当成后颈或肉垫轨迹。
    points = track_landmark(paths, Landmark(point=Point(x=50.0, y=20.0), radius=2), "测试猫")
    assert all(p is None for p in points)


@pytest.mark.parametrize(
    "args",
    [(8, 3, 2, 1, 48, "linear"), (8, 0, 9, 1, 48, "linear"), (8, 0, 8, float("nan"), 48, "linear")],
)
def test_bad_derivation_ranges(args):
    with pytest.raises(FactoryError):
        land_indices(*args)
