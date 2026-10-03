"""素材工厂私有配置与续跑记录；不另定义挑片台的共享协议。"""

from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from .models import Coordinate, Point, Positive, Record

Id = Annotated[str, Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")]
Pose = Literal["stand", "sit", "sleep", "dangle", "crouch", "airborne"]


class Landmark(Record):
    point: Point
    radius: Annotated[int, Field(ge=2, le=64)] = 8
    search: Annotated[int, Field(ge=1, le=64)] = 12
    max_error: Positive = 0.15


class CatProfile(Record):
    id: Id
    name: Annotated[str, Field(min_length=1)]
    appearance: Annotated[str, Field(min_length=1)]
    background: tuple[int, int, int]
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    stand_height: Positive
    display_height: Annotated[int, Field(ge=8, le=1024)]
    rear_foot: Point
    ground_y: Coordinate
    poses: dict[Pose, str]
    landmarks: dict[str, Landmark] = Field(default_factory=dict)

    @model_validator(mode="after")
    def measurements(self):
        if any(not 0 <= v <= 255 for v in self.background):
            raise ValueError("背景需要三个 0～255 的整数")
        if self.rear_foot.x >= self.width or self.rear_foot.y >= self.height:
            raise ValueError("后脚测量超出画布")
        if self.ground_y >= self.height:
            raise ValueError("地面线超出画布")
        for key, landmark in self.landmarks.items():
            if landmark.point.x >= self.width or landmark.point.y >= self.height:
                raise ValueError(f"关键点 {key} 超出画布")
        return self


class RawInput(Record):
    seed: Annotated[int, Field(ge=0)]
    path: str
    asset_log: dict[str, Any]
    generator_log: str | None = None


class ClipSpec(Record):
    name: Id
    kind: Literal["loop", "transition", "action"]
    from_pose: Pose
    to_pose: Pose
    first_frame: str | None = None
    last_frame: str | None = None
    rear_foot: Point | None = None
    prompt: str = ""
    seconds: Positive = 4.0
    action_seconds: Positive | None = None
    steps: Annotated[int, Field(ge=1, le=100)] = 20
    seeds: list[Annotated[int, Field(ge=0)]] = Field(default_factory=lambda: [42, 2026, 1234, 5678])
    inputs: list[RawInput] = Field(default_factory=list)
    anchor_mode: Literal["fixed", "translation", "silhouette"] = "fixed"
    landmarks: dict[str, Landmark] = Field(default_factory=dict)
    optional: bool = False
    mirrorable: bool = True
    facing: Literal["left", "right"] = "right"

    @model_validator(mode="after")
    def valid_spec(self):
        seeds = [item.seed for item in self.inputs] if self.inputs else self.seeds
        if not seeds or len(set(seeds)) != len(seeds):
            raise ValueError("种子不能为空或重复")
        if not self.inputs and not self.prompt.strip():
            raise ValueError("生成片段缺少提示词")
        return self


class BatchConfig(Record):
    record_version: Literal[1] = 1
    id: Id
    cat: CatProfile
    clips: Annotated[list[ClipSpec], Field(min_length=1)]
    comfy_url: str = "http://127.0.0.1:8188"
    timeout: Positive = 7200.0
    poll_seconds: Positive = 5.0
    hit_mask_scale: Annotated[int, Field(ge=1, le=16)] = 4

    @model_validator(mode="after")
    def unique_clips(self):
        if len({clip.name for clip in self.clips}) != len(self.clips):
            raise ValueError("片段名不能重复")
        return self


class TaskState(Record):
    key: str
    phase: Literal["ready", "submitting", "queued", "generated", "failed", "complete"] = "ready"
    prompt_id: str | None = None
    source: str | None = None
    source_sha256: str | None = None
    generator_log: str | None = None
    asset_log: dict[str, Any] = Field(default_factory=dict)
    job: str | None = None
    error: str | None = None
    artifacts: dict[str, str] = Field(default_factory=dict)


class BatchState(Record):
    record_version: Literal[1] = 1
    config_sha256: str
    tasks: dict[str, TaskState]
