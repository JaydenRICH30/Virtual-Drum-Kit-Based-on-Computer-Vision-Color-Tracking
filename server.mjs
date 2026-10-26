import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.argv[2] || 5500);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".task": "application/octet-stream",
  ".wasm": "application/wasm",
};

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const relativePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = resolve(root, `.${relativePath}`);
    const isInsideRoot = target === root || target.startsWith(`${root}${sep}`);

    if (!isInsideRoot || !existsSync(target) || statSync(target).isDirectory()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(target).toLowerCase()] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    createReadStream(target).pipe(response);
  } catch (error) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Bad request: ${error.message}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Virtual Drum Studio: http://127.0.0.1:${port}/`);
});

