// 桌面层读取猫咪包文件（视频、点击遮罩）用的地址。M1 定稿（#18）。
// 主进程注册这个协议，只允许读已加载的猫咪包里的文件；桌面层用 contentUrl() 拼地址。

export const CONTENT_PROTOCOL = 'ttcats-content';

/**
 * 猫咪包里某个文件的地址：`ttcats-content://cats/<猫 id>/<包内路径>`。
 * 包内路径的每一段都单独做 URL 编码，所以中文文件名、空格都没问题。
 */
export function contentUrl(cat: string, packPath: string): string {
  const path = packPath.split('/').map(encodeURIComponent).join('/');
  return `${CONTENT_PROTOCOL}://cats/${encodeURIComponent(cat)}/${path}`;
}
