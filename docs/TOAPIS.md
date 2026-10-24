# Optional ToAPIs asynchronous media / 可选异步图片与视频

ToAPIs is user-selected and uses the account's own key. This integration does not change the default providers, add a runtime dependency, or imply sponsorship. Restart DSH after installing host-side changes; refresh the browser for the settings UI.

## Settings / 设置

| Setting | Purpose / 用途 | Initial value |
|---|---|---|
| Image backend | Select ToAPIs only when wanted / 手动选择 | Ark remains default |
| ToAPIs Base URL | China / 国内 or international / 国际 | `https://toapis.cn/v1` / `https://toapis.com/v1` |
| ToAPIs API Key | Stored and masked on the host; never committed / 宿主保存并脱敏 | empty |
| Image model / size / quality | Account/model-specific / 按账号及模型配置 | `gpt-image-2-vip`, `1K`, `low` |
| Use ToAPIs for video | Optional, mutually exclusive with ComfyUI video in the UI | off |
| Video model / duration / resolution | Independent of MiniMax controls / 独立参数 | `seedance-2-mini`, 4s, `480p` |
| Timeout | Covers image upload, submission, polling and download / 图片整次调用截止时间 | 600s |

Origins with or without `/v1` are accepted; do not append `/v1` twice. HTTP is accepted only for a localhost proxy. HTTPS custom gateways are user configuration; API requests reject redirects. The key is not copied to result URLs.

The initial image output is one file per call. `1024x768` becomes ratio `4:3` with `1K`; `1K/2K/4K` use `1:1`. Actual dimensions and supported ratios depend on the selected model. Empty quality omits that parameter for models that do not accept it. Image references are uploaded through `/v1/uploads/images`.

Initial video scope: text or **one first-frame image**, MP4, audio off, 16:9. Last-frame and multimodal reference inputs are rejected **before generation**. Video model, duration and resolution come from ToAPIs settings, not MiniMax defaults. Ensure your selected model supports them. Seedance Global variants are rejected. Existing ComfyUI/MiniMax jobs keep their saved backend; ToAPIs identities survive project and sequence-job reloads.

初始视频只支持文生视频或一张首帧图，MP4、无音频、16:9。尾帧和多模态参考会在付费提交前拒绝。ToAPIs模型／时长／分辨率独立于MiniMax参数；旧任务按节点保存的后端继续查询。

## API and costs / 接口及费用

- Images: `POST /v1/images/generations`, `GET /v1/images/generations/{id}`.
- Videos: `POST /v1/videos/generations`, `GET /v1/videos/generations/{id}`.
- References: multipart `POST /v1/uploads/images` with `file`.
- Pricing: use your own key with `GET /v1/pricing?model=...`. Prices depend on account group, model and conditions. Billing units can differ; a token-priced video's observed $/s is not a fixed seconds tariff. Quotes and settled billing must be distinguished. Never commit a key or private signed output URL.

[Official quickstart / 官方说明](https://docs.toapis.com/docs/cn/quickstart) · [Pricing and actual costs / 计费](https://docs.toapis.com/docs/cn/api-reference/account/pricing).

## Paid submission safety / 付费提交安全

There are no automatic paid POST retries or paid-provider fallbacks. Receipts under `<DSH_HOME>/game-material-master/toapis-receipts/` contain request fingerprints, task IDs and delivery state, not API keys, prompts or reference bytes. If submission is ambiguous or a task ID is missing, the receipt blocks a duplicate submission. Check the account/task history and contact the provider before manually archiving the receipt to retry. A cancelled local wait does **not** cancel the remote paid task.

Repeat the same image operation after an interrupted wait to recover its task instead of buying another generation; the stable fingerprint uses the original reference input, not changing upload URLs. After successful delivery a deliberate regeneration can submit a new task. A failed/expired task requires reconciliation before retry. Videos persist task ID and backend before the host polling path; completed results are downloaded without authorization headers, checked for media signature and bounded to 32 MiB/image or 100 MiB/video. For image errors, inspect the local receipt path shown in the message; do not publicly post receipts or keys.

没有自动重复付费POST或自动切换到另一家付费供应商。超时／取消仅结束本地等待，远端可能仍已受理并计费。缺ID或未知提交先核对账号记录；已知ID可通过对应查询接口核对，确认状态与费用后再处理回执，不要直接反复点击生成。

## Verification / 验证

`npm run build`, `npm run typecheck`, then `node scripts/verify-toapis.mjs`. The new test runs a local mock HTTP server through the actual image/video dispatchers, config masking, media downloads and persisted project/sequence identities. It covers cancellation recovery, uncertain submission blocking, independent video settings, credential isolation, reference upload, disabled models and unsupported inputs. `scripts/verify-feedback.mjs` renders the compiled settings tree and checks the additional option and key input.

These tests are **mock transport / local integration checks**. They do not claim fresh paid generation, production DSH installation, eight-direction consistency, chroma cleanup or end-to-end sprite export. Existing external API examples are separate evidence, not proof this exact application revision has passed live acceptance. No paid e2e scripts are run automatically.
