import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Just enough of a zip reader for WhatsApp's "Export chat" archives: the central directory, then each
 * entry stored or deflated. No dependency. Refuses anything odd (encryption, zip64, an entry bigger
 * than MAX_ENTRY) rather than guess.
 */

const MAX_ENTRY = 50 * 1024 * 1024;

export type ZipEntry = { name: string; data: () => Buffer };

export function readZip(buf: Buffer): ZipEntry[] {
  // End of central directory: the last 0x06054b50 within the trailing 64 KiB comment window.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error("zip64 isn't supported");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("broken zip directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    out.push({
      name,
      data: () => {
        if (flags & 1) throw new Error(`${name} is encrypted`);
        if (usize > MAX_ENTRY) throw new Error(`${name} is too big`);
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("broken zip entry");
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
        throw new Error(`${name}: compression ${method} isn't supported`);
      },
    });
  }
  return out;
}

/** The chat text in a WhatsApp export: _chat.txt (iPhone) or "WhatsApp Chat with ….txt" (Android). */
export function chatTextFromZip(buf: Buffer): string {
  const entries = readZip(buf).filter((e) => /\.txt$/i.test(e.name) && !e.name.startsWith("__MACOSX/"));
  const pick = entries.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) ?? entries.find((e) => /whatsapp chat/i.test(e.name)) ?? entries[0];
  if (!pick) throw new Error("no chat text in the export");
  return pick.data().toString("utf8");
}

/** A zip of the given files (deflated), for tests and for handing proposals over as one file. */
export function writeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const dirs: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(off, 42);
    locals.push(lh, name, comp);
    dirs.push(cd, name);
    off += 30 + name.length + comp.length;
  }
  const dir = Buffer.concat(dirs);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, dir, end]);
}
