/**
 * Adapted interaction pattern from AionUi's
 * packages/desktop/src/renderer/hooks/chat/useAutoScroll.ts.
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * AI Work OS changes: keeps state local to this virtualized timeline, uses an
 * immediate rAF update for streaming performance, and exposes a scroll handler
 * instead of accepting an opaque content string.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useChatAutoScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  contentVersion: string,
  conversationId?: string,
  threshold = 160,
): { onScroll(event: React.UIEvent<HTMLElement>): void; jumpToLatest(): void; showJumpToLatest: boolean } {
  const nearBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const onScroll = useCallback((event: React.UIEvent<HTMLElement>): void => {
    const element = event.currentTarget;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
    nearBottomRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
  }, [threshold]);

  const jumpToLatest = useCallback((): void => {
    const element = containerRef.current;
    if (!element) return;
    nearBottomRef.current = true;
    setShowJumpToLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
  }, [containerRef]);

  useEffect(() => {
    nearBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [conversationId]);

  useEffect(() => {
    if (!nearBottomRef.current) return;
    const element = containerRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      if (nearBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [containerRef, contentVersion]);

  return { onScroll, jumpToLatest, showJumpToLatest };
}
