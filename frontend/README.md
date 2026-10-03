# Helm Glass frontend

The Angular application follows the canonical [architecture](../Docs/architecture.html) and [design](../Docs/Helm-Glass-v8.html).

Run the authenticated application using the repository [deployment instructions](../README.md). The production build is served by the internal Nginx gateway.

From this directory: `npm ci`, `npm run build`, `npm test -- --watch=false`.

`tools/patch-gst.mjs` applies the version-checked socket factory injection to gstwebrtc-api. The upstream library owns SDP/ICE negotiation; Helm authenticates the transport before forwarding upstream messages.