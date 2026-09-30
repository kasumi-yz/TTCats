"""上传首尾帧、调用本机 ComfyUI，并把原始视频和素材档案保存到收件箱。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

WORKFLOW = Path(__file__).parent / "workflows" / "h3-fl2va-api.json"
MANIFEST = Path(__file__).parent / "model-manifest.json"


class GeneratorError(Exception):
    pass


class ComfyClient:
    def __init__(self, url):
        self.url = url.rstrip("/")
        # 本机接口不应被系统的网络代理转发。
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, route, body=None, content_type="application/json", timeout=30):
        request = urllib.request.Request(self.url + route, data=body)
        if body is not None:
            request.add_header("Content-Type", content_type)
        try:
            return self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise GeneratorError(f"ComfyUI 拒绝请求（{error.code}）：{detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GeneratorError(f"无法连接 ComfyUI（{self.url}）：{error}") from error

    def json(self, route, payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        with self.request(route, body) as response:
            return json.load(response)

    def upload(self, path):
        boundary = uuid.uuid4().hex
        name = uuid.uuid4().hex + path.suffix.lower()
        body = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="image"; '
            f'filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'
        ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        with self.request("/upload/image", body, f"multipart/form-data; boundary={boundary}") as response:
            uploaded = json.load(response)
        if not uploaded.get("name") or uploaded.get("type") != "input":
            raise GeneratorError(f"首尾帧上传结果异常：{uploaded}")
        return "/".join(filter(None, [uploaded.get("subfolder"), uploaded["name"]]))


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def wait_for_result(client, prompt_id, timeout, poll_interval):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        history = client.json("/history/" + urllib.parse.quote(prompt_id, safe=""))
        result = history.get(prompt_id)
        if result:
            status = result.get("status", {})
            if status.get("status_str") == "error":
                raise GeneratorError(f"H3 生成失败：{json.dumps(status.get('messages'), ensure_ascii=False)}")
            if status.get("completed"):
                return result
        time.sleep(poll_interval)
    raise GeneratorError(f"等待生成超过 {timeout:g} 秒；任务 {prompt_id} 可能仍在运行。可在 ComfyUI 查看或取消，避免直接重复提交。")


def output_videos(result):
    # SaveVideo 原生节点的历史输出使用 images；兼容 videos / gifs 分类。
    videos = []
    for node in result.get("outputs", {}).values():
        for category in ("images", "videos", "gifs"):
            for item in node.get(category, []):
                if item.get("type") == "output" and str(item.get("filename", "")).lower().endswith(".mp4"):
                    videos.append(item)
    if not videos:
        raise GeneratorError("ComfyUI 已结束任务，但没有返回 MP4 输出，请检查 SaveVideo 节点。")
    return videos


def run(args):
    first, last = args.first.resolve(), args.last.resolve()
    for label, path in (("首帧", first), ("尾帧", last)):
        if not path.is_file():
            raise GeneratorError(f"测试片段缺少{label}图片：{path}")
        if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            raise GeneratorError(f"测试片段的{label}图片格式不支持：{path.suffix}")
    if not args.prompt.strip():
        raise GeneratorError("测试片段缺少提示词。")
    asset_root = os.environ.get("TTCATS_ASSET_ROOT")
    if not asset_root:
        raise GeneratorError("缺少素材库位置，请先设置环境变量 TTCATS_ASSET_ROOT。")
    if args.width % 32 or args.height % 32 or args.width * args.height > 768 * 1344:
        raise GeneratorError("H3 宽高必须是 32 的倍数，面积不能超过 1344×768。")
    client = ComfyClient(args.url)
    workflow = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    info = client.json("/object_info")
    runtime = client.json("/system_stats").get("system", {})
    missing = sorted({node["class_type"] for node in workflow.values()} - info.keys())
    if missing:
        raise GeneratorError("ComfyUI 缺少 H3 工作流节点：" + "、".join(missing))
    for node in workflow.values():
        for field in ("unet_name", "clip_name", "vae_name"):
            if field in node["inputs"]:
                required = info[node["class_type"]].get("input", {}).get("required", {})
                available = required.get(field, [[]])[0]
                if node["inputs"][field] not in available:
                    raise GeneratorError(f"H3 测试片段缺少模型文件：{node['inputs'][field]}")
    if args.check_only:
        print("ComfyUI 连接正常，H3 工作流节点齐全；未提交生成任务。")
        return
    workflow["5"]["inputs"]["image"] = client.upload(first)
    workflow["6"]["inputs"]["image"] = client.upload(last)
    frames = round(args.seconds * 24)
    frames += (5 - frames % 17) % 17
    workflow["7"]["inputs"].update(prompt=args.prompt, width=args.width, height=args.height, length=frames)
    workflow["8"]["inputs"]["noise_seed"] = args.seed
    workflow["11"]["inputs"]["steps"] = args.steps
    run_id = "h3-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    workflow["16"]["inputs"]["filename_prefix"] = "TTCats/" + run_id
    inbox = Path(asset_root).expanduser().resolve() / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    log_path = inbox / (run_id + ".json")
    metadata = {
        "generator": "MiniMax H3 FL2VA", "status": "submitting", "run_id": run_id,
        "first_sha256": sha256(first), "last_sha256": sha256(last),
        "workflow_sha256": sha256(WORKFLOW), "workflow": workflow,
        "provenance": json.loads(MANIFEST.read_text(encoding="utf-8")),
        "runtime": {key: runtime.get(key) for key in ("comfyui_version", "python_version", "pytorch_version", "ram_total")},
        "width": args.width, "height": args.height, "fps": 24, "frames": frames,
        "requested_seconds": args.seconds, "actual_seconds": frames / 24,
    }
    save_json(log_path, metadata)
    started = time.monotonic()
    try:
        reply = client.json("/prompt", {"prompt": workflow, "client_id": run_id})
        if reply.get("node_errors") or not reply.get("prompt_id"):
            raise GeneratorError(f"H3 工作流未通过 ComfyUI 校验：{reply}")
        prompt_id = reply["prompt_id"]
        metadata.update(status="queued", prompt_id=prompt_id)
        save_json(log_path, metadata)
        print(f"已提交 H3 任务 {prompt_id}；目标 {frames} 帧（{frames / 24:.3f} 秒）。", flush=True)
        result = wait_for_result(client, prompt_id, args.timeout, args.poll_interval)
        metadata["history"] = result
        outputs = []
        for index, video in enumerate(output_videos(result)):
            destination = inbox / f"{run_id}-{index + 1}.mp4"
            temporary = destination.with_suffix(".mp4.part")
            query = urllib.parse.urlencode({key: video[key] for key in ("filename", "subfolder", "type") if key in video})
            try:
                with client.request("/view?" + query, timeout=120) as response, temporary.open("wb") as file:
                    while chunk := response.read(1024 * 1024):
                        file.write(chunk)
                if temporary.stat().st_size == 0:
                    raise GeneratorError("ComfyUI 返回了空视频文件。")
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
            outputs.append({"filename": destination.name, "sha256": sha256(destination)})
            print(f"已保存：{destination}", flush=True)
        metadata.update(status="success", outputs=outputs)
    except BaseException as error:
        metadata.update(status="failed", error=str(error))
        raise
    finally:
        metadata["elapsed_seconds"] = round(time.monotonic() - started, 3)
        save_json(log_path, metadata)


def positive(value):
    number = float(value)
    if not 0 < number < float("inf"):
        raise argparse.ArgumentTypeError("必须是有限的正数")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--first", type=Path, required=True, help="首帧图片")
    parser.add_argument("--last", type=Path, required=True, help="尾帧图片")
    parser.add_argument("--prompt", required=True, help="生成提示词")
    parser.add_argument("--url", default="http://127.0.0.1:8188", help="本机 ComfyUI 地址")
    parser.add_argument("--width", type=int, default=1344)
    parser.add_argument("--height", type=int, default=768)
    parser.add_argument("--seconds", type=positive, default=5)
    parser.add_argument("--steps", type=int, choices=range(1, 101), default=20)
    parser.add_argument("--seed", type=int, default=6)
    parser.add_argument("--timeout", type=positive, default=7200)
    parser.add_argument("--poll-interval", type=positive, default=5)
    parser.add_argument("--check-only", action="store_true", help="只检查连接与节点，不生成")
    args = parser.parse_args()
    if args.width < 32 or args.height < 32 or not 4 <= args.seconds <= 15 or not 0 <= args.seed < 2**64:
        parser.error("宽高至少 32，时长为 4～15 秒，种子为 0～2^64-1。")
    try:
        run(args)
    except (GeneratorError, ValueError, OSError) as error:
        print(f"生成器错误：{error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已停止等待；ComfyUI 中的任务可能仍在运行，请到界面检查。", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
