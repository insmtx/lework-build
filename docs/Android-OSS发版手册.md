# LeWork Android APK 发版手册（OSS）

本文用于将 LeWork Android 安装包构建并发布到阿里云 OSS。iOS、Google Play 和旧 R2 发布不属于本操作流程。

## 一、发布入口与前提

流水线仓库：https://github.com/insmtx/lework-build

在 Actions 中运行 **Mobile Build**。新增 OSS 功能需先合入 `main`，该 workflow 仅允许从流水线仓库 `main` 执行。

管理员须预先完成：

- 配置源码访问凭据、Android 包名、签名 keystore 及其密码和 alias，详见 `configuration.md`。
- 在本手机流水线仓库配置 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`。桌面流水线 Secrets 不会自动共享。
- RAM 凭据可以读取、上传 `lework-saas` 桶的 `mobile/lework/*`。
- `mobile/lework/production/*` 允许匿名 `oss:GetObject`。需要公开测试包时，再为 test 目录单独授权。

Android 更新需保持包名和签名身份不变。请使用此前发行版本对应的签名材料。

## 二、正式发版参数

打开 Actions → Mobile Build → Run workflow，按表填写：

| 参数 | 正式发布填写方式 |
|---|---|
| 流水线分支 | `main` |
| `ref` | 应用源码分支、tag 或完整 SHA；不是流水线仓库分支 |
| `build_target` | `android-apk` |
| `release_env` | `production`，连接生产后端 |
| `version` | 如 `0.1.18`；使用 `mobile-vX.Y.Z` 或 `vX.Y.Z` tag 时可自动提取 |
| `build_number` | 大于此前发行包的正整数。无商店账号时必须填写；留空会尝试查询商店 |
| `build_number_offset` | 通常保持 `0`，仅用于自动商店构建号的偏移 |
| `target` | `production` |
| `publish_oss` | **勾选**，构建成功后直接更新 OSS 线上 APK 清单 |
| `publish_apk` | 不勾选；这是原 R2 发布功能 |
| `submit` | 不勾选；这是 Play/TestFlight 商店上传功能 |
| `play_track` | 保持默认 `internal`；未提交商店时不生效 |

选择 ref 前确认代码已推送到远程源码仓库。推荐使用明确的版本 tag 或完整提交 SHA，便于追溯。

## 三、先验收，再正式发布

**publish_oss 会在同一次运行中自动发布，没有单独的人工审批步骤。**

首次发版或有重要改动时：

1. 先填写生产构建参数，但不勾选 `publish_oss`、`publish_apk`、`submit`。
2. 如需下载验收包，在 Repository Variables 中将 `UPLOAD_BUILD_ARTIFACTS` 设置为 `true`。未开启附件或其他分发功能时，构建结束不会保留可下载的安装包。
3. 构建成功后下载 Actions Artifact，在 Android 设备验证安装、启动、登录、后端连接和主要功能。
4. 验收通过后用相同源码 ref 发起正式运行，勾选 `publish_oss`。自动生成构建号时，第二次运行的构建号可能变化；以最终产物为准再次核验。

当前流程会重新构建，不是把之前的 Artifact 直接发布。若希望严格发布同一份已验收二进制，需要后续单独拆分发布流水线。

测试环境使用 `release_env=test`。测试 APK 发布到 test 目录，不会更新官网使用的 production 清单。未对 test 目录授权匿名读取时，公开下载校验会失败。

## 四、产物与 OSS 位置

Bucket：`lework-saas`；地域：杭州。

| 内容 | 路径 |
|---|---|
| 正式版 APK | `mobile/lework/production/<构建产物文件名>.apk` |
| 正式版清单 | `mobile/lework/production/latest.json` |
| 测试版 APK | `mobile/lework/test/<构建产物文件名>.apk` |
| 测试版清单 | `mobile/lework/test/latest.json` |

正式清单地址：

https://lework-saas.oss-cn-hangzhou.aliyuncs.com/mobile/lework/production/latest.json

清单包含 `version`、`build_number`、`sha256`、`bytes` 和版本化 APK 的 `url`。

发布脚本会校验本地 APK 与构建清单，上传 APK，并验证公网下载 SHA256，通过后才更新 latest.json。同名 APK 内容不同会被拒绝；低于线上构建号的发布也会被拒绝。

## 五、发布成功后的检查

1. 确认 Mobile Build 中 OSS 上传步骤成功。
2. 无痕浏览器打开 production/latest.json，核对版本、构建号和下载链接。
3. 下载该 APK，在 Android 真机验证全新安装和覆盖升级。
4. 官网手机入口代码部署后，下载页会读取 production 清单显示 Android 下载链接；清单上传成功不等于官网代码已自动部署。
5. 记录版本号、构建号、源码 SHA、Actions 运行链接、APK 地址和验收结果。

注意：APK 分发与 Google Play 发布是两条独立渠道。本流程不会提交 Play，也不会自动配置手机应用内更新逻辑。官网会读取新清单不代表已安装手机 App 会自动升级。

## 六、常见问题

| 现象 | 处理 |
|---|---|
| 看不到 publish_oss | 确认新增 workflow 已合入 main，刷新 Run workflow 页面 |
| 选择非 APK 后 OSS 报错 | OSS 发布只支持 android-apk；iOS、AAB 不可勾选 |
| 缺少构建号或商店凭据 | 无商店账号时显式填写 build_number |
| APK 无法覆盖安装 | 检查包名、签名证书和构建号是否符合升级条件 |
| OSS 上传 403 | 检查 RAM 对新桶及 mobile/lework 目录的上传、读取权限 |
| 上传后公网校验失败 | 检查目录匿名读取、阻止公共访问及网络情况；脚本不会在校验失败后更新清单 |
| 404 NoSuchKey | 可能尚未完成首次发布；检查路径和生产/测试环境 |
| 官网没有 Android 入口 | 确认 production 清单存在、网站接入代码已部署；当前网页修改未必已上线 |
| 新包构建号低于线上 | 使用更高构建号重新构建；不要直接覆盖线上清单 |

如果流程失败，查看日志确认是否已有部分文件上传，再决定重试。不要复用同一文件名发布不同内容。

## 七、Google Play 参数说明

`play_track` 仅在 `android-play` 且 `submit=true` 时使用：internal 为内部测试，beta 为测试渠道，production 为正式渠道（当前流水线只创建草稿）。OSS APK 发布保持默认值即可。


## APK 文件命名

生产包：`lework-<版本>-<构建号>-android.apk`；测试环境：`lework-<版本>-<构建号>-android-test.apk`。
选择 internal/external 分发标记时追加对应后缀，避免不同分发包重名。构建清单、SHA256 文件、OSS 上传和官网清单均使用最终产物名称。AAB、IPA 命名保持现有格式。
