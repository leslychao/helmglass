// Fixed-size visual marker for the controlled test Page only. Never inspect arbitrary pages.
export const MARKER = Object.freeze({ columns: 32, rows: 4, cell: 8, margin: 8, width: 272, height: 48 });

function uint32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Invalid marker value');
  return value;
}

function checksum(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

export function encodeMarker({ run, frame, nonce }) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4847);
  view.setUint32(2, uint32(run));
  view.setUint32(6, uint32(frame));
  view.setUint32(10, uint32(nonce));
  view.setUint16(14, checksum(bytes.subarray(0, 14)));
  return bytes;
}

export function decodeMarker(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0x4847 || view.getUint16(14) !== checksum(bytes.subarray(0, 14))) return null;
  return { run: view.getUint32(2), frame: view.getUint32(6), nonce: view.getUint32(10) };
}

export function paintMarker(context, marker) {
  const bytes = encodeMarker(marker);
  context.fillStyle = '#000';
  context.fillRect(0, 0, MARKER.width, MARKER.height);
  for (let bit = 0; bit < 128; bit++) {
    context.fillStyle = (bytes[bit >> 3] & (1 << (7 - (bit & 7)))) ? '#fff' : '#000';
    context.fillRect(MARKER.margin + (bit % MARKER.columns) * MARKER.cell,
      MARKER.margin + Math.floor(bit / MARKER.columns) * MARKER.cell, MARKER.cell, MARKER.cell);
  }
}

/** Reads cell centers, so H.264 edge ringing is not mistaken for data. */
export function markerFromPixels({ data, width, height }) {
  if (width !== MARKER.width || height !== MARKER.height || data.length !== width * height * 4) return null;
  const bytes = new Uint8Array(16);
  for (let bit = 0; bit < 128; bit++) {
    const x = MARKER.margin + (bit % MARKER.columns) * MARKER.cell + MARKER.cell / 2;
    const y = MARKER.margin + Math.floor(bit / MARKER.columns) * MARKER.cell + MARKER.cell / 2;
    let light = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const index = ((y + dy) * width + x + dx) * 4;
        light += (data[index] + data[index + 1] + data[index + 2]) / 3;
      }
    }
    light /= 9;
    if (light > 80 && light < 175) return null;
    if (light >= 175) bytes[bit >> 3] |= 1 << (7 - (bit & 7));
  }
  return decodeMarker(bytes);
}
