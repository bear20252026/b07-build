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

export function latestScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

export function shouldScrollToLatest(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return Math.abs(scrollTop - latestScrollTop(scrollHeight, clientHeight)) > 1;
}

export function useChatAutoScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  contentVersion: string,
  conversationId?: string,
  threshold = 160,
): { onScroll(event: React.UIEvent<HTMLElement>): void; jumpToLatest(): void; showJumpToLatest: boolean } {
  const nearBottomRef = useRef(true);
  const jumpVisibleRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const setJumpVisible = useCallback((next: boolean): void => {
    if (jumpVisibleRef.current === next) return;
    jumpVisibleRef.current = next;
    setShowJumpToLatest(next);
  }, []);

  const onScroll = useCallback((event: React.UIEvent<HTMLElement>): void => {
    const element = event.currentTarget;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
    nearBottomRef.current = nearBottom;
    setJumpVisible(!nearBottom);
  }, [setJumpVisible, threshold]);

  const jumpToLatest = useCallback((): void => {
    const element = containerRef.current;
    if (!element) return;
    nearBottomRef.current = true;
    setJumpVisible(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
  }, [containerRef, setJumpVisible]);

  useEffect(() => {
    nearBottomRef.current = true;
    setJumpVisible(false);
  }, [conversationId, setJumpVisible]);

  useEffect(() => {
    if (!nearBottomRef.current) return;
    const element = containerRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      if (!nearBottomRef.current || !shouldScrollToLatest(element.scrollTop, element.scrollHeight, element.clientHeight)) return;
      element.scrollTo({ top: latestScrollTop(element.scrollHeight, element.clientHeight), behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [containerRef, contentVersion]);

  return { onScroll, jumpToLatest, showJumpToLatest };
}
