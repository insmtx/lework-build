# Mobile 打包配置

流水线从 GitLab 拉取源码，在 GitHub 托管 Runner 上编译：Android 使用 Gradle，iOS 使用 Xcode 和 Fastlane，不依赖 GitLab Runner。

账号和证书在首次接入时配置。日常打包进入 **Actions → Mobile Build → Run workflow**，选择源码版本、构建目标和后端环境即可。

## 先跑通一个包

1. 配好 GitLab 只读访问，选定源码 tag 或 SHA。
2. 检查源码中的应用名称、包名、登录回跳协议和服务地址。
3. 准备对应平台的签名材料。
4. 手工填写 `build_number`，保持 `submit`、`publish_apk` 关闭，先完成构建。
5. 需要下载安装包时，将 `UPLOAD_BUILD_ARTIFACTS` 设为 `true`；确认可公开分发后再开启。

配置入口：**流水线仓库 → Settings → Secrets and variables → Actions**。下表中的 Secret 填到 Secrets，Variable 填到 Variables；只配置本次要构建的平台。

## 源码里的应用配置

应用配置统一在 GitLab 源码仓库维护：

| 内容 | 维护位置 |
| --- | --- |
| 名称、slug、URL scheme、iOS Bundle ID、Android package | `apps/mobile/app.config.ts` 及其引用的配置文件 |
| API、网站、工作台地址 | mobile 的 `.env.*` 和 `app.config.ts` 中的环境映射 |
| 登录回跳、关联域名、App Groups、原生插件 | 源码中的对应配置，与包名和账号能力保持一致 |

流水线只传入 `EXPO_PUBLIC_APP_CHANNEL=production` 和选中的 `EXPO_PUBLIC_RELEASE_ENV`。`release_env=test` 表示正式应用身份连接测试后端，具体地址由源码解析，不需要在 GitHub 再填一套 URL。

构建时只同步版本号和原生构建号，不覆盖应用名称、scheme 或服务地址。用于签名和商店查询的包名保留在 Secrets；若与源码解析出的包名不同，构建会停止。安装包和 R2 文件使用通用的 `mobile` 前缀。

如果尚未迁移应用身份或后端地址，先在源码仓库改好，再打包。当前流程未接入 OTA 发布，源码中应关闭 `updates`。

## GitLab 访问

| 配置名 | 类型 | 填写内容 |
| --- | --- | --- |
| `SOURCE_GIT_URL` | Variable | GitLab 项目的 HTTPS clone 地址，源码包含 `apps/mobile`；URL 不带 token |
| `SOURCE_GIT_USERNAME` | Variable | Deploy Token 生成的用户名，例如 `gitlab+deploy-token-123`；PAT 可用 `oauth2` |
| `SOURCE_GIT_TOKEN` | Secret | 项目 Settings → Repository → Deploy tokens 创建的只读 token，勾选 `read_repository` |
| `SOURCE_GIT_CA_CERT_BASE64` | Secret，可选 | GitLab 使用私有 CA 时填写 PEM 证书链的 Base64；公网受信任证书留空 |

GitHub 的 Ubuntu 和 macOS Runner 都需要通过 HTTPS 443 访问 GitLab。若项目只在内网可达，先和运维打通访问；token 本身不能解决网络问题。源码若依赖 LFS、submodule 或私有包，还要补齐对应的拉取步骤和权限，当前流程未单独接入。

## Android 签名

| 配置名 | 类型 | 填写内容 |
| --- | --- | --- |
| `ANDROID_PACKAGE_NAME` | Secret | 源码正式渠道的 Android package，也用于 Play 查询和上传 |
| `ANDROID_KEYSTORE_BASE64` | Secret | JKS / keystore 文件的 Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | keystore 的 store password |
| `ANDROID_KEY_ALIAS` | Secret | 签名密钥 alias，可用 `keytool -list -keystore mobile-upload.jks` 查看 |
| `ANDROID_KEY_PASSWORD` | Secret | 该 alias 的 key password，不一定与 store password 相同 |
| `GOOGLE_SERVICES_PROD_JSON_BASE64` | Secret，可选 | 使用 Firebase / FCM 时填写 Android 应用的 `google-services.json` Base64，包名须一致 |

已发布的应用沿用现有上传密钥。新应用还没有 keystore 时，可以交互生成并妥善备份：

```bash
keytool -genkeypair -v -keystore mobile-upload.jks -alias mobile-upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

Firebase 配置恢复到 `apps/mobile/secrets/google-services-prod.json`，由源码的 `googleServicesFile` 配置引用。

使用 Play App Signing 时，上传密钥和最终安装包签名可能不同。下载站 APK 与 Play 版需要覆盖升级时，先核对最终签名。

## iOS 签名

| 配置名 | 类型 | 填写内容 |
| --- | --- | --- |
| `IOS_APP_BUNDLE_ID` | Secret | 源码正式渠道的 Bundle ID，与 App ID、profile 和商店记录一致 |
| `IOS_PROJECT_NAME` | Secret | prebuild 生成的 Xcode 工程名，不带扩展名；当前构建使用同名 workspace、scheme 和主 target |
| `APPLE_TEAM_ID` | Variable | Apple Developer → Membership Details 中的 Team ID |
| `IOS_DISTRIBUTION_CERT_BASE64` | Secret | Apple Distribution 证书与匹配私钥一起导出的 `.p12` Base64 |
| `IOS_CERT_PASSWORD` | Secret | 导出 P12 时设置的密码 |
| `IOS_PROFILE_ADHOC_BASE64` | Secret | Ad Hoc profile 的 Base64，包含演示或测试设备 UDID |
| `IOS_PROFILE_APP_BASE64` | Secret | App Store Connect profile 的 Base64，用于 TestFlight / 商店包 |

按构建目标准备 profile：`ios-adhoc` 用 Ad Hoc，`ios-store` 用 App Store Connect，不需要一次配齐两份。

准备顺序：

1. 在 Apple Developer 注册对应 Bundle ID 的 App ID，启用源码需要的能力。
2. 在 Mac 上创建 CSR，申请 Apple Distribution 证书。
3. 在钥匙串中将证书和私钥一起导出为 P12；仅有 `.cer` 无法签名。
4. 用同一 Team、App ID 和分发证书生成 profile。Ad Hoc 还需提前登记设备 UDID；新增设备后重新生成 profile。

流水线会核对 Team、Bundle ID、profile 类型、有效期和证书匹配关系。临时 keychain 密码自动生成，结束后清理，不用额外配置。

当前 iOS 签名步骤处理主 App。源码若保留 Widget 等扩展，还需接入扩展的 profile 和签名步骤；其 App ID、App Groups 等能力也要一并准备。

## 商店凭据

仅在自动查询构建号或开启 `submit` 时需要。手工填号且不上传商店，可以先跳过。

| 配置名 | 类型 | 获取位置 |
| --- | --- | --- |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` | Secret | Google Cloud 启用 Android Publisher API，创建服务账号并下载 JSON；在 Play Console 给该邮箱授予对应应用的读取、上传和轨道权限，再将 JSON 转 Base64 |
| `ASC_API_KEY_P8_BASE64` | Secret | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys，创建 API Key 并下载 P8，转 Base64 |
| `ASC_KEY_ID` | Secret | 上述 API Key 的 Key ID |
| `ASC_ISSUER_ID` | Secret | 同一团队的 Issuer ID |

商店中先创建与包名对应的应用记录。P8 只能下载一次，下载后备份。

`build_number` 留空时，流水线查询对应商店的最大构建号并加一；可用 `build_number_offset` 增加偏移。手工填号时也要高于商店已接收的值。

`submit=true` 上传本次构建的 AAB / IPA。Play 默认上传 internal，选择 production 也只创建 draft；TestFlight 上传后仍需等待 Apple 处理，测试组分配、外测审核和正式发布在商店后台完成。首个 Play AAB 可能需要先手工上传。

## 下载、归档和通知

以下功能按需开启，默认均关闭；飞书未配置时跳过通知。

| 配置名 | 类型 | 用途 |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | Secret | Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | Secret | R2 S3 Access Key ID，授予目标 bucket 的 Object Read & Write 权限 |
| `R2_SECRET_ACCESS_KEY` | Secret | 同次生成的 Secret Access Key |
| `R2_BUCKET_NAME` | Variable | 存放 APK 的 bucket |
| `R2_PUBLIC_BASE_URL` | Variable | bucket 对应的 HTTPS 下载域名 |
| `R2_OBJECT_PREFIX` | Variable，可选 | 默认 `mobile/appUpdate`，自动追加 `test` 或 `production` |
| `UPLOAD_BUILD_ARTIFACTS` | Variable，可选 | `true` 时上传 Actions 安装包附件及校验清单，保留 30 天 |
| `ARCHIVE_RELEASE` | Variable，可选 | `true` 时归档到本仓库的 GitHub Release |
| `FEISHU_RELEASE_WEBHOOK_URL` | Secret，可选 | 通知群自定义机器人的 webhook |
| `FEISHU_RELEASE_WEBHOOK_SECRET` | Secret，可选 | 机器人的签名密钥 |

`publish_apk=true` 时上传 APK 到 R2，同时更新对应环境的 `mobile_Android_latest.apk`，随后校验下载文件的 SHA256、大小和 Range / 206 响应。

本仓库公开，Actions 附件、GitHub Release 和公开 R2 域名都应按公开分发处理。未开启下载或上传入口时，构建只做编译和校验，结束后不保留安装包。源码、证书、私钥、完整工作目录不作为附件上传。

## 运行参数

| 参数 | 说明 |
| --- | --- |
| `ref` | GitLab 源码 tag、branch 或 SHA；两端需要同一源码时使用同一个完整 SHA |
| `build_target` | `android-apk`、`android-play`、`ios-adhoc`、`ios-store` |
| `version` | `mobile-vX.Y.Z` 或 `vX.Y.Z` 可自动提取；branch / SHA 需要另填 `X.Y.Z` |
| `release_env` | `test` 或 `production`，由源码选择对应后端配置 |
| `build_number` | 正整数；留空查询商店后加一 |
| `build_number_offset` | 自动构建号的非负偏移量，默认 `0` |
| `target` | Android 分发标记；iOS 固定 `production` |
| `submit` | 上传 AAB / IPA 到 Play / TestFlight，默认 `false` |
| `play_track` | `internal`、`beta`、`production`，默认 `internal` |
| `publish_apk` | 上传 APK 到 R2，默认 `false` |

APK 和 Ad Hoc 包不能上传商店；连接 test 后端的 AAB 不能提交 Play production 轨道。工作流只在流水线仓库 `main` 分支执行，也支持 `mobile-android-release` / `mobile-ios-release` 的 `repository_dispatch` 事件。

## 写入 Secret

二进制材料转 Base64 后直接写入，避免在终端打印内容：

```bash
base64 < mobile-upload.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 -R OWNER/PIPELINE_REPO
# P12、profile、JSON、P8 同样处理，替换文件名和 Secret 名称。
gh secret set SOURCE_GIT_TOKEN -R OWNER/PIPELINE_REPO
```

最后一条命令交互输入 token。不要把 token、私钥或后端完整 `.env` 放进 Git；Base64 只是编码，不是加密。

首包完成后，核对包名、后端环境、版本号和签名，再做真机安装与登录验证。开启商店或 R2 上传后，再检查对应入口是否接收成功。

参考：[Expo 应用配置](https://docs.expo.dev/workflow/configuration/)、[GitLab Deploy Token](https://docs.gitlab.com/user/project/deploy_tokens/)、[Apple 证书与 profile](https://developer.apple.com/account/resources/)、[Play API](https://developers.google.com/android-publisher/getting_started)、[R2 token](https://developers.cloudflare.com/r2/api/s3/tokens/)。
