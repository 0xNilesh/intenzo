import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

// Local HTTP servers for browser tests. The app and a "third party" use different hostnames
// (127.0.0.1 vs localhost), because cookies are scoped by host, not port: two ports on one host
// wouldn't be a real third party.

export interface LoggedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface TestServer {
  origin: string;
  requests: LoggedRequest[];
  close(): Promise<void>;
}

export type Handler = (req: LoggedRequest, res: ServerResponse) => void;

export async function startServer(
  hostname: "127.0.0.1" | "localhost",
  handler: Handler,
): Promise<TestServer> {
  const requests: LoggedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const logged = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body,
      };
      requests.push(logged);
      handler(logged, res);
    });
  });
  // Listen on every interface, so "localhost" works whether it resolves to IPv4 or IPv6.
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${hostname}:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function html(
  res: ServerResponse,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(200, { "content-type": "text/html", ...headers });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

/** A 1×1 transparent GIF. */
export function pixel(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "image/gif" });
  res.end(Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"));
}
