"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { resolveExtensionId } from "../lib/guides/recorder";

/**
 * The Portal's transport to the extension: one long-lived port, reconnected on demand.
 *
 * One definition of this, not one per panel. The recorder, the selector probe and the
 * preview all need the same two facts about the connection — it can die at any moment
 * (worker eviction, extension reload), and reopening it is cheap — and the recorder is
 * where that was learned. A second copy would drift from it.
 *
 * What lives here is only the transport. What a reply MEANS belongs to whoever asked.
 */

export interface ExtensionReply {
  ok: boolean;
  type: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: ExtensionReply) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

interface Runtime {
  connect(extensionId: string, info: { name: string }): Port;
  sendMessage(extensionId: string, message: unknown, callback: (reply?: ExtensionReply) => void): void;
  lastError?: { message?: string };
}

export function chromeRuntime(): Runtime | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { chrome?: { runtime?: Runtime } }).chrome?.runtime ?? null;
}

export const PORT_NAME = "tg-recorder";

export function useExtension(opts: { onEvent(reply: ExtensionReply): void; onDisconnect?(): void }) {
  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<Port | null>(null);

  // Refs, not deps: the handlers close over component state that changes every render,
  // and rebuilding the port on every render would drop the connection continuously.
  const onEvent = useRef(opts.onEvent);
  const onDisconnect = useRef(opts.onDisconnect);
  onEvent.current = opts.onEvent;
  onDisconnect.current = opts.onDisconnect;

  // Reading localStorage and window.chrome has to wait for the client; on the server
  // there is neither, and guessing would make the first render disagree with the second.
  useEffect(() => {
    let override: string | null = null;
    try {
      override = window.localStorage.getItem("tg:extensionId");
    } catch {
      /* private mode; the configured id is the answer then */
    }
    setExtensionId(
      resolveExtensionId(process.env.NEXT_PUBLIC_EXTENSION_ID, override, process.env.NODE_ENV === "production"),
    );
  }, []);

  const disconnect = useCallback(() => {
    portRef.current?.disconnect();
    portRef.current = null;
    setLive(false);
  }, []);

  /** The port, connecting it if the last one died. */
  const ensurePort = useCallback((): Port | null => {
    if (portRef.current) return portRef.current;
    const api = chromeRuntime();
    if (!api || !extensionId) {
      setError("Không tìm thấy extension. Kiểm tra đã cài và đang bật.");
      return null;
    }
    try {
      const port = api.connect(extensionId, { name: PORT_NAME });
      port.onMessage.addListener((reply) => onEvent.current(reply));
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        setLive(false);
        onDisconnect.current?.();
      });
      portRef.current = port;
      setLive(true);
      return port;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [extensionId]);

  const send = useCallback(
    (message: unknown): boolean => {
      const port = ensurePort();
      if (!port) return false;
      port.postMessage(message);
      return true;
    },
    [ensurePort],
  );

  /** A one-shot request, for the paths that must work with no port at all. */
  const oneShot = useCallback(
    (message: unknown): Promise<ExtensionReply | null> =>
      new Promise((resolveReply) => {
        const api = chromeRuntime();
        if (!api || !extensionId) return resolveReply(null);
        api.sendMessage(extensionId, message, (reply) => {
          resolveReply(api.lastError || !reply ? null : reply);
        });
      }),
    [extensionId],
  );

  useEffect(() => () => disconnect(), [disconnect]);

  return { extensionId, live, error, setError, send, oneShot, disconnect };
}
