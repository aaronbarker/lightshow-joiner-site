/**
 * Minimal ZIP (STORE / no compression) so the browser can download
 * joined .fseq + .mp3 as one file without extra libraries.
 */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let crc = i;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  CRC_TABLE[i] = crc >>> 0;
}

export function crc32(bytes) {
  const data = toUint8(bytes);
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toUint8(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("ZIP entry data must be a typed array or ArrayBuffer");
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function writeUtf8(name) {
  return new TextEncoder().encode(name);
}

/**
 * @param {{ name: string, data: Uint8Array|ArrayBuffer }[]} entries
 * @returns {Uint8Array}
 */
export function createZipStore(entries, date = new Date()) {
  if (!entries?.length) throw new Error("ZIP needs at least one file");
  const { dosTime, dosDate } = dosDateTime(date);
  const files = entries.map((entry) => {
    const nameBytes = writeUtf8(entry.name);
    const data = toUint8(entry.data);
    return {
      name: entry.name,
      nameBytes,
      data,
      crc: crc32(data),
      size: data.byteLength,
    };
  });

  let localSize = 0;
  for (const file of files) {
    localSize += 30 + file.nameBytes.length + file.size;
  }
  let centralSize = 0;
  for (const file of files) {
    centralSize += 46 + file.nameBytes.length;
  }
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;
  const localOffsets = [];

  for (const file of files) {
    localOffsets.push(offset);
    view.setUint32(offset, 0x04034b50, true); // local header
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 flag
    view.setUint16(offset + 8, 0, true); // STORE
    view.setUint16(offset + 10, dosTime, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, file.crc, true);
    view.setUint32(offset + 18, file.size, true);
    view.setUint32(offset + 22, file.size, true);
    view.setUint16(offset + 26, file.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(file.nameBytes, offset + 30);
    out.set(file.data, offset + 30 + file.nameBytes.length);
    offset += 30 + file.nameBytes.length + file.size;
  }

  const centralOffset = offset;
  files.forEach((file, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, dosTime, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, file.crc, true);
    view.setUint32(offset + 20, file.size, true);
    view.setUint32(offset + 24, file.size, true);
    view.setUint16(offset + 28, file.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, localOffsets[index], true);
    out.set(file.nameBytes, offset + 46);
    offset += 46 + file.nameBytes.length;
  });

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, files.length, true);
  view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - centralOffset, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);
  return out;
}
