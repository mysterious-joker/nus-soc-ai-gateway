// Endpoint support is connector-specific. A catalog entry alone is not proof of access.
const ROUTES = {
  llm: ["/v1/chat/completions", "/v1/responses"],
  embedding: ["/v1/embeddings"],
  "speech-to-text": ["/v1/audio/transcriptions"],
  "image-generation": ["/v1/images/generations", "/v1/images/edits"],
  "realtime-audio": ["/v1/audio/speech", "/v1/realtime"],
};
const ENDPOINTS = [...new Set(Object.values(ROUTES).flat())];
function endpoints(model) {
  if (model.provider === "gemini")
    return model.type === "llm" ? ROUTES.llm : [];
  if (
    model.provider === "chatgpt" &&
    !["llm", "image-generation", "realtime-audio"].includes(model.type)
  )
    return [];
  return ROUTES[model.type] || [];
}
module.exports = { endpoints, ENDPOINTS };
