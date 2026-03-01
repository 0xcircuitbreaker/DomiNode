/**
 * WebRTC Leak Prevention
 *
 * Overrides RTCPeerConnection to force relay-only ICE transport,
 * preventing local IP address disclosure through WebRTC.
 *
 * Uses Object.defineProperty with configurable:false
 * to prevent pages from restoring the original constructor.
 * Must run in "MAIN" world (Chrome MV3) to affect page context.
 */
(() => {
  if (typeof window === "undefined") return;

  const origRTCPeerConnection = window.RTCPeerConnection;
  if (!origRTCPeerConnection) return;

  const wrappedRTC = function (config?: RTCConfiguration) {
    const modifiedConfig: RTCConfiguration = {
      ...config,
      iceTransportPolicy: "relay" as RTCIceTransportPolicy,
    };
    return new origRTCPeerConnection(modifiedConfig);
  } as unknown as typeof RTCPeerConnection;

  // Preserve prototype chain but override constructor reference
  wrappedRTC.prototype = origRTCPeerConnection.prototype;
  Object.defineProperty(wrappedRTC.prototype, "constructor", {
    value: wrappedRTC,
    writable: false,
    configurable: false,
  });

  // Lock the override to prevent pages from restoring the original
  Object.defineProperty(window, "RTCPeerConnection", {
    value: wrappedRTC,
    writable: false,
    configurable: false,
  });

  // Also override webkitRTCPeerConnection if present (legacy Chromium)
  if ((window as Record<string, unknown>).webkitRTCPeerConnection) {
    Object.defineProperty(window, "webkitRTCPeerConnection", {
      value: wrappedRTC,
      writable: false,
      configurable: false,
    });
  }
})();
