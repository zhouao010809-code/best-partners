import { useEffect, useRef, useState } from 'react';
import type { AssistantConversation } from '../../../shared/api/assistant.js';
import type { Attachment, AttachmentSelection } from '../../../shared/api/attachments.js';

export function continuationExcerpt(conversation: AssistantConversation): string {
  const messages = conversation.messages.filter(item => item.text.trim()).slice(-8);
  const excerpts = messages.map(item => `${item.role === 'user' ? '我的问题' : '已有回答'}：\n${item.text.slice(0, 1300)}`).join('\n\n');
  const sources = [...new Map(messages.flatMap(item => item.sources).map(source => [source.path, source])).values()];
  return `继续讨论：${conversation.title}\n\n以下是上一段对话的摘录，请基于这些信息继续。\n\n${excerpts}${sources.length ? `\n\n曾引用的资料（需要时重新核对）：\n${sources.map(source => `- ${source.title}：${source.path}`).join('\n')}` : ''}\n\n接下来我想：`.slice(0, 16000);
}
export function AssistantContinuation({ conversation, attachments, records, onCancel, onContinue }: { conversation: AssistantConversation; attachments: AttachmentSelection[]; records: Attachment[]; onCancel: () => void; onContinue: (text: string, selected: AttachmentSelection[]) => Promise<void> }) {
  const [text, setText] = useState(() => continuationExcerpt(conversation));
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const node = dialog.current; if (node) { if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', ''); } editor.current?.focus(); }, []);
  return <dialog ref={dialog} className="assistant-continuation" aria-label="带摘要继续" onCancel={event => { event.preventDefault(); onCancel(); }}><h3>带摘要继续</h3><p>已摘录最近的讨论和资料出处。先检查、补充结论，再放入新对话；不会自动发送。</p><textarea ref={editor} aria-label="新对话摘要草稿" value={text} maxLength={16000} onChange={event => setText(event.target.value)} />
    {attachments.length > 0 && <fieldset><legend>选择继续带入的文件</legend>{attachments.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(values => event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))} />{records.find(record => record.id === item.id)?.name ?? '已选附件'}</label>)}</fieldset>}
    <div><button type="button" disabled={pending} onClick={onCancel}>返回当前对话</button><button type="button" disabled={pending || !text.trim()} onClick={async () => { setPending(true); try { await onContinue(text, attachments.filter(item => selected.includes(item.id))); } finally { setPending(false); } }}>放入新对话草稿</button></div>
  </dialog>;
}
