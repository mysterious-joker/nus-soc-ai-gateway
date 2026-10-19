const { HttpError, readJson } = require("./security");
const MEDIA_LIMIT = 26 * 1024 * 1024;
async function readBody(req, endpoint) {
  const contentType = req.headers["content-type"] || "";
  const multipart = /^multipart\/form-data\s*;/i.test(contentType);
  if (!multipart) {
    if (endpoint === "/v1/audio/transcriptions")
      throw new HttpError(415, "Upload audio using multipart/form-data.");
    return {
      body: await readJson(
        req,
        endpoint === "/v1/images/edits" ? MEDIA_LIMIT : undefined,
      ),
    };
  }
  if (!["/v1/audio/transcriptions", "/v1/images/edits"].includes(endpoint))
    throw new HttpError(415, "This endpoint requires JSON.");
  if (Number(req.headers["content-length"]) > MEDIA_LIMIT)
    throw new HttpError(413, "Upload exceeds 26 MiB.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MEDIA_LIMIT) throw new HttpError(413, "Upload exceeds 26 MiB.");
    chunks.push(chunk);
  }
  let form;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new HttpError(400, "Invalid multipart upload.");
  }
  const body = Object.create(null),
    files = new Set();
  let parts = 0;
  for (const [name, value] of form) {
    if (++parts > 40 || name.length > 100)
      throw new HttpError(400, "Too many upload fields.");
    if (typeof value !== "string") {
      if (!value.size || !["file", "image", "image[]", "mask"].includes(name))
        throw new HttpError(400, "Unexpected or empty upload file.");
      files.add(name);
    } else {
      if (name in body || value.length > 128 * 1024)
        throw new HttpError(400, "Duplicate or oversized upload field.");
      body[name] = value;
    }
  }
  if (typeof body.model !== "string" || !body.model)
    throw new HttpError(400, "Specify a model in the upload.");
  if (
    endpoint === "/v1/audio/transcriptions" &&
    (form.getAll("file").length !== 1 || !files.has("file") || files.size !== 1)
  )
    throw new HttpError(
      400,
      "Upload exactly one audio file in the file field.",
    );
  if (
    endpoint === "/v1/images/edits" &&
    ((!files.has("image") && !files.has("image[]")) || files.has("file"))
  )
    throw new HttpError(
      400,
      "Upload an image using the image or image[] field.",
    );
  if (body.stream !== undefined) {
    if (!["true", "false"].includes(body.stream))
      throw new HttpError(400, "stream must be true or false.");
    body.stream = body.stream === "true";
  }
  return { body, form };
}
async function readResponse(response, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit)
      throw new HttpError(502, "Provider response exceeds the supported size.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
module.exports = { readBody, readResponse, MEDIA_LIMIT };
