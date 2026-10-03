import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

from pydantic import ValidationError

from .batch import reuse_generated, run_batch
from .derivation import derive_land, pickup_map
from .export import finalize
from .matting import MODEL_FILE, MODEL_MD5, MODEL_URL
from .pipeline import confirm, ingest, matte, suggest
from .storage import FactoryError, asset_root, new_directory, operation, sha256, write_json


def color(value: str) -> tuple[int, int, int]:
    try:
        parts = tuple(int(part) for part in value.split(","))
        if len(parts) != 3 or any(not 0 <= part <= 255 for part in parts):
            raise ValueError()
        return parts
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "背景颜色应写成三个 0～255 的整数，例如 0,180,220"
        ) from error


def setup_model(root: Path):
    destination = root / "models" / "birefnet-general-lite"
    with operation(root, "setup-model", "抠图模型", {"url": MODEL_URL}):
        with new_directory(destination) as temporary:
            path = temporary / MODEL_FILE
            digest = hashlib.md5(usedforsecurity=False)
            with urllib.request.urlopen(MODEL_URL, timeout=60) as response, path.open("xb") as out:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    out.write(chunk)
            if digest.hexdigest() != MODEL_MD5:
                raise FactoryError("模型下载不完整或内容不符，未发布模型目录，请重新下载")
            manifest = {
                "file": MODEL_FILE,
                "url": MODEL_URL,
                "license": "MIT",
                "md5": MODEL_MD5,
                "sha256": sha256(path),
                "bytes": path.stat().st_size,
            }
            write_json(temporary / "model.json", manifest)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))


def parser():
    cli = argparse.ArgumentParser(description="TTCats 半手动素材工厂（所有输出在素材库）")
    commands = cli.add_subparsers(dest="command", required=True)
    commands.add_parser("setup-model", help="下载并校验固定版本 BiRefNet（约 224MB）")
    add = commands.add_parser("ingest", help="从收件箱读取原始视频并拆帧")
    add.add_argument("--cat", required=True, help="猫的名称，写入校验信息和档案")
    add.add_argument("--source", type=Path, help="省略则读取素材库 inbox 的所有视频")
    add.add_argument("--generator-log", type=Path, help="原样保留生成器的素材档案")
    cut = commands.add_parser("matte", help="GPU 抠图并清理纯色背景的毛边")
    cut.add_argument("job")
    cut.add_argument("--background", type=color, required=True, help="原视频的纯色背景 RGB")
    advice = commands.add_parser("suggest", help="生成建议值、深浅背景及镜像预览")
    advice.add_argument("job")
    approve = commands.add_parser("confirm", help="校验人工参数并记录改动量和用时")
    approve.add_argument("job")
    approve.add_argument("--parameters", type=Path, required=True)
    export = commands.add_parser("finalize", help="导出 2 倍尺寸的透明 WebM、点击遮罩和片段资料")
    export.add_argument("job")
    export.add_argument("--options", type=Path, required=True)
    batch = commands.add_parser("batch", help="串行批量生成、初筛、处理为待挑选候选；同命令续跑")
    batch.add_argument("--config", type=Path, required=True)
    batch.add_argument(
        "--retry-uncertain",
        action="append",
        default=[],
        metavar="片段-种子",
        help="仅在本人确认从未提交后重新生成；可能重复生成，请先查 ComfyUI",
    )
    batch.add_argument("--retry-failed", action="store_true", help="明确重试已记录的生成失败")
    reuse = commands.add_parser(
        "reuse-generated", help="将旧批次已下载原片转为新批次配置，无需重新生成"
    )
    reuse.add_argument("--config", type=Path, required=True, help="旧批次的原配置")
    reuse.add_argument("--id", required=True, help="未使用过的新批次 id")
    reuse.add_argument("--output", type=Path, required=True, help="尚不存在的新配置文件")
    pickup = commands.add_parser("pickup-map", help="根据完整 scruff 轨迹建议鼠标高度到帧号映射")
    pickup.add_argument("job")
    pickup.add_argument("--options", type=Path)
    land = commands.add_parser("derive-land", help="按选定时长从源帧派生落地原片（无插帧）")
    land.add_argument("job")
    land.add_argument("--start", type=int, required=True)
    land.add_argument("--end", type=int, required=True)
    land.add_argument("--seconds", type=float, required=True)
    land.add_argument("--fps", type=float, default=48.0)
    land.add_argument("--curve", choices=["linear", "ease-out"], default="linear")
    return cli


def main() -> int:
    args = parser().parse_args()
    try:
        root = asset_root()
        if args.command == "setup-model":
            setup_model(root)
        elif args.command == "ingest":
            if not args.cat.strip():
                raise FactoryError("猫的名称不能为空")
            sources = (
                [args.source]
                if args.source
                else sorted(
                    p
                    for p in (root / "inbox").glob("*")
                    if p.is_file() and p.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm"}
                )
            )
            if not sources:
                raise FactoryError(f"猫「{args.cat}」：收件箱里没有原始视频")
            if args.generator_log and len(sources) != 1:
                raise FactoryError("指定生成器档案时必须用 --source 指定单个原始视频")
            for source in sources:
                print(ingest(root, source, args.cat, args.generator_log))
        elif args.command == "matte":
            folder = root / "models" / "birefnet-general-lite"
            try:
                manifest = json.loads((folder / "model.json").read_text(encoding="utf-8"))
                model_hash = manifest["sha256"]
            except (OSError, ValueError, KeyError) as error:
                raise FactoryError(
                    "缺少模型校验记录，请先运行 asset-factory setup-model"
                ) from error
            matte(root, args.job, folder / MODEL_FILE, model_hash, args.background)
        elif args.command == "suggest":
            suggest(root, args.job)
        elif args.command == "confirm":
            confirm(root, args.job, args.parameters)
        elif args.command == "finalize":
            print(finalize(root, args.job, args.options))
        elif args.command == "batch":
            print(
                run_batch(
                    root,
                    args.config,
                    retry_uncertain=args.retry_uncertain,
                    retry_failed=args.retry_failed,
                )
            )
        elif args.command == "reuse-generated":
            print(reuse_generated(root, args.config, args.id, args.output))
        elif args.command == "pickup-map":
            print(pickup_map(root, args.job, args.options))
        elif args.command == "derive-land":
            print(
                derive_land(
                    root, args.job, args.start, args.end, args.seconds, args.fps, args.curve
                )
            )
        return 0
    except (FactoryError, OSError, ValidationError, RuntimeError) as error:
        print(f"素材处理失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
