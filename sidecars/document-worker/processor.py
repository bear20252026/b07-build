# sidecars/document-worker/processor.py
# 一个文件=一个作用：纯文档处理（输入→结构化输出）。不开网络、不含鉴权、不建路由。
import hashlib
from typing import Any


def _simulate_extract(input_ref: str) -> str:
    """占位实现：实际接入 pdfplumber / python-docx / mammoth 时只替换本函数。

    保持边界：processor 不 import fastapi，不读环境变量，不碰 token。
    """
    return f"[extracted-text-placeholder] {input_ref}"


def process_document(input_ref: str, mime_hint: str = "") -> dict[str, Any]:
    """文档 → 结构化文本 + 元数据。唯一职责：解析并返回结果。

    产出可审计引用（ref），大文本不进 HTTP 事件体（与 protocol 的 outputRef 约定一致）。
    """
    text = _simulate_extract(input_ref)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    return {
        "ref": f"doc://{digest}",
        "input": input_ref,
        "mime": mime_hint or "detected",
        "text": text[:1_000_000],
        "bytes": len(text.encode("utf-8")),
    }
