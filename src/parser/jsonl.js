import fs from 'node:fs';
import readline from 'node:readline';

/** Reads a .jsonl line by line, skipping corrupt lines. */
export async function readJsonl(file, onObj) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    onObj(o);
  }
}

/** First n objects, to detect the format without reading the whole file. */
export async function readJsonlHead(file, n = 5) {
  const out = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* ignore */ }
      if (out.length >= n) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

/** The last `bytes` bytes of a file, as text. */
export async function readTail(file, bytes = 65536) {
  const { size } = await fs.promises.stat(file);
  const start = Math.max(0, size - bytes);
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, size));
    await fd.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fd.close();
  }
}
