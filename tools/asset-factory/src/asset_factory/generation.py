"""复用已验证的 H3 客户端/工作流，增加持久任务号与恢复。"""

import hashlib
import importlib.util
import json
import time
import urllib.parse
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

from .storage import FactoryError, sha256, write_json


@lru_cache
def generator_module():
    path = Path(__file__).resolve().parents[4] / "experiments/generators/queue_clip.py"
    spec = importlib.util.spec_from_file_location("ttcats_h3_client", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def workflow_inputs(config, clip, base):
    profile = config.cat
    try:
        first = (base / (clip.first_frame or profile.poses[clip.from_pose])).resolve()
        last = (base / (clip.last_frame or profile.poses[clip.to_pose])).resolve()
    except KeyError as error:
        raise FactoryError(f"猫「{profile.name}」：缺少姿势帧 {error.args[0]}") from error
    if not first.is_file() or not last.is_file():
        raise FactoryError(f"猫「{profile.name}」：首尾姿势帧缺失")
    return first, last


def recover_submission(client, run_id):
    """提交时断电可能丢失响应；只按持久 client_id 查找，绝不猜测重提。"""
    queue = client.json("/queue")
    history = client.json("/history")
    matches = set()
    for entry in [*queue.get("queue_running", []), *queue.get("queue_pending", [])]:
        if entry[3].get("client_id") == run_id:
            matches.add(entry[1])
    for prompt_id, entry in history.items():
        if entry.get("prompt", [None, None, None, {}])[3].get("client_id") == run_id:
            matches.add(prompt_id)
    if len(matches) != 1:
        raise FactoryError(
            "提交状态尚不确定，未重复生成。请在 ComfyUI 查找 client_id="
            f"{run_id}。请保持生成服务可访问，再重跑原命令自动查询。"
            f"若服务重启导致历史丢失，先查 ComfyUI 输出目录 TTCats/{run_id}*。"
            "有视频结果时保留原片和生成档案，作为新批次 inputs 加工；"
            "无法确认时停止，不重提。确认从未提交才使用 --retry-uncertain <片段-种子>。"
        )
    return matches.pop()


def generate(root, config, clip, seed, base, task, save):
    module = generator_module()
    client = module.ComfyClient(config.comfy_url)
    first, last = workflow_inputs(config, clip, base)
    if task.phase == "ready":
        workflow = json.loads(module.WORKFLOW.read_text(encoding="utf-8"))
        info = client.json("/object_info")
        if missing := {node["class_type"] for node in workflow.values()} - info.keys():
            raise FactoryError(f"猫「{config.cat.name}」：ComfyUI 缺少节点 {sorted(missing)}")
        for node in workflow.values():
            for field in ("unet_name", "clip_name", "vae_name"):
                if field in node["inputs"]:
                    available = info[node["class_type"]]["input"]["required"][field][0]
                    if node["inputs"][field] not in available:
                        raise FactoryError(
                            f"猫「{config.cat.name}」：缺少模型 {node['inputs'][field]}"
                        )
        runtime = client.json("/system_stats").get("system", {})
        workflow["5"]["inputs"]["image"] = client.upload(first)
        workflow["6"]["inputs"]["image"] = client.upload(last)
        frames = round(clip.seconds * 24)
        frames += (5 - frames % 17) % 17
        prompt = clip.prompt.replace("{appearance}", config.cat.appearance)
        workflow["7"]["inputs"].update(
            prompt=prompt, width=config.cat.width, height=config.cat.height, length=frames
        )
        workflow["8"]["inputs"]["noise_seed"] = seed
        workflow["11"]["inputs"]["steps"] = clip.steps
        run_id = f"h3-batch-{uuid4().hex}"
        workflow["16"]["inputs"]["filename_prefix"] = f"TTCats/{run_id}"
        provenance = json.loads(module.MANIFEST.read_text(encoding="utf-8"))
        log = {
            "asset_log_version": 1,
            "generator": "MiniMax H3 FL2VA",
            "run_id": run_id,
            "status": "submitting",
            "prompt": prompt,
            "prompt_template": clip.prompt,
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "first_sha256": sha256(first),
            "last_sha256": sha256(last),
            "workflow_sha256": sha256(module.WORKFLOW),
            "workflow": workflow,
            "provenance": provenance,
            "runtime": runtime,
            "model_hash_verification": {
                "verified_for_this_run": False,
                "note": "模型哈希来自安装清单，本次检查节点和文件名。",
            },
            "created_at": datetime.now(UTC).isoformat(),
            "parameters": {
                "seed": seed,
                "steps": clip.steps,
                "width": config.cat.width,
                "height": config.cat.height,
                "fps": 24,
                "frames": frames,
                "requested_seconds": clip.seconds,
                "actual_seconds": frames / 24,
            },
        }
        task.generator_log = str(module.reserve_asset_log(root, log))
        task.phase = "submitting"
        save()
        # 不重试 POST。即使响应丢失，下次只查询这个 run_id。
        try:
            reply = client.json("/prompt", {"prompt": workflow, "client_id": run_id})
        except module.RetryableQueryError:
            raise  # 网络/响应中断不能证明未提交，保留 submitting。
        except module.GeneratorError as error:
            log.update(status="failed", error=str(error))
            write_json(Path(task.generator_log), log)
            task.phase = "failed"
            save()
            raise FactoryError(f"猫「{config.cat.name}」：H3 明确拒绝提交：{error}") from error
        if reply.get("node_errors") or not reply.get("prompt_id"):
            log.update(status="failed", error=str(reply))
            write_json(Path(task.generator_log), log)
            task.phase = "failed"
            save()
            raise FactoryError(f"猫「{config.cat.name}」：H3 工作流未通过校验：{reply}")
        task.prompt_id = reply["prompt_id"]
        task.phase = "queued"
        save()
    log = json.loads(Path(task.generator_log).read_text(encoding="utf-8"))
    if task.phase == "submitting":
        task.prompt_id = recover_submission(client, log["run_id"])
        task.phase = "queued"
        save()
    log.update(prompt_id=task.prompt_id, status="queued")
    write_json(Path(task.generator_log), log)
    started = time.monotonic()
    try:
        result = module.wait_for_result(client, task.prompt_id, config.timeout, config.poll_seconds)
        videos = module.output_videos(result)
        if len(videos) != 1:
            raise FactoryError("H3 工作流应只输出一个原始片段，实际数量不符")
        destination = root / "inbox" / f"{log['run_id']}.mp4"
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".mp4.part")
        query = urllib.parse.urlencode(videos[0])
        try:
            with (
                client.request("/view?" + query, timeout=120) as response,
                temporary.open("wb") as out,
            ):
                while chunk := response.read(1024 * 1024):
                    out.write(chunk)
            if not temporary.stat().st_size:
                raise FactoryError("H3 返回了空视频文件")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        log.update(
            status="success",
            history=result,
            elapsed_seconds=time.monotonic() - started,
            outputs=[{"filename": destination.name, "sha256": sha256(destination)}],
        )
        task.source = str(destination)
        task.source_sha256 = sha256(destination)
        task.asset_log = {
            "generator": "MiniMax H3 FL2VA / ComfyUI "
            + str(log["runtime"].get("comfyui_version", "未知")),
            "modelFiles": [
                f"{m['path']}@{provenance_revision(log)}" for m in log["provenance"]["models"]
            ],
            "workflow": f"h3-fl2va-api.json@{log['workflow_sha256']}",
            "prompt": log["prompt"],
            "params": log["parameters"],
            "attempt": log["generation_attempt"],
            "startPoseFrame": str(first),
            "endPoseFrame": str(last),
            "rawVideo": str(destination),
            "createdAt": log["created_at"],
        }
        write_json(Path(task.generator_log), log)
        task.phase = "generated"
        save()
    except BaseException as error:
        log.update(status="pending-query", error=str(error))
        try:
            history = client.json("/history/" + urllib.parse.quote(task.prompt_id, safe=""))
            if history.get(task.prompt_id, {}).get("status", {}).get("status_str") == "error":
                log["status"] = task.phase = "failed"
                save()
        except Exception:
            pass  # 查询失败不能证明生成失败；保留 queued 状态，不重提。
        # 真正的生成错误与查询中断区分；下一次仍查任务，不重提。
        write_json(Path(task.generator_log), log)
        raise


def provenance_revision(log):
    return log["provenance"]["model_revision"]
