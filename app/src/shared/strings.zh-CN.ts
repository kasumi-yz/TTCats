// 界面文字和报错文字都集中放在这里（AGENTS.md 语言约定）。
// 代码里不要散落中文字符串，需要新文字就加到这个文件。
//
// 按模块分段：每个模块一段，键名用模块名（比如 save、overlay、panels、stage）。
// 各个 issue 只加自己模块的那一段、不改别人的，这样并行开发时不容易冲突。
// 新的一段加在文件末尾、`};` 的前面。
import type { Pose } from './schemas/pose';

export const zh = {
  app: {
    name: 'TTCats',
    panelsTitle: 'TTCats',
    panelsPlaceholder: '项目骨架已就绪。设置和调试台在 M1 里做。',
    rootElementMissing: '页面里找不到 #root 元素，面板无法显示。',
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
    hitMaskScale: '点击遮罩缩小倍数',
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
    visibleCats: '显示哪几只猫',
    activityLevel: '活跃度',
    scale: '缩放',
    floorDepth: '地板纵深',
    showInScreenCapture: '截图里是否显示猫',
    saveVersion: '存档版本',
    savedAt: '保存时间',
    state: '存档状态',
    settings: '设置',
    purrEnabled: '呼噜开关',
    purrVolume: '呼噜音量',
    meowEnabled: '喵叫开关',
    meowVolume: '喵叫音量',
    quietHoursStart: '安静时段开始',
    quietHoursEnd: '安静时段结束',
    hideAllShortcut: '一键隐藏快捷键',
    launchAtLogin: '开机启动',
    autoUpdate: '自动更新',
    display: '显示器',
    label: '显示器名字',
    doNotDisturb: '勿扰模式',
    mode: '模式',
    until: '结束时间',
  } as Readonly<Record<string, string>>,

  validation: {
    wholeFile: '（整个文件）',
    catPack: (catId: string) => `猫咪包「${catId}」`,
    eventFile: (file: string) => `事件配置「${file}」`,
    missingField: (field: string) => `缺少必填字段 ${field}`,
    badField: (field: string, detail: string) => `字段 ${field} 不对：${detail}`,
    unknownFields: (keys: readonly string[]) =>
      `有不认识的字段：${keys.join('、')}（是不是拼错了？）`,
    unknownFieldsIn: (path: string, keys: readonly string[]) =>
      `${path} 里有不认识的字段：${keys.join('、')}（是不是拼错了？）`,
    fileNotJson: (detail: string) => `不是合法的 JSON：${detail}`,
    fileMissing: (file: string) => `缺少文件 ${file}`,
    referencedFileMissing: (field: string, file: string) =>
      `字段 ${field} 指向的文件不存在：${file}`,
    referencedNotAFile: (field: string, file: string) =>
      `字段 ${field} 指向的是文件夹，不是文件：${file}`,
    referencedOutsidePack: (field: string, file: string) =>
      `字段 ${field} 指向了猫咪包外面：${file}`,
    idMismatch: (id: string, expected: string) =>
      `id 写的是「${id}」，但它所在的文件夹或文件名是「${expected}」，两者必须一样`,
    idFormat: '只能用小写英文、数字和连字符',
    dateFormat: '日期格式应为 YYYY-MM-DD',
    timeOfDayFormat: '时刻格式应为 HH:MM（24 小时制）',
    monthDayFormat: '日期格式应为 MM-DD，并且是真实存在的日子（2 月 29 日可以）',
    packPathFormat:
      '应是猫咪包内部的相对路径，用正斜杠分隔，不能包含 . 或 .. 路径段、空段、反斜杠、冒号、换行等控制字符',
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
    acceleratorFormat:
      '快捷键写法不对：应写成"修饰键+按键"，比如 Ctrl+Alt+Shift+H。修饰键可以用 Ctrl、Alt、Shift、Super（Win 键），不能重复；按键只能有一个，可以是字母、数字、F1～F24、方向键等',
    acceleratorNeedsModifier:
      '快捷键至少要有一个 Ctrl、Alt 或 Super（Win 键）。只用 Shift 的话，打字时也会触发',
    acceleratorReserved: '这个快捷键已经给调试台用了（Ctrl+Shift+F10），请换一个',
    summaryOk: (count: number) => `内容校验通过，共检查 ${count} 个文件。`,
    summaryFailed: (count: number) => `内容校验失败，共 ${count} 处问题：`,
  },

  schemas: {
    upToDate: 'schemas/ 下的 JSON Schema 是最新的。',
    outdated: (files: readonly string[]) =>
      `schemas/ 下的 JSON Schema 不是最新的：${files.join('、')}。请运行 npm run gen:schemas 后提交。`,
    written: (count: number) => `已生成 ${count} 个 JSON Schema 到 schemas/。`,
  },

  save: {
    loadedMain: (file: string) => `已读取主存档「${file}」。`,
    loadedBackup: (file: string) => `已回退到备份存档「${file}」。`,
    usingDefault: '没有能正常读取的存档，已使用默认状态。',
    fileMissing: (file: string) => `存档「${file}」不存在。`,
    readFailed: (file: string) => `无法读取存档「${file}」，请检查文件权限和磁盘。`,
    invalidJson: (file: string) => `存档「${file}」不是合法的 JSON。`,
    invalidEnvelope: (file: string) =>
      `存档「${file}」的外层格式不对，请检查存档版本、保存时间和状态字段。`,
    invalidState: (file: string, fields: readonly string[]) =>
      `存档「${file}」的数据校验失败，字段：${fields.join('、')}。`,
    migrated: (file: string, from: number, to: number) =>
      `存档「${file}」已从版本 ${from} 迁移到版本 ${to}。`,
    migrationMissing: (file: string, from: number, to: number) =>
      `存档「${file}」缺少从版本 ${from} 到版本 ${to} 的迁移步骤。`,
    migrationFailed: (file: string, from: number, to: number) =>
      `存档「${file}」从版本 ${from} 到版本 ${to} 的迁移失败。`,
    newerVersion: (file: string, version: number, current: number) =>
      `存档「${file}」的版本 ${version} 比当前程序支持的版本 ${current} 新，已禁止覆盖，请使用更新的程序打开。`,
    writeProtected: '检测到更新版本的存档，已禁止写入，以免丢失数据。',
    written: (file: string) => `已安全写入存档「${file}」。`,
    writeFailed: (file: string) => `存档「${file}」写入失败，请检查文件权限和磁盘。`,
    backupFailed: (file: string) => `存档「${file}」的备份轮换失败，请检查文件权限和磁盘。`,
    invalidOptions: '存档配置不对：版本必须是正整数，合并写入间隔必须是非负有限数。',
    invalidTime: '存档保存时间必须是非负有限数。',
    wholeState: '整个存档状态',
  },
  panels: {
    settings: '设置',
    profile: '资料卡',
    debug: '调试台',
    loading: '正在读取猫咪包和状态…',
    unavailable: '面板无法连接主进程，请在应用中打开。',
    loadFailed: '读取猫咪包或状态失败，请重新打开面板。',
    commandFailed: '命令发送失败，请重试。',
    noCats: '没有可用的猫咪包。',
    catMissing: '找不到这只猫的猫咪包。',
    visibleCats: '显示哪几只猫',
    activityLevel: '活跃度',
    activityLevels: { quiet: '安静', lazy: '慵懒', natural: '自然', lively: '活泼', rowdy: '闹腾' },
    scale: '大小',
    floorDepth: '地板纵深',
    capture: '截图和会议里显示猫',
    captureHelp: '只在 Windows 10 2004 以上有效，只对使用系统标准截屏接口的软件有效',
    birthday: '生日',
    homeDate: '到家日',
    age: '年龄',
    unknown: '未提供',
    ageYears: (years: number) => `${years} 岁`,
    notBorn: '还没出生',
    personality: '性格参数',
    personalityLabels: {
      activity: '活跃',
      clinginess: '黏人',
      initiative: '主动',
      dominance: '强势',
      patience: '耐心',
    },
    cat: '猫',
    summonAll: '召唤全部显示中的猫',
    summon: '召唤',
    sleep: '睡觉',
    show: '显示',
    hide: '隐藏',
    clip: '片段',
    playClip: '播放片段',
    simulations: { poke: '模拟单击', pet: '模拟撸猫', pickUp: '模拟拎起', drop: '模拟放下' },
    crash: '让桌面层崩溃（测试恢复）',
    savedState: '主进程存档状态',
    stageState: '桌面层画面状态',
    visible: '显示中',
    hidden: '已隐藏',
    waitingReport: '等待桌面层上报',
    pose: '姿势',
    behavior: '行为',
    variant: '版本',
    position: '位置',
    revision: '快照版本',
    reportedAt: '上报时间',
    disabledPacks: '已停用的猫咪包',
  },
  game: {
    catUnavailable: (cat: string) => `猫「${cat}」的猫咪包未加载或已停用，无法执行命令。`,
    catHidden: (cat: string) => `猫「${cat}」当前已隐藏，请先显示它再执行命令。`,
    clipUnavailable: (cat: string, clip: string, variant?: number) =>
      `猫「${cat}」缺少片段「${clip}」${variant === undefined ? '' : `的版本 ${variant}`}，无法播放。`,
  },

  stage: {
    /** 调试台里显示的行为（Behavior）说明。 */
    behaviors: {
      idle: '待着',
      rest: { stand: '站一会儿', sit: '坐下歇着', sleep: '去睡觉' },
      wander: '溜达',
      action: (clip: string) => `做动作「${clip}」`,
      summon: '被召唤过来',
      sleepCommand: '被叫去睡觉',
      debugClip: (clip: string) => `调试：播放「${clip}」`,
    },
  },
  stagePointer: {
    friendly: '喵～',
    reserved: '喵？',
    behaviors: {
      poked: '被戳到',
      petted: '被撸着',
      pickedUp: '被拎着',
      dropped: '放下落地',
      approach: '凑近鼠标',
      avoid: '走开',
    },
  },
  content: {
    packReadFailed: (detail: string) =>
      `无法读取猫咪包文件，请检查 cat.json、clips 目录和文件权限：${detail}`,
    duplicateClip: (name: string, variant: number) =>
      `片段「${name}」的版本 ${variant} 重复，不能确定该播放哪一段。`,
    missingClips: (names: readonly string[]) => `缺少必需片段：${names.join('、')}`,
    maskLength: (file: string, expected: number, actual: number) =>
      `点击遮罩 ${file} 长度不对，应为 ${expected} 字节，实际 ${actual} 字节`,
    denied: '禁止读取未加载的猫咪包或包外路径。',
    generationFailed: (detail: string) => `测试猫咪包生成失败：${detail}`,
    endpointMismatch: (name: string) => `片段「${name}」首尾帧与姿势帧不一致。`,
    generated: '测试猫咪包已生成，全部片段首尾帧已核对。',
  },
  recovery: {
    invalidLogOptions: '日志配置不对：单文件至少 256 字节，备份份数必须是 0～20 的整数。',
    invalidTimeout: '桌面层无响应等待时间必须是非负有限数。',
    invalidTime: '崩溃恢复时间必须是非负有限数。',
    logWriteFailed: (file: string) => `无法写入日志「${file}」，请检查文件权限和磁盘。`,
    retry: (count: number) =>
      `桌面层发生故障，正在自动重新加载（5 分钟内第 ${count} 次，最多 3 次）。`,
    unresponsive: '桌面层长时间没有响应，正在终止故障的渲染进程。',
    safeModeTitle: 'TTCats 已进入安全模式',
    openLogs: '打开日志文件夹',
    close: '关闭',
    safeMode: (cats: readonly string[], hasBackup: boolean, identified: boolean) =>
      `桌面层在 5 分钟内连续发生了 4 次故障，已停止自动重试并进入安全模式。本次运行里桌面上的猫不会再出现，面板仍可使用。${hasBackup ? '已加载最近一份正常的备份存档。' : '没有可用的备份存档，暂时使用默认设置，原存档仍保留。'}${cats.length > 0 ? `${identified ? '已确定故障来源，本次运行已停用猫咪包' : '无法确定故障来源，本次运行已停用所有当前显示的猫咪包'}：${cats.join('、')}。` : '当前没有显示中的猫咪包。'}请打开日志文件夹查看故障记录，修复或移除出问题的猫咪包后，退出并重新打开 TTCats。`,
    rendererLogSkipped: (name: string, count: number) =>
      `来源「${name}」报错过于频繁，已省略 ${count} 条日志。`,
    failed:
      '桌面层恢复失败，已停止自动重试并隐藏桌面层，原存档仍保留。请打开日志文件夹查看故障记录，修复问题后退出并重新打开 TTCats。',
  },
  overlay: {
    title: 'TTCats 桌面层',
    bridgeMissing:
      '\u684c\u9762\u5c42\u65e0\u6cd5\u8fde\u63a5\u4e3b\u8fdb\u7a0b\uff0c\u8bf7\u68c0\u67e5 preload \u8def\u5f84\u3002',
    missingClip: (cat: string, clip: string) => `${cat}：缺少片段 ${clip}。`,
    loadFailed: (cat: string, file: string) => `${cat}：无法加载片段文件 ${file}。`,
    badMask: (cat: string, file: string) => `${cat}：点击遮罩 ${file} 的长度不正确。`,
  },
  overlayAudio: {
    failed: (cat: string, file: string, detail: string) =>
      `${cat}：无法播放声音文件 ${file}。原因：${detail}`,
  },
  integration: {
    summon: '召唤',
    visibility: '显示或隐藏猫',
    capture: '截图里显示猫',
    settings: '设置',
    quit: '退出',
    come: '叫它过来',
    sleep: '让它睡觉',
    hide: '暂时隐藏它',
    profile: '查看资料卡',
    invalidMessage: (type: string, paths: string[]) =>
      `收到无效的窗口消息「${type}」，已拒绝。字段：${paths.join('、')}。`,
    unknownMessageType: '未知类型',
    unknownSender: '消息不是来自已登记窗口的主框架，已拒绝。',
    shortcutFailed: '调试台快捷键 Ctrl+Shift+F10 注册失败，可能已被其他程序占用。',
    startupFailed: 'TTCats 启动失败，请查看日志。',
    saveFailed: '退出前保存失败。请检查磁盘空间和目录权限后重试，或不保存直接退出。',
    retrySave: '重试',
    quitWithoutSaving: '不保存，直接退出',
    saveAbandoned: '用户选择不保存，放弃本次存档写入并退出。',
    overlayBoundsMismatch: (expected: string, actual: string) =>
      `桌面层窗口尺寸重试后仍不一致：期望 ${expected}，实际 ${actual}。`,
    disabledPack: (name: string) =>
      `猫咪包「${name}」因桌面层连续故障在本次运行中停用，原文件和显示偏好保留。`,
  },
  /** M2 共享接口（#52）：存档迁移。 */
  interfaces: {
    migrationBadShape: (from: number) =>
      `版本 ${from} 的存档状态格式不对（应该是带 settings 的对象），无法迁移。`,
    commandNotReady: (type: string) => `命令「${type}」对应的功能还没做好，已忽略。`,
  },
};
