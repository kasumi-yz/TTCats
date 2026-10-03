// #129：仅开发模式使用；#104 沿用唯一 preload 注入桥，安装版不提供此接口。
// 资源 URL 与 candidateKey 由主进程签发，调用方不能提供任意本机文件路径。
import type { CandidateManifest } from './schemas/candidate-manifest';
import type { ReviewResult } from './schemas/review-result';

export const REVIEW_STATION_CHANNELS = {
  openWindow: 'ttcats:review-station:open-window',
  getLibrary: 'ttcats:review-station:get-library',
  chooseLibrary: 'ttcats:review-station:choose-library',
  loadCandidate: 'ttcats:review-station:load-candidate',
  getSourceFrame: 'ttcats:review-station:get-source-frame',
  chooseBackground: 'ttcats:review-station:choose-background',
  saveResult: 'ttcats:review-station:save-result',
  exportCandidate: 'ttcats:review-station:export-candidate',
  getCandidateLock: 'ttcats:review-station:get-candidate-lock',
  clearCandidateLock: 'ttcats:review-station:clear-candidate-lock',
} as const;

export interface ReviewCandidatePreview {
  /** 素材库会话内的不透明标识。切换素材库后，旧标识失效。 */
  candidateKey: string;
  manifest: CandidateManifest;
  videoUrl: string;
  /** 缺少源帧或工厂记录时仍可播放，说明为何不能标注/重新导出。 */
  editProblem?: string;
}

export interface ReviewLibrary {
  /** 只用于显示，由主进程记住上次用户选择的路径。 */
  path: string;
  candidates: ReviewCandidatePreview[];
  /** 单个候选损坏不阻止其他候选出现；列出带猫/文件信息的中文错误。 */
  problems: string[];
}

export interface ReviewCandidate extends ReviewCandidatePreview {
  /** 已保存结果，或从工厂建议/确认记录还原的未确认草稿（accepted: false）。 */
  draft: ReviewResult;
  /** 当前 review-result.json 的字节哈希；null 表示尚无结果文件。 */
  revision: string | null;
}

export interface ReviewSaveRequest {
  candidateKey: string;
  /** 乐观锁：保存前必须仍与当前文件哈希一致，避免覆盖别的会话。 */
  expectedRevision: string | null;
  result: ReviewResult;
}

export interface ReviewExport {
  /** 正式导出完成后返回新结果，不替换用户正在对照的候选。 */
  manifest: CandidateManifest;
  videoUrl: string;
}

export interface ReviewCandidateLock {
  /** 当前锁文件的字节哈希；确认清除时防止删掉已更换所有者的锁。 */
  revision: string;
  /** 锁被损坏或写入中崩溃时为 null；主进程提供可读的错误说明。 */
  owner: { machine: string; processId: number; processStartedAt: string } | null;
  /** 同机确认仍在运行时禁止清除；异机、损坏或查询失败时为 unknown。 */
  state: 'running' | 'unknown';
  description: string;
}

/** 所有方法均由主进程执行；失败时拒绝 Promise，错误信息为中文。 */
export interface ReviewStationBridge {
  openWindow(): Promise<void>;
  getLibrary(): Promise<ReviewLibrary | null>;
  /** 弹出目录选择器；取消返回 null，当前素材库不变。 */
  chooseLibrary(): Promise<ReviewLibrary | null>;
  /** 无可编辑源记录时拒绝，而不是反推或伪造原始坐标。 */
  loadCandidate(candidateKey: string): Promise<ReviewCandidate>;
  getSourceFrame(candidateKey: string, frame: number): Promise<string>;
  /** 用户选一张现有桌面截图；返回受限资源 URL，取消返回 null。 */
  chooseBackground(): Promise<string | null>;
  /** 校验身份、源记录与哈希后，原子保存并保留最近 5 份备份。 */
  saveResult(request: ReviewSaveRequest): Promise<{ revision: string }>;
  /** 只导出已保存且 accepted 的这次修订；明确由用户按钮触发。 */
  exportCandidate(candidateKey: string, expectedRevision: string): Promise<ReviewExport>;
  /** 同机确认所有者已退出时自动回收；没有锁返回 null。 */
  getCandidateLock(candidateKey: string): Promise<ReviewCandidateLock | null>;
  /** 用户确认后核对锁修订与所有者；仍在运行的锁必须拒绝清除。 */
  clearCandidateLock(candidateKey: string, expectedLockRevision: string): Promise<void>;
}
