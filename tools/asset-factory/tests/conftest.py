"""CI 没有系统 ffmpeg 时使用固定开发依赖的二进制，不跳过集成测试。"""

import os
import shutil

import pytest


@pytest.fixture(scope="session", autouse=True)
def ffmpeg_for_tests():
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        yield
        return
    try:
        import ffmpeg as binaries
    except ImportError:
        pytest.fail("测试缺少 ffmpeg/ffprobe，请安装本机工具；Linux x86_64 请先 uv sync")
    # 只用已随 uv.lock 校验的 wheel 安装的文件；不得调用 init 去下载未知版本。
    if not binaries.FFMPEG_FOLDER or not binaries.FFMPEG_PATH or not binaries.FFPROBE_PATH:
        pytest.fail("固定版本开发依赖没有提供完整二进制，不能跳过视频集成测试")
    if not binaries.FFMPEG_PATH.is_file() or not binaries.FFPROBE_PATH.is_file():
        pytest.fail("开发依赖的 ffmpeg/ffprobe 文件缺失，请重新 uv sync")
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("PATH", str(binaries.FFMPEG_FOLDER) + os.pathsep + os.environ.get("PATH", ""))
        assert shutil.which("ffmpeg") and shutil.which("ffprobe")
        yield
