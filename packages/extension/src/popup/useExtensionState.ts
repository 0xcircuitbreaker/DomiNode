import { useState, useEffect, useCallback } from "preact/hooks";
import type { ExtensionState, MessageType, MessageResponse } from "../shared/types.js";
import { STORAGE_KEYS } from "../shared/constants.js";

interface UseExtensionStateReturn {
  state: ExtensionState | null;
  loading: boolean;
  error: string | null;
  sendMessage: (type: MessageType, payload?: unknown) => Promise<MessageResponse>;
}

export function useExtensionState(): UseExtensionStateReturn {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load initial state
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response: MessageResponse) => {
      if (chrome.runtime.lastError) {
        setError(chrome.runtime.lastError.message ?? "Failed to connect to background");
        setLoading(false);
        return;
      }
      if (response?.success && response.data) {
        setState(response.data as ExtensionState);
      }
      setLoading(false);
    });
  }, []);

  // Subscribe to storage changes for live updates (balance polls, badge changes)
  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "local") return;
      const stateChange = changes[STORAGE_KEYS.STATE];
      if (stateChange?.newValue) {
        setState(stateChange.newValue as ExtensionState);
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const sendMessage = useCallback(
    async (type: MessageType, payload?: unknown): Promise<MessageResponse> => {
      setError(null);
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, payload }, (response: MessageResponse) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message ?? "Message failed";
            setError(errMsg);
            resolve({ success: false, error: errMsg });
            return;
          }
          if (response?.success && response.data) {
            setState(response.data as ExtensionState);
          } else if (response?.error) {
            setError(response.error);
          }
          resolve(response);
        });
      });
    },
    [],
  );

  return { state, loading, error, sendMessage };
}
