import { Download, FileText } from "lucide-react";
import { formatChatAttachmentSize } from "../../utils/chat-attachments";

export default function ChatMessageAttachment({ attachment }) {
  if (!attachment) return null;
  if (attachment.kind === "image") {
    return (
      <a className="chat-attachment chat-image-attachment" href={attachment.url} target="_blank" rel="noreferrer" title="打开原图">
        <img src={attachment.url} alt={attachment.name} loading="lazy" draggable={false} />
        <span><strong>{attachment.name}</strong><small>{formatChatAttachmentSize(attachment.size)}</small></span>
      </a>
    );
  }
  return (
    <a className="chat-attachment chat-file-attachment" href={attachment.url} download={attachment.name}>
      <FileText size={28} aria-hidden="true" />
      <span><strong>{attachment.name}</strong><small>{formatChatAttachmentSize(attachment.size)}</small></span>
      <Download size={17} aria-hidden="true" />
    </a>
  );
}
