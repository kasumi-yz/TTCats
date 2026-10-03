"""量化建议始终保留测量局限，不把轮廓代理冒充肉垫或身份识别。"""

import math

import numpy as np
from PIL import Image

from .imaging import make_suggestion, silhouette
from .models import Point, anchor_speed
from .storage import FactoryError


def track_landmark(paths, landmark, cat):
    """局部纹理匹配；不够可信或被遮挡就返回 null，不补造轨迹。"""
    radius, search = landmark.radius, landmark.search
    initial = landmark.point
    with Image.open(paths[0]) as image:
        first = np.asarray(image.convert("RGBA"))
    height, width = first.shape[:2]
    x, y = round(initial.x), round(initial.y)
    if not radius <= x < width - radius or not radius <= y < height - radius:
        raise FactoryError(f"猫「{cat}」：关键点模板离边界太近，请调整位置或半径")
    template = first[y - radius : y + radius + 1, x - radius : x + radius + 1, :3].astype(float)
    if template.std() < 5 or first[y, x, 3] < 128:
        return [None] * len(paths)
    points = []
    for path in paths:
        with Image.open(path) as image:
            rgba = np.asarray(image.convert("RGBA"))
        best = (float("inf"), x, y)
        for py in range(max(radius, y - search), min(height - radius, y + search + 1)):
            for px in range(max(radius, x - search), min(width - radius, x + search + 1)):
                if rgba[py, px, 3] < 128:
                    continue
                patch = rgba[py - radius : py + radius + 1, px - radius : px + radius + 1, :3]
                error = float(np.mean(np.abs(patch.astype(float) - template)) / 255)
                if error < best[0]:
                    best = (error, px, py)
        error, px, py = best
        if error > landmark.max_error:
            points.append(None)
        else:
            x, y = px, py
            points.append(Point(x=float(x), y=float(y)))
    return points


def automatic_selection(paths, record, profile, clip):
    selection = make_suggestion(paths, record.fps, record.cat)
    rear_foot = clip.rear_foot or profile.rear_foot
    centers, signatures = [], []
    for path in paths:
        with Image.open(path) as image:
            # 排除很淡的残余 alpha，避免边界被背景噪声拉到整幅画布。
            alpha = np.asarray(image.getchannel("A"))
            _, xs = np.where(alpha >= 128)
            centers.append((int(xs.min()) + int(xs.max()) + 1) / 2)
            signatures.append(silhouette(image, record.cat)[1])
    centers = np.asarray(centers)
    if clip.anchor_mode == "fixed":
        selection.foot_anchors = [Point(x=rear_foot.x, y=profile.ground_y)] * len(paths)
        selection.speed = 0.0
    elif clip.anchor_mode == "translation":
        # 用主体位移拟合匀速段；仍需要人工核对后脚真实着地点。
        step = np.abs(np.diff(centers))
        moving = np.flatnonzero(step > max(0.5, float(np.median(step)) * 0.3))
        start, end = (int(moving[0]), int(moving[-1]) + 2) if len(moving) else (0, len(paths))
        if end - start >= max(3, round(record.fps * 0.5) + 1):
            stable = make_suggestion(paths[start:end], record.fps, record.cat)
            selection.trim_start, selection.trim_end = start, end
            selection.loop_start = start + stable.loop_start
            selection.loop_end = start + stable.loop_end
            selection.loop_error = stable.loop_error
        fit = np.polyfit(np.arange(start, end), centers[start:end], 1)
        # 首帧常是停止姿势，不在匀速拟合线上；以真实首帧主体中心为基准。
        # 否则把启动前的停顿外推成运动，会整体偏移后脚建议。
        displacement = np.polyval(fit, np.arange(len(paths))) - centers[0]
        displacement[:start] = centers[:start] - centers[0]
        displacement[end:] = centers[end:] - centers[0]
        selection.foot_anchors = [
            Point(x=float(np.clip(rear_foot.x + d, 0, record.width - 1)), y=profile.ground_y)
            for d in displacement
        ]
        selected = selection.foot_anchors[selection.loop_start : selection.loop_end]
        selection.speed = anchor_speed(selected, record.fps)
    landmarks = {**profile.landmarks, **clip.landmarks}
    points = {key: track_landmark(paths, value, record.cat) for key, value in landmarks.items()}
    selection.warnings = [
        "自动值仅供挑选，未人工确认；身份、四肢/尾巴结构、镜像花纹仍需审看。",
        "平移锚点来自主体轮廓拟合，不等于每只脚着地；关键点匹配不可信时记 null。",
        "固定锚点采用本猫配置测量值，无法证明原始肉垫没有移动。",
    ]
    return selection, points, np.asarray(signatures)


def assess(raw_paths, matte_paths, record, profile, clip, selection, points, signatures, poses):
    metrics, reasons, scores = {}, [], []

    def metric(name, value, threshold, text):
        value = float(value)
        metrics[name] = {"value": value, "threshold": threshold}
        score = 100 / (1 + (value / threshold) ** 2)
        scores.append(score)
        reasons.append(f"{text}：{value:.4g}（参考上限 {threshold:g}）")

    for label, index, pose in (("first", 0, clip.from_pose), ("last", -1, clip.to_pose)):
        with Image.open(raw_paths[index]) as image, Image.open(poses[label]) as reference:
            actual, expected = (
                np.asarray(image.convert("RGB")),
                np.asarray(reference.convert("RGB")),
            )
            if actual.shape != expected.shape:
                raise FactoryError(f"猫「{record.cat}」：姿势帧 {pose} 尺寸不符合本猫画布")
        with Image.open(matte_paths[index]) as image:
            mask = np.asarray(image.getchannel("A")) >= 128
        metric(
            f"{label}_pose_rgb_error",
            np.abs(actual.astype(float) - expected)[mask].mean() / 255,
            0.08,
            f"{'首' if label == 'first' else '尾'}帧与姿势帧主体颜色差（近似）",
        )
    bg, corners, residual = np.asarray(profile.background), [], []
    for raw, matte in zip(raw_paths, matte_paths, strict=True):
        with Image.open(raw) as image:
            rgb = np.asarray(image.convert("RGB")).astype(float)
        corners.append(np.abs(rgb[[0, 0, -1, -1], [0, -1, 0, -1]] - bg).max())
        with Image.open(matte) as image:
            rgba = np.asarray(image.convert("RGBA"))
        edge = (rgba[..., 3] > 16) & (rgba[..., 3] < 240)
        nearby = np.linalg.norm(rgba[..., :3].astype(float) - bg, axis=2) < 30
        residual.append(float(nearby[edge].mean()) if edge.any() else 0.0)
    metric("background_corner_error", max(corners), 8, "背景四角颜色偏差（不能识别镜头抖动）")
    metric(
        "edge_background_fraction", max(residual), 0.1, "软毛边接近背景色的比例（可能包含本色毛发）"
    )
    motion = np.mean(np.abs(np.diff(signatures, axis=0)), axis=1)
    active = np.flatnonzero(motion > 0.015)
    duration = (int(active[-1] - active[0]) + 1) / record.fps if len(active) else 0.0
    metrics["action_seconds"] = {"value": duration, "method": "归一化主体变化 > 0.015"}
    if clip.action_seconds is not None:
        metric(
            "action_duration_ratio",
            duration / clip.action_seconds,
            1.5,
            "实际动起来到停下/提示词动作时长（近似，不使用请求总时长）",
        )
    if clip.kind == "loop":
        start, end = selection.loop_start, selection.loop_end
        metric(
            "loop_seam_error",
            np.abs(signatures[start] - signatures[end - 1]).mean(),
            0.08,
            "实际导出末帧到首帧的轮廓/颜色差",
        )
    toe = points.get("rear-toe", [])
    if clip.anchor_mode == "fixed" and toe and all(p is not None for p in toe):
        metric(
            "rear_toe_x_range",
            max(p.x for p in toe) - min(p.x for p in toe),
            3,
            "模板匹配后脚趾水平变化（须人工确认匹配的是肉垫）",
        )
        metric(
            "rear_toe_ground_error",
            max(abs(p.y - profile.ground_y) for p in toe),
            3,
            "模板匹配后脚趾与地面线偏差",
        )
    else:
        reasons.append(
            "脚是否打滑：未取得完整、可信肉垫轨迹，待人工逐脚检查；锚点位移不当作脚位移。"
        )
    reasons.extend(selection.warnings)
    return {
        "score": round(float(np.mean(scores)), 2),
        "reasons": reasons,
        "metrics": metrics,
        "manual_checks": [
            "身份、项圈和毛色",
            "四条腿、一条尾巴、无穿插",
            "无手、人、文字、道具、地面线",
            "真实脚接触与打滑",
            "镜像和深浅背景",
        ],
    }


def display_height(paths, anchors, profile):
    bounds = []
    for path, anchor in zip(paths, anchors, strict=True):
        with Image.open(path) as image:
            box = image.getchannel("A").getbbox()
        if box is None:
            raise FactoryError(f"猫「{profile.name}」：{path.name} 没有可见主体")
        bounds.append((box[1] - anchor.y, box[3] - anchor.y))
    union_height = math.ceil(max(b[1] for b in bounds)) - math.floor(min(b[0] for b in bounds)) + 4
    value = round(union_height * profile.display_height / profile.stand_height)
    if not 8 <= value <= 1024:
        raise FactoryError(f"猫「{profile.name}」：裁剪后显示高度 {value} 超出 8～1024")
    return value, union_height
