from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .models import Point, Suggestion, anchor_speed
from .storage import FactoryError


def decontaminate(image: Image.Image, alpha: Image.Image, background: tuple[int, int, int]):
    """纯色背景的 RGB 近似反混合。只修软边，不改变不透明主体或 alpha。"""
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    a = np.asarray(alpha, dtype=np.float32)[..., None] / 255
    bg = np.asarray(background, dtype=np.float32) / 255
    corrected = (rgb - (1 - a) * bg) / np.maximum(a, 0.05)
    rgb = np.where((a > 0) & (a < 1), np.clip(corrected, 0, 1), rgb)
    rgb = np.where(a == 0, 0, rgb)
    rgba = np.concatenate((rgb, a), axis=2)
    return Image.fromarray(np.round(rgba * 255).astype(np.uint8))


def silhouette(image: Image.Image, cat: str) -> tuple[Point, np.ndarray]:
    """底部轮廓带的中位数；尾巴/悬空会误导，必须由人确认。"""
    rgba = image.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"))
    ys, xs = np.where(alpha >= 128)
    if len(xs) == 0:
        raise FactoryError(f"猫「{cat}」：帧里没有可见主体，不能建议落脚锚点")
    bottom = int(ys.max())
    band = max(1, round((bottom - int(ys.min()) + 1) * 0.02))
    feet = xs[ys >= bottom - band]
    anchor = Point(x=float(np.median(feet)), y=float(bottom))
    # 归一化主体轮廓和颜色以比较姿势，消除单纯平移对循环检测的干扰。
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, bottom + 1)
    normalized = ImageOps.contain(rgba.crop(bbox), (32, 32), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (32, 32))
    canvas.paste(normalized, ((32 - normalized.width) // 2, (32 - normalized.height) // 2))
    values = np.asarray(canvas, dtype=np.float32) / 255
    values[..., :3] *= values[..., 3:4]
    return anchor, values.reshape(-1)


def make_suggestion(paths: list[Path], fps: float, cat: str) -> Suggestion:
    anchors, signatures = [], []
    for path in paths:
        with Image.open(path) as image:
            anchor, signature = silhouette(image, cat)
            anchors.append(anchor)
            signatures.append(signature)
    if len(paths) < 2:
        raise FactoryError(f"猫「{cat}」：至少需要两帧才能建议循环区间")
    # 最短候选循环为半秒，短片至少间隔一帧；不能把相邻近似帧当长循环。
    gap = min(len(paths) - 1, max(1, round(fps * 0.5)))
    best = (float("inf"), 0, len(paths) - 1)
    values = np.stack(signatures)
    for start in range(len(paths) - gap):
        errors = np.mean(np.abs(values[start + gap :] - values[start]), axis=1)
        offset = int(np.argmin(errors))
        candidate = (float(errors[offset]), start, start + gap + offset)
        if candidate < best:
            best = candidate
    error, start, last = best
    return Suggestion(
        cat=cat,
        trim_start=0,
        trim_end=len(paths),
        loop_start=start,
        loop_end=last,
        loop_error=error,
        foot_anchors=anchors,
        speed=anchor_speed(anchors, fps),
        warnings=[
            "所有值都是建议，必须人工确认；没有自动选择合格候选。",
            "锚点来自主体底部轮廓，尾巴、悬空或阴影可能使它偏离真实落脚位置。",
            "裁剪建议目前保留整段；修改区间后请重新人工核对步速。",
            "步速只按首尾锚点的水平位移估计；镜头移动和迈步会影响结果。",
            "循环误差只比较首尾姿势，不能证明播放不跳帧或动作自然。",
        ],
    )


def preview(paths: list[Path], destination: Path):
    count = min(6, len(paths))
    indices = np.linspace(0, len(paths) - 1, count).astype(int)
    boxes = []
    for index in indices:
        with Image.open(paths[index]) as image:
            box = image.convert("RGBA").getchannel("A").getbbox()
            if box:
                boxes.append(box)
    if not boxes:
        raise FactoryError("预览帧里没有可见主体")
    crop = (
        min(b[0] for b in boxes) - 8,
        min(b[1] for b in boxes) - 8,
        max(b[2] for b in boxes) + 8,
        max(b[3] for b in boxes) + 8,
    )
    for name, color in (("dark", (30, 30, 35)), ("light", (235, 235, 240))):
        sheet = Image.new("RGB", (512, count * 256), color)
        for row, index in enumerate(indices):
            with Image.open(paths[index]) as image:
                thumb = ImageOps.contain(image.convert("RGBA").crop(crop), (256, 256))
                for column, frame in enumerate((thumb, ImageOps.mirror(thumb))):
                    position = (column * 256 + (256 - thumb.width) // 2, row * 256)
                    sheet.paste(frame, position, frame)
        sheet.save(destination / f"preview-{name}.png")
