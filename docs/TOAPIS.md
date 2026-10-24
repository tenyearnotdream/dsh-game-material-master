# Optional ToAPIs asynchronous media / 可选异步图片与视频

ToAPIs is user-selected and uses the account's own key. This integration does not change the default providers, add a runtime dependency, or imply sponsorship. Restart DSH after installing host-side changes; refresh the browser for the settings UI.

## Settings / 设置

| Setting | Purpose / 用途 | Initial value |
|---|---|---|
| Image backend | Select ToAPIs only when wanted / 手动选择 | Ark remains default |
| ToAPIs Base URL | China / 国内 or international / 国际 | `https://toapis.cn/v1` / `https://toapis.com/v1` |
| ToAPIs API Key | Stored and masked on the host; never committed / 宿主保存并脱敏 | empty |
| Image background | GPT Image only; `auto`, `transparent`, `opaque` / 原生透明 PNG | `auto` |
| Video aspect ratio | Match first-frame composition; square sprites: `1:1` / 方形角色建议 1:1 | `16:9` |
| Image model / size / quality | Account/model-specific / 按账号及模型配置 | `gpt-image-2-vip`, `1K`, `low` |
| Use ToAPIs for video | Optional, mutually exclusive with ComfyUI video in the UI | off |
| Video model / duration / resolution | Independent of MiniMax controls / 独立参数 | `seedance-2-mini`, 4s, `480p` |
| Timeout | Covers image upload, submission, polling and download / 图片整次调用截止时间 | 600s |

Origins with or without `/v1` are accepted; do not append `/v1` twice. HTTP is accepted only for a localhost proxy. HTTPS custom gateways are user configuration; API requests reject redirects. The key is not copied to result URLs.

The initial image output is one file per call. `1024x768` becomes ratio `4:3` with `1K`; `1K/2K/4K` use `1:1`. Actual dimensions and supported ratios depend on the selected model. Empty quality omits that parameter for models that do not accept it. Image references are uploaded through `/v1/uploads/images`.

Initial video scope: text or **one first-frame image**, MP4, audio off, configurable ratio (default `16:9`; use `1:1` for square sprites). Last-frame and multimodal reference inputs are rejected **before generation**. Video model, duration and resolution come from ToAPIs settings, not MiniMax defaults. Ensure your selected model supports them. Seedance Global variants are rejected. Existing ComfyUI/MiniMax jobs keep their saved backend; ToAPIs identities survive project and sequence-job reloads.

初始视频只支持文生视频或一张首帧图，MP4、无音频、可选比例（默认16:9，方形角色建议1:1）。尾帧和多模态参考会在付费提交前拒绝。ToAPIs模型／时长／分辨率独立于MiniMax参数；旧任务按节点保存的后端继续查询。

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

These automated tests are **mock transport / local integration checks**. They remain separate from the [2026-10-24 real DSH acceptance](toapis-live-20261024/README.md), which includes paid generation, eight directions, frame extraction and the actual downloaded sprite sheet. No paid e2e scripts are run automatically.

## Quick reuse / 快速复用

1. Install a release containing these changes with `dsh plugin --profile web add dsh-game-material-master`, restart DSH and refresh the browser. If the follow-up is still under review, use the reviewed source checkout with `dsh plugin --profile web add link:/absolute/path/to/checkout`; do not assume npm already contains the new settings.
2. Settings → 游戏素材大师 / Game Material Master → Image backend: **ToAPIs**. Select the matching site below and enter your own API Key in the password field. Save; never paste keys into prompts, Issues or screenshots.
3. Image: `gpt-image-2-vip`, `1K`, `low`, background **transparent**. Native transparent PNGs can be downloaded unchanged with “下载原图”; keep chroma removal off for that original.
4. Enable **Use ToAPIs for video**. Choose `seedance-2-mini`, **4s / 480p / 1:1**, audio off. Transparent source PNGs are explicitly composited on white for the video's JPEG first frame. MP4 has no alpha: video-derived frames still need background segmentation.
5. In 八方向图生成, upload the source. Use 逐方向生图 for the eight reviewed native-alpha views, or 转圈截帧 for one turntable clip and manually review the eight pick positions. Keep fixed camera, full body and margins; use a pure white video background for this example.
6. Generate/review eight walking videos → extract **8 frames per video** at working edge **512** → cell **128×128**, pixel block **1**, segmentation tolerance **55**, green low/high **255/255**, despill **0**, erosion **0**, fit **0.94**, bottom padding **2**. These are this robot's white-background settings, not universal defaults.
7. Compose and download `1024×1024` PNG. Rows: **N, NE, E, SE, S, SW, W, NW**; columns: eight frames. Open stage⑤ to preview. Recompose locally when changing cleanup parameters; do not regenerate paid videos just to adjust cropping.

| Site / 站点 | Homepage / 官网 | Provider Base URL |
|---|---|---|
| 国内站 / China | https://toapis.cn/ | `https://toapis.cn/v1` |
| 国际站 / International | https://toapis.com/ | `https://toapis.com/v1` |

Use the intended site's account/key/model availability and pricing. This acceptance used **China only**; it does not prove international settlement, equal prices across sites, or key interchangeability. [API quickstart](https://docs.toapis.com/docs/cn/quickstart) · [Pricing API](https://docs.toapis.com/docs/cn/api-reference/account/pricing).

### Price reference — 2026-10-24 / 价格口径

| Model and exact conditions | Quote (this China test key) | Actual settlement observed |
|---|---|---|
| `gpt-image-2-vip`, low, 1K, transparent, one image | **$0.0019/request** | Nine completed image tasks did not return billing; **pending**, not zero |
| `seedance-2-mini`, 4s, 480p, no video input, audio off | **$1.88806/M total tokens** | Nine 1:1 clips: **$0.070116 each**, 640×640, actual duration **4.041667s**, about **$0.01735/s** for this sample |
| Initial 16:9 composition trial (replaced after cropping review) | Same token-pricing conditions | **$0.073358**, 864×496, actual **4.041667s** |

Ten video tasks settled at **$0.704402** total, including the rejected composition trial and the additional turntable clip. Nine image quotes sum to **$0.0171**, which is **not settled spend**. Video sample $/s is derived from real output duration, **not a fixed per-second tariff**. Model, specifications, site, account group and date matter; query your own account before deciding. No Seedance Global models were called.

Offline media checks: `node scripts/verify-toapis-alpha.mjs` (ffmpeg required). On Windows, set `GMM_TEST_PYTHON` to a Python executable and run `node scripts/verify-project-windows-lock.mjs` to reproduce a real temporary file-sharing lock; other environments explicitly skip that platform-specific check. No paid calls.
