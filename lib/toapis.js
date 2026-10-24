/** Optional ToAPIs asynchronous media transport. No automatic paid POST retries. */
import { createHash } from "node:crypto";
import { mkdir, readFile, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./jsonio.js";
import { dataRoot } from "./config.js";
export function toapisRoot(base) {
    const url = new URL(base.trim());
    if (url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(url.protocol === "https:" ||
            (url.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
        throw new Error("ToAPIs: use HTTPS (HTTP is only supported for a local proxy)");
    if (!/^\/(?:v1\/?)?$/.test(url.pathname))
        throw new Error("ToAPIs: Base URL must be an origin or end in /v1");
    return url.origin + "/v1";
}
export function assertToapisModel(model) {
    const id = model.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!id || (id.includes("seedance") && id.includes("global")))
        throw new Error("ToAPIs: empty model or disabled Seedance Global model");
}
export function assertToapisReady(config) {
    toapisRoot(config.toapisBaseUrl);
    if (!config.toapisApiKey.trim())
        throw new Error("ToAPIs: configure the API Key in settings");
}
function context(config, signal) {
    const timeout = AbortSignal.timeout(config.toapisTimeoutMs);
    return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
async function api(config, path, signal, body) {
    const multipart = body instanceof FormData;
    const response = await fetch(toapisRoot(config.toapisBaseUrl) + "/" + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal,
        headers: {
            Authorization: `Bearer ${config.toapisApiKey.trim()}`,
            ...(multipart || body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    if (!response.ok)
        throw new Error(`ToAPIs ${path.split("/")[0]}: HTTP ${response.status}`);
    return response.json();
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
const terminal = (state) => ["completed", "failed", "cancelled", "expired"].includes(state);
/** A persistent guard closes the gap between paid submission and the host storing taskId. */
async function submit(config, kind, body, signal, identity = body) {
    const dir = join(dataRoot(), "toapis-receipts");
    await mkdir(dir, { recursive: true });
    const root = toapisRoot(config.toapisBaseUrl);
    const file = join(dir, digest(JSON.stringify([root, digest(config.toapisApiKey), kind, identity])) + ".json");
    const previous = await readJson(file);
    if (previous?.delivered === true)
        await unlink(file);
    else if (previous) {
        if (!previous.id)
            throw new Error(`ToAPIs: previous submission uncertain; reconcile receipt ${file} before resubmitting`);
        const old = await api(config, `${kind}/generations/${encodeURIComponent(previous.id)}`, signal);
        if (!terminal(old.status))
            return old;
        // Recover completed output after restart/cancellation before allowing an explicit regeneration.
        if (old.status === "completed")
            return old;
        throw new Error(`ToAPIs: previous task ${previous.id} is ${old.status}; reconcile receipt ${file} before an explicit regeneration`);
    }
    const handle = await open(file, "wx");
    await handle.writeFile(JSON.stringify({ state: "submitting", kind, createdAt: Date.now() }));
    await handle.close();
    try {
        const task = await api(config, kind + "/generations", signal, body);
        if (typeof task.id !== "string" || !task.id.trim())
            throw new Error("ToAPIs: no task ID; do not repeat the paid submission");
        await writeJsonAtomic(file, {
            id: task.id,
            kind,
            state: task.status,
            createdAt: Date.now(),
        });
        return task;
    }
    catch (error) {
        throw new Error(`ToAPIs submission may have been accepted; do not retry automatically. Reconcile ${file}. ${error instanceof Error ? error.message : "Request failed"}`);
    }
}
async function updateReceipt(kind, field, value, patch) {
    const dir = join(dataRoot(), "toapis-receipts");
    let files;
    try {
        files = await readdir(dir);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    for (const name of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(name))
            continue;
        const file = join(dir, name), record = await readJson(file);
        if (record?.kind === kind && record[field] === value)
            await writeJsonAtomic(file, { ...record, ...patch });
    }
}
function outputUrl(task) {
    const url = task?.result?.data?.[0]?.url;
    return typeof url === "string" && url ? url : undefined;
}
async function reference(config, image, signal) {
    if (/^https:\/\//i.test(image))
        return image;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(image);
    if (!match)
        throw new Error("ToAPIs: reference must be an HTTPS image or PNG/JPEG/WebP data URI");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 20 * 1024 * 1024)
        throw new Error("ToAPIs: reference image exceeds 20 MiB or is empty");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: match[1] }), "reference." + match[1].split("/")[1]);
    const result = await api(config, "uploads/images", signal, form);
    if (typeof result?.data?.url !== "string" ||
        !result.data.url.startsWith("https://"))
        throw new Error("ToAPIs: upload did not return an HTTPS image URL");
    return result.data.url;
}
export async function downloadToapis(config, input, kind, signal = context(config)) {
    let url = new URL(input);
    const local = new URL(toapisRoot(config.toapisBaseUrl));
    for (let attempt = 0; attempt < 4; attempt++) {
        const sameLocal = local.protocol === "http:" && url.origin === local.origin;
        if (url.username ||
            url.password ||
            (!sameLocal &&
                (url.protocol !== "https:" ||
                    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname))))
            throw new Error("ToAPIs: unsafe output URL");
        // No bearer header, even when a CDN redirects. Validate every redirect target.
        const response = await fetch(url, { signal, redirect: "manual" });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location)
                throw new Error("ToAPIs: output redirect has no target");
            url = new URL(location, url);
            continue;
        }
        if (!response.ok || !response.body)
            throw new Error(`ToAPIs output: HTTP ${response.status}`);
        const limit = (kind === "image" ? 32 : 100) * 1024 * 1024;
        const reader = response.body.getReader();
        let total = 0;
        const chunks = [];
        try {
            while (true) {
                const next = await reader.read();
                if (next.done)
                    break;
                total += next.value.length;
                if (total > limit)
                    throw new Error("ToAPIs: output exceeds size limit");
                chunks.push(next.value);
            }
        }
        finally {
            await reader.cancel();
        }
        const bytes = Buffer.concat(chunks);
        if (kind === "image"
            ? imageExt(bytes) === undefined
            : !(bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp"))
            throw new Error("ToAPIs: result is not a supported image/MP4 file");
        if (kind === "video")
            await updateReceipt("videos", "outputHash", digest(input), {
                delivered: true,
            });
        return bytes;
    }
    throw new Error("ToAPIs: too many output redirects");
}
function imageExt(bytes) {
    if (bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return "png";
    if (bytes.length >= 3 &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255)
        return "jpg";
    if (bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP")
        return "webp";
}
function imageSize(input) {
    const pixels = /^(\d+)[x×](\d+)$/i.exec(input.trim());
    if (pixels) {
        const w = Number(pixels[1]), h = Number(pixels[2]);
        if (!(w > 0 && h > 0))
            throw new Error("ToAPIs: invalid image dimensions");
        const gcd = (a, b) => (b ? gcd(b, a % b) : a);
        const divisor = gcd(w, h);
        return {
            size: `${w / divisor}:${h / divisor}`,
            resolution: Math.max(w, h) > 2048 ? "4K" : Math.max(w, h) > 1024 ? "2K" : "1K",
        };
    }
    if (/^[124]k$/i.test(input.trim()))
        return { size: "1:1", resolution: input.toUpperCase() };
    throw new Error("ToAPIs: use width x height or 1K/2K/4K for image size");
}
export async function generateToapisImage(config, request, signal) {
    assertToapisReady(config);
    const model = request.model?.trim() || config.toapisImageModel;
    assertToapisModel(model);
    if (!request.prompt.trim())
        throw new Error("ToAPIs: empty prompt");
    if (config.toapisImageBackground !== "auto" && !/^gpt-image-/i.test(model))
        throw new Error("ToAPIs: explicit background is only supported for GPT Image models; choose auto for other models");
    const combined = context({ ...config, toapisTimeoutMs: request.timeoutMs ?? config.toapisTimeoutMs }, signal);
    const references = [];
    for (const image of request.images)
        references.push(await reference(config, image, combined));
    const body = {
        model,
        prompt: request.prompt,
        ...imageSize(request.size || config.toapisImageSize),
        n: 1,
    };
    if (config.toapisImageQuality.trim())
        body.quality = config.toapisImageQuality.trim();
    if (config.toapisImageBackground !== "auto")
        body.background = config.toapisImageBackground;
    if (references.length)
        body.reference_images = references;
    let task = await submit(config, "images", body, combined, {
        ...body,
        reference_images: request.images,
    });
    while (!terminal(task.status)) {
        task = await api(config, "images/generations/" + encodeURIComponent(task.id), combined);
        if (!terminal(task.status))
            await new Promise((resolve, reject) => {
                const abort = () => {
                    clearTimeout(timer);
                    reject(new Error("ToAPIs: image polling cancelled/timed out; resume from receipt"));
                };
                const timer = setTimeout(() => {
                    combined.removeEventListener("abort", abort);
                    resolve();
                }, 5000);
                if (combined.aborted)
                    abort();
                else
                    combined.addEventListener("abort", abort, { once: true });
            });
    }
    if (task.status !== "completed")
        throw new Error(`ToAPIs image task ${task.id}: ${task.status}`);
    const url = outputUrl(task);
    if (!url)
        throw new Error("ToAPIs: completed image task has no output URL");
    const bytes = await downloadToapis(config, url, "image", combined);
    await updateReceipt("images", "id", task.id, { delivered: true });
    return {
        bytes,
        ext: imageExt(bytes),
        remoteUrl: url,
        usage: { taskId: task.id, billing: task.billing, usage: task.usage },
    };
}
export async function submitToapisVideo(config, request) {
    assertToapisReady(config);
    assertToapisModel(config.toapisVideoModel);
    // Initial support is deliberately first-frame-only; unsupported references never trigger a paid request.
    if (request.lastFrameImage ||
        request.referenceImages?.length ||
        request.referenceVideos?.length)
        throw new Error("ToAPIs: this adapter currently supports only text or one first-frame image, not last-frame/multimodal inputs");
    const signal = context(config);
    const body = {
        model: config.toapisVideoModel,
        prompt: request.prompt,
        duration: config.toapisVideoDuration,
        resolution: config.toapisVideoResolution,
        aspect_ratio: config.toapisVideoAspectRatio,
        generate_audio: false,
        output_format: "mp4",
    };
    if (request.firstFrameImage)
        body.image_with_roles = [
            {
                url: await reference(config, request.firstFrameImage, signal),
                role: "first_frame",
            },
        ];
    return (await submit(config, "videos", body, signal, {
        ...body,
        image_with_roles: undefined,
        firstFrame: request.firstFrameImage,
    })).id;
}
export async function queryToapisVideo(config, taskId) {
    assertToapisReady(config);
    const task = await api(config, "videos/generations/" + encodeURIComponent(taskId), context(config));
    if (task.status === "completed") {
        const url = outputUrl(task);
        if (!url)
            throw new Error("ToAPIs: completed video task has no output URL");
        await updateReceipt("videos", "id", taskId, { outputHash: digest(url) });
        return { status: "succeeded", remoteStatus: task.status, url };
    }
    if (["failed", "cancelled", "expired"].includes(task.status))
        return {
            status: "failed",
            remoteStatus: task.status,
            error: `ToAPIs task ${taskId}: ${task.status}`,
        };
    return {
        status: task.status === "pending" || task.status === "queued"
            ? "pending"
            : "running",
        remoteStatus: task.status || "unknown",
    };
}
