Source: https://github.com/q1ngyang/rustdesk-api-kessoku/tree/edfdd5b07f04bac6c3cdf96036fe9cb69164fb8d/web-client

Pinned commit: edfdd5b07f04bac6c3cdf96036fe9cb69164fb8d

MIT source copied: bytes.ts, limits.ts, video.ts, wire.ts, generated/kessoku_wire.ts. input.ts contains the keyboard helpers from client.ts. The GMSSH direct-SSH transport and UI are separate original code. No historical WebClient2/V2 assets are included.

Local modification: video.ts prefers software VP9 decoding. A live Windows session showed block artifacts with the default decoder preference; software decoding rendered the same Notepad window, text input, and maximize operation correctly on the tested Chromium host.
