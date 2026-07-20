async function parseJson(response, fallback) {
  const contentType = response?.headers?.get?.("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error(fallback);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error || fallback);
    if (typeof data?.code === "string") error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function channelPath(channelId) {
  if (typeof channelId !== "string" || !channelId.trim()) {
    throw new Error("频道无效");
  }
  return `/api/channels/${encodeURIComponent(channelId.trim())}/messages`;
}

export async function getChannelMessages(apiBase, channelId, { signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${apiBase}${channelPath(channelId)}`, {
    method: "GET",
    credentials: "include",
    signal,
  });
  return parseJson(response, "加载聊天记录失败");
}

export async function saveChannelMessage(apiBase, channelId, text, { fetchImpl = fetch } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("消息不能为空");
  const response = await fetchImpl(`${apiBase}${channelPath(channelId)}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.trim() }),
  });
  return parseJson(response, "发送聊天消息失败");
}

export async function saveChannelAttachment(apiBase, channelId, file, { fetchImpl = fetch } = {}) {
  if (!file || typeof file.name !== "string" || typeof file.size !== "number") {
    throw new Error("文件无效");
  }
  const response = await fetchImpl(`${apiBase}${channelPath(channelId)}/attachments`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Nova-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  return parseJson(response, "发送文件失败");
}
