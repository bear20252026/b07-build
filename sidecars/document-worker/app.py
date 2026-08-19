# sidecars/document-worker/app.py
# 一个文件=一个作用：FastAPI 路由 + token 鉴权中间件（OpenWorker require_sidecar_token 式）。
# 不开业务处理：具体解析一律委托给 processor（另一作用，独立文件）。
import os
import secrets
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from processor import process_document  # port: 只依赖文档处理接口

app = FastAPI(title="awo-document-worker", version="0.1.0")

SIDECAR_TOKEN = os.environ.get("AWO_SIDECAR_TOKEN", "")


def _token_ok(provided: Optional[str]) -> bool:
    """常量时间比较（OpenWorker secrets.compare_digest 同款），防时序侧信道。"""
    if not SIDECAR_TOKEN or not provided:
        return False
    return secrets.compare_digest(provided, SIDECAR_TOKEN)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


@app.post("/v1/doc/parse")
async def parse_document(
    body: dict,
    x_awo_token: Optional[str] = Header(default=None),
) -> JSONResponse:
    if not _token_ok(x_awo_token):
        raise HTTPException(status_code=401, detail="bad token")
    input_ref = body.get("inputRef", "")
    mime = body.get("mime", "")
    return JSONResponse(process_document(input_ref, mime))


# 127.0.0.1-only 提示：启动时绑定 127.0.0.1（见 __main__），token 仅为降低误连风险
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("AWO_SIDECAR_PORT", "8789")))
