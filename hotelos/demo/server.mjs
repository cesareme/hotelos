import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(root, "public");
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeLobbyImage() {
  const width = 960;
  const height = 420;
  const raw = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const idx = rowStart + 1 + x * 4;
      const wall = y < height * 0.56;
      const floorShade = Math.max(0, y - height * 0.55) / (height * 0.45);
      let r = wall ? 237 - y * 0.05 : 201 - floorShade * 28;
      let g = wall ? 241 - y * 0.04 : 205 - floorShade * 22;
      let b = wall ? 232 - y * 0.03 : 193 - floorShade * 16;

      const window = x > 590 && x < 880 && y > 54 && y < 218;
      const reception = x > 82 && x < 420 && y > 236 && y < 322;
      const planter = x > 720 && x < 830 && y > 255 && y < 348;
      const rug = x > 360 && x < 650 && y > 323 && y < 382;
      const light = (x - 475) ** 2 / 54000 + (y - 72) ** 2 / 2100 < 1;

      if (window) {
        r = 169;
        g = 207;
        b = 218;
      }
      if (reception) {
        r = 64;
        g = 83;
        b = 76;
      }
      if (planter) {
        r = y < 300 ? 54 : 182;
        g = y < 300 ? 111 : 121;
        b = y < 300 ? 82 : 76;
      }
      if (rug) {
        r = 186;
        g = 96;
        b = 84;
      }
      if (light) {
        r = Math.min(255, r + 22);
        g = Math.min(255, g + 21);
        b = Math.min(255, b + 8);
      }

      raw[idx] = Math.round(r);
      raw[idx + 1] = Math.round(g);
      raw[idx + 2] = Math.round(b);
      raw[idx + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function serveFile(urlPath) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath.replace(/\.\./g, "");
  const filePath = join(publicRoot, safePath);
  const data = await readFile(filePath);
  return {
    status: 200,
    headers: { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" },
    body: data
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/assets/lobby.png") {
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600"
      });
      response.end(makeLobbyImage());
      return;
    }

    const file = await serveFile(url.pathname);
    response.writeHead(file.status, file.headers);
    response.end(file.body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`HotelOS demo preview: http://${host}:${port}`);
});
