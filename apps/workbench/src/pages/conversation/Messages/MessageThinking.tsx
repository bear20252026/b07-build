// apps/workbench/src/pages/conversation/Messages/MessageThinking.tsx
// 一个文件=一个作用：渲染模型思考过程（参照 AionUi MessageThinking；纯展示）
export function MessageThinking({ content }: { content: string }) {
  return (
    <details
      style={{
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: 8,
        marginBottom: 8,
        fontSize: 13,
      }}
    >
      <summary style={{ cursor: 'pointer', color: '#374151', fontWeight: 600 }}>🧠 思考过程</summary>
      <div style={{ color: '#6b7280', marginTop: 6, whiteSpace: 'pre-wrap' }}>{content}</div>
    </details>
  );
}
