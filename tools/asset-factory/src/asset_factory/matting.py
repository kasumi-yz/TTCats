import os
from pathlib import Path

import numpy as np
from PIL import Image

from .storage import FactoryError, sha256

MODEL_NAME = "BiRefNet-general-lite-bb_swin_v1_tiny-epoch_232"
MODEL_FILE = "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"
MODEL_URL = f"https://github.com/danielgatis/rembg/releases/download/v0.0.0/{MODEL_FILE}"
# 发布者的 MD5 用于下载完整性核对；本地另外记录 SHA-256。
MODEL_MD5 = "4fab47adc4ff364be1713e97b7e66334"


class BiRefNet:
    def __init__(self, path: Path, expected_sha256: str):
        if not path.is_file() or sha256(path) != expected_sha256:
            raise FactoryError("BiRefNet 模型缺失或 SHA-256 不符，请重新下载并核对模型")
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise FactoryError("缺少 GPU 依赖，请运行 uv sync --extra gpu") from error
        # cuDNN 的引擎子库在 Windows 上会再动态加载，预载主 DLL 还不够。
        # 只更新本进程的搜索路径，不写系统环境，不依赖 ComfyUI 的私有 Python。
        self.dll_handles = []
        if os.name == "nt":
            packages = Path(ort.__file__).resolve().parents[1] / "nvidia"
            directories = sorted(path for path in packages.glob("*/bin") if path.is_dir())
            self.dll_handles = [os.add_dll_directory(str(path)) for path in directories]
            os.environ["PATH"] = (
                os.pathsep.join(map(str, directories)) + os.pathsep + os.environ["PATH"]
            )
        ort.preload_dlls(directory="")
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            raise FactoryError("CUDA 不可用，无法在 GPU 上抠图，请检查驱动和 GPU 依赖")
        self.session = ort.InferenceSession(str(path), providers=["CUDAExecutionProvider"])
        if "CUDAExecutionProvider" not in self.session.get_providers():
            raise FactoryError("CUDA 加载失败，已停止；不会把 CPU 回退结果当成 GPU 验证")
        self.session.disable_fallback()
        self.version = ort.__version__
        self.providers = self.session.get_providers()
        self.input_name = self.session.get_inputs()[0].name
        self.model_sha256 = expected_sha256

    def predict(self, image: Image.Image) -> Image.Image:
        rgb = image.convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS)
        data = np.asarray(rgb, dtype=np.float32) / 255
        data = (data - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array(
            [0.229, 0.224, 0.225], dtype=np.float32
        )
        tensor = np.ascontiguousarray(data.transpose(2, 0, 1)[None])
        try:
            logits = self.session.run(None, {self.input_name: tensor})[0][0, 0]
        except Exception as error:
            raise FactoryError(
                "GPU 抠图失败，请检查 CUDA/cuDNN 依赖和显存；失败详情见素材日志"
            ) from error
        probability = 1 / (1 + np.exp(-np.clip(logits, -80, 80)))
        low, high = float(probability.min()), float(probability.max())
        if high - low < 1e-6:
            raise FactoryError("模型输出没有可区分的主体，不能生成有效透明帧")
        mask = np.round((probability - low) / (high - low) * 255).astype(np.uint8)
        return Image.fromarray(mask).resize(image.size, Image.Resampling.LANCZOS)
