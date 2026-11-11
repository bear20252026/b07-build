// 模型是否接受图片输入 —— 不支持时把图片换成文本。
//
// ## 为什么需要它
//
// 打通工具结果的图片通道之后，图片会真的被发到 provider。但**并非所有模型都收**：
// 上游会直接 404，整个回合失败。b07 原本靠 `streamErrorText` 里的两条 404 文案
// **事后**告诉用户"这个模型不吃图片"——那是补救，不是预防。
//
// ZCode 的做法是预防式的：`ModelInputFormat` 声明 `supportsImage`，
// `getUnsupportedModelInputMediaKind(block, inputFormat)` 判出"这条媒体不被支持"，
// `createUnsupportedModelInputMediaText` 产出**文本替代**。本模块采用同一形状。
//
// ## 与 ZCode 的差别（必须说清，否则会变成编造事实）
//
// ZCode 有一份真实模型目录，能对每个模型回答"支不支持视觉"。**b07 没有这份元数据**
// （`official-provider-presets.ts` 只有模型 id 列表）。所以这里只编码
// **b07 自己已经断言过的那一条事实** ——
// MiMo 的 `mimo-v2.5-pro` 是文本/推理模型，不接受图片输入
// （依据：`direct_provider.rs` 的 `http_error_message` 专门为它分了一路，
// `streamErrorText` 也专门为它写了一句可读原因）。
//
// 其余模型一律按"支持"处理，与现状一致：用户附件一直就是直接带图片发出的，
// 靠 404 兜底。凭空编一张能力表等于把猜测写成事实，比"发出去让上游拒绝"更糟。

/** 图片被降级为文本时用的稳定标记（便于日志与测试归因）。 */
export const IMAGE_INPUT_DOWNGRADED_CODE = 'model-image-input-unsupported' as const;

/**
 * 已知**不接受**图片输入的模型：`providerId` → 模型 id 列表。
 *
 * 这张表刻意保持最小：只放有据可查的条目。加条目时必须在注释里写明依据，
 * 否则它就成了一个没人知道来源的断言。
 */
const KNOWN_TEXT_ONLY_MODELS: Readonly<Record<string, readonly string[]>> = {
  // 依据：`direct_provider.rs::http_error_message` 对 MiMo 会话 + mimo-v2.5-pro
  // 单独返回 `provider-http-404-image-mimo-v25-pro`，且 `streamErrorText` 明写
  // "mimo-v2.5-pro 是文本/推理模型，不支持图片输入"。同系列的 mimo-v2.5 支持。
  mimo: ['mimo-v2.5-pro'],
  'mimo-token-plan-cn': ['mimo-v2.5-pro'],
};

/**
 * 该模型是否接受图片输入。
 *
 * 判不了的一律按**接受**处理：这与现状一致（现状是直接发，靠 404 兜底），
 * 而按"不接受"处理会让所有支持视觉的模型都白白丢掉图片。
 */
export function modelAcceptsImageInput(providerId: string, model: string | undefined): boolean {
  if (!model) return true;
  const known = KNOWN_TEXT_ONLY_MODELS[providerId];
  if (!known) return true;
  return !known.some((candidate) => candidate.toLowerCase() === model.toLowerCase());
}

/**
 * 图片需要被换成文本时返回替代文本；模型接受图片时返回 `undefined`。
 *
 * 与 ZCode 的 `unsupportedInputMediaText` 同形：调用方据此决定"发图片"还是"发文本"。
 */
export function unsupportedImageInputText(
  providerId: string,
  model: string | undefined,
  description: string,
): string | undefined {
  if (modelAcceptsImageInput(providerId, model)) return undefined;
  return (
    `${description}\n` +
    `（当前模型 ${model ?? '（未指定）'} 不接受图片输入，已改为文本说明。` +
    `要看图请在"已连接模型"里换成支持视觉的模型后重试；图片没有被本地丢弃。）`
  );
}
