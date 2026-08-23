export const MESSAGE_RENDER_WINDOW = 60;

export function messageWindowStart(messageCount: number, currentStart?: number): number {
  const newestStart = Math.max(0, messageCount - MESSAGE_RENDER_WINDOW);
  if (currentStart === undefined || messageCount <= MESSAGE_RENDER_WINDOW) return newestStart;
  return Math.min(currentStart, newestStart);
}
