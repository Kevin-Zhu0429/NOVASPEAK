import { useEffect, useRef, useState } from "react";
import { FileText, Image, Paperclip, X } from "lucide-react";
import {
  CHAT_ATTACHMENT_ACCEPT,
  addChatAttachmentFiles,
  chatImageFilesFromClipboard,
  formatChatAttachmentSize,
} from "../../utils/chat-attachments";
import { shouldRestoreChatComposerFocus } from "../../utils/chat-scroll";

export default function ChatComposer({ value, onChange, onSend, disabled = false, sending = false }) {
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);
  const previousSendingRef = useRef(sending);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const previousSending = previousSendingRef.current;
    previousSendingRef.current = sending;
    if (shouldRestoreChatComposerFocus({ previousSending, sending, disabled })) {
      messageInputRef.current?.focus();
    }
  }, [disabled, sending]);

  const addFiles = (incoming) => {
    const result = addChatAttachmentFiles(files, incoming);
    setFiles(result.files);
    setError(result.error);
  };

  const send = async () => {
    if (disabled || sending || (!value.trim() && files.length === 0)) return;
    const result = await onSend({ text: value, files });
    const sentFiles = Math.max(0, Number(result?.sentFiles) || 0);
    if (sentFiles) setFiles((current) => current.slice(sentFiles));
  };

  const handlePaste = (event) => {
    const images = chatImageFilesFromClipboard(event.clipboardData?.items);
    if (!images.length) return;
    event.preventDefault();
    addFiles(images);
  };

  return (
    <div className="chat-composer">
      {files.length > 0 && (
        <div className="chat-pending-attachments" aria-label="待发送文件">
          {files.map((file, index) => (
            <div className="chat-pending-attachment" key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
              {String(file.type || "").startsWith("image/") ? <Image size={18} /> : <FileText size={18} />}
              <span><strong>{file.name}</strong><small>{formatChatAttachmentSize(file.size)}</small></span>
              <button type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={sending} aria-label={`移除 ${file.name}`}><X size={15} /></button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="chat-composer-error">{error}</div>}
      <div className="message-input-row">
        <input ref={fileInputRef} type="file" className="chat-file-input" accept={CHAT_ATTACHMENT_ACCEPT} multiple onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} disabled={disabled || sending} />
        <button type="button" className="chat-attach-button" onClick={() => fileInputRef.current?.click()} disabled={disabled || sending} title="发送图片或文件" aria-label="选择图片或文件"><Paperclip size={19} /></button>
        <textarea ref={messageInputRef} value={value} maxLength={2000} rows={1} onChange={(event) => onChange(event.target.value)} onPaste={handlePaste} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} placeholder="输入消息，或直接粘贴图片" disabled={disabled || sending} />
        <button type="button" className="chat-send-button" onClick={() => void send()} disabled={disabled || sending || (!value.trim() && files.length === 0)}>{sending ? "发送中" : "发送"}</button>
      </div>
    </div>
  );
}
