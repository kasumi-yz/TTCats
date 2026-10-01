# 测试猫咪包

仅供开发和验收，不随安装包发布。三只猫共用 22 种合成片段，身份、体型、性格参数和关系各不相同。

在仓库根目录运行 `npm run gen:test-pack`，需要 PATH 中的 ffmpeg 带 libvpx-vp9。提交素材使用 ffmpeg 8.1.1、libvpx-vp9、单线程无损编码、bitexact WebM；相同编码器版本下重新生成结果逐字节一致。不同 ffmpeg/libvpx 版本可能产生不同编码字节。

片段为 128×128、24fps、24 帧，边缘有半透明羽化。六种姿势帧保存在 `poses/`。生成脚本解码 VP9 后逐像素核对首尾帧与姿势帧，再按共享 HitMask 格式从解码后的 alpha 生成遮罩。VP9 使用 YUV420；姿势帧同样经过该颜色转换，确保核对的是播放时的实际像素。

开发时设置 `TTCATS_CONTENT_DIR` 为 `app/test-content` 的绝对路径；主进程拼装模块调用 `contentDirectory`、`loadContent`。`registerContentScheme(protocol)` 必须在 Electron ready 前调用，ready 后调用 `registerContentProtocol(protocol, net, contentDir, catalog)`。桌面层使用共享的 `contentUrl(catId, packPath)` 读取素材。协议保留 Range 请求，拒绝未加载猫咪包、危险路径与指向包外的链接。

`npm run validate:content` 对正式 `content/` 校验档案草稿，对测试猫咪包检查完整性。运行时无论目录来源都严格要求必需片段；目前只有档案的正式豆豆会被停用并报告缺少哪些片段。具体接入应用入口由 #28 主进程拼装完成。

`app/electron-builder.yml` 将正式 `content/` 放到 resources/content，应用文件只包含 out 和 package.json，并显式排除 test-content。已使用 electron-builder 26.15.3 生成 Windows win-unpacked，并检查 app.asar 及 resources/content：归档内不含测试猫咪包，正式资源只有豆豆。仓库目前尚未配置固定的安装包构建命令。
