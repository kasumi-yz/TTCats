// 界面文字和报错文字都集中放在这里（AGENTS.md 语言约定）。
// 代码里不要散落中文字符串，需要新文字就加到这个文件。
import type { Pose } from './schemas/pose';

export const zh = {
  app: {
    name: 'TTCats',
    panelsTitle: 'TTCats',
    panelsPlaceholder: '项目骨架已就绪。设置和调试台在 M1 里做。',
  },

  poses: {
    stand: '站',
    sit: '坐',
    sleep: '睡',
    dangle: '悬空',
    crouch: '伏低',
    airborne: '腾空',
  } satisfies Record<Pose, string>,

  /** 内容文件字段的中文名，报错时显示在字段路径后面。 */
  fields: {
    schemaVersion: '格式版本',
    id: 'id',
    name: '名字',
    birthday: '生日',
    homeDate: '到家日',
    relativeSize: '相对体型',
    personality: '性格参数',
    activity: '活跃',
    clinginess: '黏人',
    initiative: '主动',
    dominance: '强势',
    patience: '耐心',
    relationships: '关系',
    cat: '猫',
    closeness: '亲近程度',
    sounds: '声音位',
    meow: '喵叫',
    purr: '呼噜',
    variant: '版本号',
    kind: '片段类型',
    fromPose: '开始姿势',
    toPose: '结束姿势',
    optional: '是否可选',
    video: '视频文件',
    hitMask: '点击遮罩',
    fps: '帧率',
    frameCount: '帧数',
    width: '宽度',
    height: '高度',
    footAnchors: '落脚锚点',
    mirrorable: '能否镜像',
    facing: '朝向',
    speed: '移动速度',
    keypoints: '关键点',
    soundStartFrame: '声音起始帧',
    trigger: '触发条件',
    cooldownMinutes: '冷却时间',
    cats: '参与的猫',
    min: '最少几只',
    max: '最多几只',
    steps: '步骤',
    candidateId: '候选 id',
    status: '挑选状态',
    assetLog: '素材档案',
    clip: '片段元数据',
  } as Readonly<Record<string, string>>,

  validation: {
    wholeFile: '（整个文件）',
    catPack: (catId: string) => `猫咪包「${catId}」`,
    eventFile: (file: string) => `事件配置「${file}」`,
    missingField: (field: string) => `缺少必填字段 ${field}`,
    badField: (field: string, detail: string) => `字段 ${field} 不对：${detail}`,
    unknownFields: (keys: readonly string[]) =>
      `有不认识的字段：${keys.join('、')}（是不是拼错了？）`,
    fileNotJson: (detail: string) => `不是合法的 JSON：${detail}`,
    fileMissing: (file: string) => `缺少文件 ${file}`,
    referencedFileMissing: (field: string, file: string) =>
      `字段 ${field} 指向的文件不存在：${file}`,
    idMismatch: (id: string, expected: string) =>
      `id 写的是「${id}」，但它所在的文件夹或文件名是「${expected}」，两者必须一样`,
    idFormat: '只能用小写英文、数字和连字符',
    dateFormat: '日期格式应为 YYYY-MM-DD',
    timeOfDayFormat: '时刻格式应为 HH:MM（24 小时制）',
    monthDayFormat: '日期格式应为 MM-DD',
    packPathFormat: '应是猫咪包内部的相对路径，用正斜杠，不能包含 ..',
    relationshipWithSelf: '不能和自己建立关系',
    duplicateRelationship: (catId: string) => `和「${catId}」的关系写了不止一次`,
    slotKind: (name: string, kind: string) => `片段「${name}」的类型必须是 ${kind}`,
    slotPoses: (name: string, from: Pose, to: Pose) =>
      `片段「${name}」必须从「${zh.poses[from]}」开始、在「${zh.poses[to]}」结束`,
    unknownSlotMustBeOptional: '不在标准片段表里的片段名，必须标成可选（optional: true）',
    transitionSamePose: '过渡片段的开始姿势和结束姿势不能一样',
    nonTransitionPoseChange: '循环片段和动作片段的开始姿势和结束姿势必须一样',
    perFrameLength: (actual: number, frameCount: number) =>
      `需要逐帧记录，应有 ${frameCount} 项，实际有 ${actual} 项`,
    frameOutOfRange: (frame: number, frameCount: number) =>
      `第 ${frame} 帧超出了范围（片段只有 ${frameCount} 帧，从 0 算起）`,
    maxBelowMin: '最多几只猫不能小于最少几只猫',
    summaryOk: (count: number) => `内容校验通过，共检查 ${count} 个文件。`,
    summaryFailed: (count: number) => `内容校验失败，共 ${count} 处问题：`,
  },

  schemas: {
    upToDate: 'schemas/ 下的 JSON Schema 是最新的。',
    outdated: (files: readonly string[]) =>
      `schemas/ 下的 JSON Schema 不是最新的：${files.join('、')}。请运行 npm run gen:schemas 后提交。`,
    written: (count: number) => `已生成 ${count} 个 JSON Schema 到 schemas/。`,
  },
};
