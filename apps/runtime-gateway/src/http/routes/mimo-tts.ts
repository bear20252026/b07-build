import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function readPreviewRequest(body: unknown): { text: string; voice?: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'text' && key !== 'voice')) return undefined;
  if (typeof candidate.text !== 'string' || (candidate.voice !== undefined && typeof candidate.voice !== 'string')) return undefined;
  return { text: candidate.text, voice: candidate.voice as string | undefined };
}

/**
 * Companion TTS 只能由本机操作者显式试听。它不接收对话历史、endpoint、API key、样本音频、
 * style prompt、工具或自动播放配置；音频只停留在当前 HTTP 响应，不进入任何 SQLite 账本。
 */
export const handleMimoTtsRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (url.pathname !== '/api/companion/tts/preview') return false;
  if (request.method !== 'POST') {
    sendJson(response, 404, { error: 'Companion TTS 仅支持显式 POST 试听请求' });
    return true;
  }
  if (request.headers['x-awo-operator-intent'] !== 'companion-tts-preview-v1') {
    sendJson(response, 403, { error: 'Companion TTS 必须由本地操作者显式确认；不会自动朗读' });
    return true;
  }
  try {
    const preview = readPreviewRequest(await readJsonBody(request));
    if (!preview) {
      sendJson(response, 400, { error: 'Companion TTS 只接受 text 与可选 voice；不得提交历史、密钥、端点、音频样本、工具或播放配置' });
      return true;
    }
    sendJson(response, 200, await dependencies.mimoTts.preview(preview));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : 'Companion TTS 试听请求无效' });
  }
  return true;
};
