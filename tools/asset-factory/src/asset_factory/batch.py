"""一条命令串行生成/处理；阶段原子发布、源身份固定、跨进程互斥。"""

import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from jsonschema import Draft202012Validator

from . import generation, pipeline
from .automation import assess, automatic_selection, display_height
from .batch_models import BatchConfig, BatchState, TaskState
from .export import finalize, read_slots, schema_errors, validate_clip
from .matting import MODEL_FILE
from .models import ClipOptions, IngestRecord, MatteRecord, Suggestion
from .storage import FactoryError, job_path, load_record, new_directory, sha256, write_json


@contextmanager
def batch_lock(folder):
    """操作系统锁随进程退出释放；锁文件一直保留，避免换 inode 后两人同时写。"""
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "batch.lock").open("a+b") as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise FactoryError("这一批片段正在由另一个工厂处理，请等它完成或退出后重试") from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def load_config(path):
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise FactoryError(f"猫「未知猫」：无法读取配置 {path.name}，需要有效 JSON") from error
    profile_data = raw.get("cat") if isinstance(raw, dict) else None
    cat = profile_data.get("name", "未知猫") if isinstance(profile_data, dict) else "未知猫"
    config = load_record(path, BatchConfig, cat)
    profile, base = config.cat, path.resolve().parent
    repo = Path(__file__).resolve().parents[4]
    slots = read_slots((repo / "app/src/shared/schemas/clip.ts").read_text(encoding="utf-8"))
    asset_schema = json.loads(
        (repo / "schemas/candidate-manifest.schema.json").read_text(encoding="utf-8")
    )["properties"]["assetLog"]
    identities = {"config": sha256(path)}
    for pose, value in profile.poses.items():
        pose_path = (base / value).resolve()
        if not pose_path.is_file():
            raise FactoryError(f"猫「{profile.name}」：缺少姿势帧 {pose}：{pose_path}")
        identities[f"pose:{pose}"] = sha256(pose_path)
    for clip in config.clips:
        if clip.name in slots:
            if (clip.kind, clip.from_pose, clip.to_pose) != slots[clip.name]:
                raise FactoryError(
                    f"猫「{profile.name}」：{clip.name} 类型或起止姿势不符合共享定义"
                )
        elif not clip.optional:
            raise FactoryError(f"猫「{profile.name}」：自定义片段 {clip.name} 必须标为可选")
        if (clip.from_pose == clip.to_pose) == (clip.kind == "transition"):
            raise FactoryError(f"猫「{profile.name}」：{clip.name} 的类型与姿势不相符")
        if clip.from_pose not in profile.poses or clip.to_pose not in profile.poses:
            raise FactoryError(f"猫「{profile.name}」：{clip.name} 缺少首尾姿势帧")
        first, last = generation.workflow_inputs(config, clip, base)
        if clip.rear_foot and (
            clip.rear_foot.x >= profile.width or clip.rear_foot.y >= profile.height
        ):
            raise FactoryError(f"猫「{profile.name}」：{clip.name} 首帧后脚测量超出画布")
        for key, point in clip.landmarks.items():
            if point.point.x >= profile.width or point.point.y >= profile.height:
                raise FactoryError(f"猫「{profile.name}」：{clip.name} 关键点 {key} 超出画布")
        identities[f"{clip.name}:first"] = sha256(first)
        identities[f"{clip.name}:last"] = sha256(last)
        if not clip.inputs and (
            profile.width % 32 or profile.height % 32 or profile.width * profile.height > 1344 * 768
        ):
            raise FactoryError(f"猫「{profile.name}」：H3 画布需是32的倍数，面积不超过1344×768")
        for source in clip.inputs:
            key = f"{clip.name}-{source.seed}"
            source_path = (base / source.path).resolve()
            errors = list(Draft202012Validator(asset_schema).iter_errors(source.asset_log))
            if errors:
                raise FactoryError(f"猫「{profile.name}」：{key} 素材档案 {schema_errors(errors)}")
            if Path(source.asset_log["rawVideo"]).resolve() != source_path:
                raise FactoryError(f"猫「{profile.name}」：{key} 档案 rawVideo 与输入不符")
            identities[key] = sha256(source_path)
            if source.generator_log:
                identities[f"{key}:log"] = sha256((base / source.generator_log).resolve())
    module = generation.generator_module()
    identities["workflow"] = sha256(module.WORKFLOW)
    identities["models"] = sha256(module.MANIFEST)
    for source in Path(__file__).parent.glob("*.py"):
        identities[f"processor:{source.name}"] = sha256(source)
    digest = hashlib.sha256(json.dumps(identities, sort_keys=True).encode()).hexdigest()
    return config, digest


def owns_finalized_file(path):
    """只保护工厂发布的候选；同目录的人工作业和锁属于挑片台。"""
    return path in (Path("manifest.json"), Path("export-log.json")) or (
        len(path.parts) == 2
        and (
            (path.parts[0] == "aligned" and path.suffix == ".png")
            or (path.parts[0] == "clips" and path.suffix in (".json", ".webm", ".bin"))
        )
    )


def verify_artifacts(task, cat, directory):
    # 兼容旧续跑记录：删除早期误收的人工作业哈希，不能修改工厂产物的预期哈希。
    finalize = directory / "finalize"
    task.artifacts = {
        name: expected
        for name, expected in task.artifacts.items()
        if not Path(name).is_relative_to(finalize)
        or owns_finalized_file(Path(name).relative_to(finalize))
    }
    for name, expected in task.artifacts.items():
        path = Path(name)
        if not path.is_file() or sha256(path) != expected:
            raise FactoryError(
                f"猫「{cat}」：续跑结果已变化或缺失：{path}。"
                "请用 reuse-generated 将原片转入新批次重新加工，避免重复生成。"
            )


def checkpoint_stage(task, directory, stage, save):
    target = directory / stage
    if any(Path(name) == target or Path(name).is_relative_to(target) for name in task.artifacts):
        return  # 已发布阶段只校验旧快照，不能吸收后续写入或覆盖预期哈希。
    paths = [target] if target.is_file() else [p for p in target.rglob("*") if p.is_file()]
    if stage == "finalize":
        paths = [p for p in paths if owns_finalized_file(p.relative_to(target))]
    for path in paths:
        task.artifacts[str(path)] = sha256(path)
    save()


def process(root, config, clip, task, base, save):
    profile = config.cat
    source = Path(task.source)
    if sha256(source) != task.source_sha256:
        raise FactoryError(f"猫「{profile.name}」：原始片段已变化，不能继续旧任务")
    if not task.job:
        task.job = f"clip-{uuid4().hex[:16]}"
        save()
    directory = job_path(root, task.job)
    if not (directory / "ingest.json").exists():
        pipeline.ingest(
            root,
            source,
            profile.name,
            Path(task.generator_log) if task.generator_log else None,
            job_id=task.job,
        )
    record = load_record(directory / "ingest.json", IngestRecord, profile.name)
    if (
        record.source_sha256 != task.source_sha256
        or record.cat != profile.name
        or (record.width, record.height) != (profile.width, profile.height)
    ):
        raise FactoryError(f"猫「{profile.name}」：拆帧记录的源身份或画布不符")
    raw_paths = pipeline.frame_paths(directory, record, "frames")
    checkpoint_stage(task, directory, "ingest.json", save)
    checkpoint_stage(task, directory, "frames", save)
    folder = root / "models" / "birefnet-general-lite"
    if not (directory / "matte").exists():
        manifest = json.loads((folder / "model.json").read_text(encoding="utf-8"))
        pipeline.matte(root, task.job, folder / MODEL_FILE, manifest["sha256"], profile.background)
    matte_record = load_record(directory / "matte/matte.json", MatteRecord, profile.name)
    if matte_record.background != profile.background:
        raise FactoryError(f"猫「{profile.name}」：已完成抠图的背景色与配置不符")
    paths = pipeline.frame_paths(directory, record, "matte")
    checkpoint_stage(task, directory, "matte", save)
    if not (directory / "auto").exists():
        selection, points, signatures = automatic_selection(paths, record, profile, clip)
        first, last = generation.workflow_inputs(config, clip, base)
        poses = {"first": first, "last": last}
        assessment = assess(
            raw_paths, paths, record, profile, clip, selection, points, signatures, poses
        )
        start, end = (
            (selection.loop_start, selection.loop_end)
            if clip.kind == "loop"
            else (selection.trim_start, selection.trim_end)
        )
        height, union_height = display_height(
            paths[start:end], selection.foot_anchors[start:end], profile
        )
        options = ClipOptions(
            cat_id=profile.id,
            asset_log=task.asset_log,
            name=clip.name,
            variant=1,
            kind=clip.kind,
            from_pose=clip.from_pose,
            to_pose=clip.to_pose,
            optional=clip.optional,
            mirrorable=clip.mirrorable,
            facing=clip.facing,
            display_height=height,
            hit_mask_scale=config.hit_mask_scale,
            keypoints={key: track for key, track in points.items() if key != "rear-toe"},
        )
        with new_directory(directory / "auto") as temporary:
            write_json(temporary / "selection.json", selection.model_dump(mode="json"))
            write_json(temporary / "assessment.json", assessment)
            write_json(temporary / "options.json", options.model_dump(mode="json"))
            write_json(
                temporary / "measurements.json",
                {
                    "union_crop_height": union_height,
                    "display_height": height,
                    "stand_height": profile.stand_height,
                    "stand_display_height": profile.display_height,
                    "raw_source_sha256": record.source_sha256,
                },
            )
    checkpoint_stage(task, directory, "auto", save)
    if not (directory / "suggest").exists():
        selection = load_record(directory / "auto/selection.json", Suggestion, profile.name)
        pipeline.suggest(root, task.job, selection)
    checkpoint_stage(task, directory, "suggest", save)
    assessment = json.loads((directory / "auto/assessment.json").read_text(encoding="utf-8"))
    if not (directory / "finalize").exists():
        finalize(
            root,
            task.job,
            directory / "auto/options.json",
            pending=True,
            selection_path=directory / "auto/selection.json",
            assessment=assessment,
        )
    candidate = json.loads((directory / "finalize/manifest.json").read_text(encoding="utf-8"))
    validate_clip(candidate["clip"], profile.name)
    if candidate["status"] != "pending" or candidate["assetLog"] != task.asset_log:
        raise FactoryError(f"猫「{profile.name}」：自动候选的状态或素材档案不符")
    checkpoint_stage(task, directory, "finalize", save)
    task.phase, task.error = "complete", None
    save()
    return {
        "task": task.key,
        "job": task.job,
        "manifest": str(directory / "finalize/manifest.json"),
        "score": assessment["score"],
        "reasons": assessment["reasons"],
    }


def run_batch(root: Path, path: Path, *, retry_uncertain=None, retry_failed=False):
    path = path.resolve()
    config, digest = load_config(path)
    folder = root / "batches" / config.id
    with batch_lock(folder):
        state_path = folder / "state.json"
        if state_path.exists():
            state = load_record(state_path, BatchState, config.cat.name)
            if state.config_sha256 != digest:
                raise FactoryError(
                    f"猫「{config.cat.name}」：配置或输入已变化（包括处理程序版本）。"
                    "请用 reuse-generated 将已生成原片转入新批次，避免重复生成。"
                )
        else:
            tasks = {}
            for clip in config.clips:
                for seed in [source.seed for source in clip.inputs] if clip.inputs else clip.seeds:
                    key = f"{clip.name}-{seed}"
                    tasks[key] = TaskState(key=key)
            state = BatchState(config_sha256=digest, tasks=tasks)

        def save():
            write_json(state_path, state.model_dump(mode="json"))

        save()
        for key in retry_uncertain or []:
            if key not in state.tasks or state.tasks[key].phase != "submitting":
                raise FactoryError(f"不能重提 {key}：它不是提交状态不确定的任务")
            old = state.tasks[key]
            log_path = Path(old.generator_log)
            log = json.loads(log_path.read_text(encoding="utf-8"))
            log.update(status="abandoned-uncertain", note="操作者明确确认重新提交，原记录保留")
            write_json(log_path, log)
            state.tasks[key] = TaskState(key=key)
            save()
        results, failures = [], []
        for clip in config.clips:
            seeds = [source.seed for source in clip.inputs] if clip.inputs else clip.seeds
            inputs = {source.seed: source for source in clip.inputs}
            for seed in seeds:
                key, task = f"{clip.name}-{seed}", state.tasks[f"{clip.name}-{seed}"]
                print(f"猫「{config.cat.name}」：{key}（{task.phase}）", flush=True)
                try:
                    directory = job_path(root, task.job) if task.job else root / "factory"
                    verify_artifacts(task, config.cat.name, directory)
                    if task.phase == "failed":
                        if not retry_failed:
                            raise FactoryError("已记录生成失败，显式加 --retry-failed 才重新生成")
                        state.tasks[key] = task = TaskState(key=key)
                        save()
                    if seed in inputs and task.phase == "ready":
                        source = inputs[seed]
                        task.source = str((path.parent / source.path).resolve())
                        task.source_sha256 = sha256(Path(task.source))
                        task.generator_log = (
                            str((path.parent / source.generator_log).resolve())
                            if source.generator_log
                            else None
                        )
                        task.asset_log, task.phase = source.asset_log, "generated"
                        save()
                    elif task.phase in ("ready", "submitting", "queued"):
                        generation.generate(root, config, clip, seed, path.parent, task, save)
                    results.append(process(root, config, clip, task, path.parent, save))
                except Exception as error:
                    prefix = f"猫「{config.cat.name}」："
                    task.error = f"{prefix}{key}：{str(error).removeprefix(prefix)}"
                    save()
                    failures.append({"task": key, "error": task.error})
                    print(task.error, flush=True)
                    # 在途/不确定生成仍可能占用 GPU，不能继续排下一项或偷偷重提。
                    if task.phase in ("submitting", "queued"):
                        break
            if failures and state.tasks[failures[-1]["task"]].phase in ("submitting", "queued"):
                break
        report = {
            "record_version": 1,
            "cat": config.cat.id,
            "candidates": results,
            "failures": failures,
            "complete": all(task.phase == "complete" for task in state.tasks.values()),
        }
        write_json(folder / "report.json", report)
        if failures:
            raise FactoryError(
                f"猫「{config.cat.name}」：有任务尚未完成，详情见 {folder / 'report.json'}"
            )
        return folder / "report.json"


def reuse_generated(root: Path, path: Path, new_id: str, output: Path):
    """程序升级或加工损坏后，将已下载且哈希未变的原片导出为新批次 inputs。"""
    path, output = path.resolve(), output.resolve()
    config, _ = load_config(path)
    if new_id == config.id or output == path or output.exists():
        raise FactoryError(f"猫「{config.cat.name}」：需要新的批次 id 和尚不存在的配置文件")
    if (root / "batches" / new_id).exists():
        raise FactoryError(f"猫「{config.cat.name}」：新批次 id 已被使用，请换一个")
    value = config.model_dump(mode="json")
    value["id"] = new_id
    value["cat"]["poses"] = {
        pose: str((path.parent / name).resolve()) for pose, name in config.cat.poses.items()
    }
    clips, skipped = [], []
    with batch_lock(root / "batches" / config.id):
        state = load_record(
            root / "batches" / config.id / "state.json", BatchState, config.cat.name
        )
        for clip in config.clips:
            copied = clip.model_dump(mode="json")
            copied["inputs"] = []
            for field in ("first_frame", "last_frame"):
                if copied[field]:
                    copied[field] = str((path.parent / copied[field]).resolve())
            for seed in [source.seed for source in clip.inputs] if clip.inputs else clip.seeds:
                key = f"{clip.name}-{seed}"
                task = state.tasks.get(key)
                if not task or task.phase not in ("generated", "complete"):
                    skipped.append(key)
                    continue
                if (
                    not task.source
                    or not task.source_sha256
                    or not Path(task.source).is_file()
                    or sha256(Path(task.source)) != task.source_sha256
                ):
                    raise FactoryError(
                        f"猫「{config.cat.name}」：{key} 原片缺失或哈希变化，不能复用"
                    )
                copied["inputs"].append(
                    {
                        "seed": seed,
                        "path": task.source,
                        "asset_log": task.asset_log,
                        "generator_log": task.generator_log,
                    }
                )
            if copied["inputs"]:
                clips.append(copied)
        if not clips:
            raise FactoryError(f"猫「{config.cat.name}」：尚无已下载的原片可复用，请先恢复在途任务")
        value["clips"] = clips
        # 在发布前用新配置的实际路径校验全部输入、AssetLog 和共享片段约束。
        output.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix=".reuse-", dir=output.parent) as temporary:
            check_path = Path(temporary) / output.name
            write_json(check_path, value)
            load_config(check_path)
            if output.exists():
                raise FactoryError(f"猫「{config.cat.name}」：新配置文件已存在，未覆盖")
            check_path.replace(output)
    if skipped:
        print(
            f"猫「{config.cat.name}」：仅复用已下载原片，跳过未完成项：{', '.join(skipped)}",
            flush=True,
        )
    return output
