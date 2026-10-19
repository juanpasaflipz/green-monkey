import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** A small uncompressed ZIP writer for our fixed pass assets; no user-supplied archive paths. */
export function passArchive(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    if (!/^[A-Za-z0-9@_.-]+$/.test(name)) throw Error("invalid_pass_filename");
    const filename = Buffer.from(name),
      crc = crc32(data),
      local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, data);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const cd = Buffer.concat(directory),
    end = Buffer.alloc(22),
    count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
/** Detached CMS signature using system OpenSSL, with keys confined to a private temporary directory. */
export async function signAppleBundle(
  files: Record<string, Buffer>,
  certs: { cert: Buffer; key: Buffer; wwdr: Buffer; passphrase?: string },
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "gm-wallet-"));
  try {
    const manifest = Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(files).map(([name, data]) => [
            name,
            createHash("sha1").update(data).digest("hex"),
          ]),
        ),
      ),
    );
    const inputs = {
      "manifest.json": manifest,
      "cert.pem": certs.cert,
      "key.pem": certs.key,
      "wwdr.pem": certs.wwdr,
      phrase: Buffer.from((certs.passphrase ?? "") + "\n"),
    };
    await Promise.all(
      Object.entries(inputs).map(([name, data]) =>
        writeFile(join(dir, name), data, { mode: 0o600 }),
      ),
    );
    await exec(
      "openssl",
      [
        "smime",
        "-binary",
        "-sign",
        "-certfile",
        join(dir, "wwdr.pem"),
        "-signer",
        join(dir, "cert.pem"),
        "-inkey",
        join(dir, "key.pem"),
        "-passin",
        `file:${join(dir, "phrase")}`,
        "-in",
        join(dir, "manifest.json"),
        "-out",
        join(dir, "signature"),
        "-outform",
        "DER",
      ],
      { timeout: 10000, maxBuffer: 65536 },
    );
    return passArchive({
      ...files,
      "manifest.json": manifest,
      signature: await readFile(join(dir, "signature")),
    });
  } catch {
    throw Error("loyalty_apple_signing_failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
