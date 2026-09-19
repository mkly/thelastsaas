import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnvironment } from "../env";
import { htmlPage } from "../html";
import {
  getUpload,
  prepareUpload,
  writeUpload,
  completeUpload,
} from "../uploads";

export const uploadRouter = new Hono<AppEnvironment>();
uploadRouter.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  await next();
});
uploadRouter.onError((error, context) => {
  if (error instanceof HTTPException)
    return context.json(
      { status: "error", message: error.message },
      error.status,
    );
  throw error;
});

async function session(context: Context<AppEnvironment>) {
  const token = context.req.header("authorization")?.replace(/^Bearer /, "");
  if (!token) throw new HTTPException(404, { message: "Upload not found" });
  const upload = await getUpload(
    context.get("services"),
    context.req.param("id")!,
    { token },
  );
  return { upload, token };
}

uploadRouter.get("/:id/status", async (context) => {
  const { upload } = await session(context);
  const org = await context
    .get("services")
    .prisma.organization.findUniqueOrThrow({ where: { id: upload.orgId } });
  return context.json({
    upload_status: upload.status,
    organization: org.name,
    max_size: context.get("config").maxUploadSize,
    expires_at: upload.expiresAt.toISOString(),
  });
});
uploadRouter.post("/:id/prepare", async (context) => {
  const { upload, token } = await session(context);
  return context.json(
    await prepareUpload(
      context.get("services"),
      context.get("config"),
      upload,
      token,
      await context.req.json().catch(() => null),
    ),
  );
});
uploadRouter.put("/:id/content", async (context) => {
  const { upload } = await session(context);
  await writeUpload(context.get("services"), upload, context.req.raw.body);
  return context.body(null, 204);
});
uploadRouter.post("/:id/complete", async (context) => {
  const { upload } = await session(context);
  return context.json({
    status: "ok",
    file: await completeUpload(context.get("services"), upload),
  });
});
uploadRouter.get("/:id", (context) => {
  const nonce = randomBytes(16).toString("base64");
  const endpoint = context.get("config").s3Endpoint;
  const storageOrigin = endpoint ? new URL(endpoint).origin : "https:";
  context.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self' ${storageOrigin}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  return context.html(
    htmlPage(
      "Upload a file",
      `<style>#upload-form[hidden]{display:none!important}</style><div class="card">
    <p id="destination">Checking your upload link…</p>
    <form id="upload-form" hidden>
      <label for="file">Choose a file</label>
      <input id="file" name="file" type="file" required style="display:block;margin:1rem 0;max-width:100%">
      <p id="limit" class="muted"></p>
      <button id="submit" type="submit">Upload file</button>
    </form>
    <p id="status" role="status" aria-live="polite"></p>
  </div>
  <script nonce="${nonce}">
  (() => {
    const token = location.hash.slice(1);
    const base = location.pathname;
    const form = document.getElementById('upload-form');
    const picker = document.getElementById('file');
    const button = document.getElementById('submit');
    const status = document.getElementById('status');
    const destination = document.getElementById('destination');
    const headers = { Authorization: 'Bearer ' + token };
    let maxSize = 0, target, transferred = false;
    async function api(path, body) {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Upload could not be completed. Please try again.');
      return data;
    }
    async function start() {
      if (!token) throw new Error('This upload link is incomplete. Ask your assistant for a new link.');
      const info = await api('/status');
      destination.textContent = 'Upload to ' + info.organization;
      if (info.upload_status === 'complete') { status.textContent = 'This upload is already complete. You can return to your assistant.'; return; }
      if (info.upload_status !== 'pending') throw new Error('This link is already in use. Return to the original upload tab, or ask for a new link.');
      maxSize = info.max_size;
      document.getElementById('limit').textContent = 'Maximum file size: ' + Math.round(maxSize / 1024 / 1024 * 10) / 10 + ' MB. Link expires at ' + new Date(info.expires_at).toLocaleTimeString() + '.';
      form.hidden = false;
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = picker.files[0];
      if (!file) return;
      if (file.size > maxSize) { status.textContent = 'This file exceeds the upload size limit.'; return; }
      button.disabled = true;
      try {
        status.textContent = 'Uploading…';
        if (!target) target = await api('/prepare', { filename: file.name, size_bytes: file.size, mime_type: file.type || 'application/octet-stream' });
        picker.disabled = true;
        if (!transferred) {
          const sent = await fetch(target.upload_url, { method: 'PUT', headers: target.headers, body: file, redirect: 'error', credentials: 'omit' });
          if (!sent.ok) throw new Error('Upload failed. Retry before the link expires, or ask for a new link.');
          transferred = true;
        }
        status.textContent = 'Finishing upload…';
        const result = await api('/complete', {});
        form.hidden = true;
        status.textContent = result.file.filename + ' uploaded. You can return to your assistant.';
      } catch (error) {
        status.textContent = error.message || 'Upload failed. Please try again.';
        button.textContent = transferred ? 'Finish upload' : 'Retry upload';
      } finally { button.disabled = false; }
    });
    start().catch(error => { destination.textContent = 'Unable to upload'; status.textContent = error.message; });
  })();
  </script>`,
      { narrow: true },
    ),
  );
});
