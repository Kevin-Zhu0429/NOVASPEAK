async function postPresenceAction(apiBase, action, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBase}/api/presence/members/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("服务器返回了无效响应");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "在线成员操作失败");
  return data;
}

export function moveOnlineMember(apiBase, targetPresenceId, targetChannelId, fetchImpl) {
  return postPresenceAction(apiBase, "move", { targetPresenceId, targetChannelId }, fetchImpl);
}

export function kickOnlineMember(apiBase, targetPresenceId, fetchImpl) {
  return postPresenceAction(apiBase, "kick", { targetPresenceId }, fetchImpl);
}
