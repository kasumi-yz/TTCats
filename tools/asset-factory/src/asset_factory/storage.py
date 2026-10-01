import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError


class FactoryError(Exception):
    """面向使用者的中文处理错误。"""


def asset_root() -> Path:
    value = os.environ.get("TTCATS_ASSET_ROOT")
    if not value:
        raise FactoryError("未设置 TTCATS_ASSET_ROOT，请指定仓库外的素材库目录")
    root = Path(value).resolve()
    repo = Path(__file__).resolve().parents[4]
    if root.is_relative_to(repo) or any(
        (parent / ".git").exists() for parent in [root, *root.parents]
    ):
        raise FactoryError("素材库必须放在仓库外，不能将原始素材写进仓库")
    root.mkdir(parents=True, exist_ok=True)
    return root


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value):
    """同目录替换；失败时不删除上一份记录。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def load_record(path: Path, schema, cat="未知猫"):
    try:
        content = path.read_text(encoding="utf-8")
        raw = json.loads(content)
        if cat == "未知猫" and isinstance(raw, dict) and isinstance(raw.get("cat"), str):
            cat = raw["cat"]
        return schema.model_validate_json(content)
    except ValidationError as error:
        details = "; ".join(
            f"字段 {'.'.join(map(str, item['loc'])) or '记录'} 缺失或不符合要求"
            for item in error.errors()
        )
        raise FactoryError(f"猫「{cat}」：{path.name} 校验失败：{details}") from error
    except (OSError, ValueError) as error:
        raise FactoryError(f"猫「{cat}」：无法读取 {path.name}，需要有效的 JSON 文件") from error


def run_tool(args: list[str]) -> str:
    try:
        result = subprocess.run(args, capture_output=True, text=True, check=True, timeout=1800)
        return result.stdout
    except FileNotFoundError as error:
        raise FactoryError(f"缺少工具 {args[0]}，请先安装并加入 PATH") from error
    except subprocess.CalledProcessError as error:
        raise FactoryError(f"{args[0]} 处理失败：{error.stderr[-2000:]}") from error
    except subprocess.TimeoutExpired as error:
        raise FactoryError(f"{args[0]} 超过 30 分钟未完成，已停止本次处理") from error


@contextmanager
def new_directory(destination: Path):
    """不覆盖旧结果，全部步骤成功后才发布新目录。"""
    if destination.exists():
        raise FactoryError(f"结果目录已存在：{destination}，请使用新的任务或阶段")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".processing-", dir=destination.parent))
    try:
        yield temporary
        temporary.rename(destination)
    finally:
        if temporary.exists():
            if not temporary.resolve().is_relative_to(destination.parent.resolve()):
                raise FactoryError("临时目录指向素材库之外，已停止清理，请检查目录链接")
            shutil.rmtree(temporary)


@contextmanager
def operation(root: Path, stage: str, cat: str, details: dict):
    record = {
        "record_version": 1,
        "stage": stage,
        "cat": cat,
        "started_at": datetime.now(UTC).isoformat(),
        "details": details,
    }
    started = time.perf_counter()
    try:
        yield record
        record["status"] = "success"
    except Exception as error:
        record["status"] = "failed"
        record["error"] = str(error)
        if error.__cause__:
            record["cause"] = str(error.__cause__)
        if isinstance(error, FactoryError):
            if f"猫「{cat}」" in str(error):
                raise
            raise FactoryError(f"猫「{cat}」：{error}") from error
        raise FactoryError(
            f"猫「{cat}」：{stage} 处理失败，请检查输入和依赖，详细原因见素材日志"
        ) from error
    finally:
        record["elapsed_seconds"] = time.perf_counter() - started
        write_json(root / "factory-logs" / f"{stage}-{uuid4().hex}.json", record)


def job_path(root: Path, job: str) -> Path:
    if not job or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for char in job):
        raise FactoryError("任务编号只能使用小写英文、数字、短横线和下划线")
    return root / "factory" / job
