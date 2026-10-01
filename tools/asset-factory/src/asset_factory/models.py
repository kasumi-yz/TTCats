"""本工具的中间记录格式，不是猫咪包或共享片段格式。"""

import math
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Positive = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Coordinate = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Point(Record):
    x: Coordinate
    y: Coordinate


class IngestRecord(Record):
    record_version: Literal[1] = 1
    cat: Annotated[str, Field(min_length=1)]
    source: str
    source_sha256: str
    generator_log: str | None
    fps: Positive
    frame_count: Annotated[int, Field(gt=0)]
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    sampling: Literal["constant-frame-rate"] = "constant-frame-rate"


class MatteRecord(Record):
    record_version: Literal[1] = 1
    model: str
    model_sha256: str
    runtime: str
    providers: list[str]
    background: tuple[int, int, int]

    @model_validator(mode="after")
    def valid_background(self):
        if any(not 0 <= value <= 255 for value in self.background):
            raise ValueError("背景颜色必须是 0～255 的三个整数")
        return self


class Suggestion(Record):
    record_version: Literal[1] = 1
    cat: str
    trim_start: Annotated[int, Field(ge=0)]
    trim_end: Annotated[int, Field(gt=0)]
    loop_start: Annotated[int, Field(ge=0)]
    loop_end: Annotated[int, Field(gt=0)]
    loop_error: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    foot_anchors: list[Point]
    speed: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    warnings: list[str]

    @model_validator(mode="after")
    def valid_ranges(self):
        if not 0 <= self.trim_start < self.trim_end <= len(self.foot_anchors):
            raise ValueError("裁剪区间越界或没有帧，结束帧不包含在区间内")
        if not self.trim_start <= self.loop_start < self.loop_end <= self.trim_end:
            raise ValueError("循环区间必须位于裁剪区间内")
        return self


class Confirmation(Record):
    selection: Suggestion
    manual_seconds: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    accepted: bool
    notes: str


class ClipOptions(Record):
    cat_id: Annotated[str, Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")]
    asset_log: dict[str, Any]
    name: Annotated[str, Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")]
    variant: Annotated[int, Field(ge=1)]
    kind: Literal["loop", "transition", "action"]
    from_pose: Literal["stand", "sit", "sleep", "dangle", "crouch", "airborne"]
    to_pose: Literal["stand", "sit", "sleep", "dangle", "crouch", "airborne"]
    optional: bool
    mirrorable: bool
    facing: Literal["left", "right"]
    display_height: Annotated[int, Field(ge=8, le=1024)]
    hit_mask_scale: Annotated[int, Field(ge=1, le=16)]
    keypoints: dict[str, list[Point | None]] = Field(default_factory=dict)
    sound_start_frame: Annotated[int, Field(ge=0)] | None = None


def anchor_speed(anchors: list[Point], fps: float) -> float:
    """原始画面中锚点平均水平位移；不是步态识别，不冒充真实行走速度。"""
    if len(anchors) < 2:
        return 0.0
    value = abs(anchors[-1].x - anchors[0].x) * fps / (len(anchors) - 1)
    if not math.isfinite(value):
        raise ValueError("锚点位移不是有限数值")
    return value
