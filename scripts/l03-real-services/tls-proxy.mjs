// TLS edge for the L03 real-service rehearsal network.
// The document storage client only ever speaks HTTPS to a pinned origin on
// port 443, so this minimal terminator sits in front of the plain-HTTP
// supabase/storage-api container. It streams both directions unchanged; the
// rehearsal CA that signed its certificate is provided to the client through
// NOVA_SUPABASE_STORAGE_TLS_CA_FILE, exercising the same TLS-verification path
// production uses.
import { createServer } from "node:https";
import { request } from "node:http";
import { readFileSync } from "node:fs";

const upstream = new URL(process.env.UPSTREAM_ORIGIN ?? "");
if (upstream.protocol !== "http:" || !upstream.hostname) {
  throw new Error("UPSTREAM_ORIGIN must be an http://host[:port] URL");
}
const certDir = process.env.CERT_DIR ?? "/rehearsal-certs";

createServer(
  {
    key: readFileSync(`${certDir}/server.key`),
    cert: readFileSync(`${certDir}/server.crt`),
    minVersion: "TLSv1.2",
  },
  (incoming, outgoing) => {
    // Emulate the Supabase gateway: the public API prefix is a gateway
    // convention; storage-api itself serves routes without it.
    const url = incoming.url ?? "/";
    const path = url.startsWith("/storage/v1/") ? url.slice("/storage/v1".length) : url;
    const proxy = request(
      {
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path,
        method: incoming.method,
        headers: { ...incoming.headers, host: upstream.host },
        timeout: 120_000,
      },
      (upstreamRes) => {
        outgoing.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(outgoing);
      },
    );
    proxy.on("timeout", () => proxy.destroy(new Error("upstream timeout")));
    proxy.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "text/plain" });
      }
      outgoing.end("upstream_error");
    });
    incoming.pipe(proxy);
  },
).listen(443, "0.0.0.0", () => {
  console.log(`[l03-tls] :443 -> ${upstream.origin}`);
});
