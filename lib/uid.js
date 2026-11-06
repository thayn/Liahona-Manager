// Card UID normalization.
//
// The ball's PN532 reports a UID as raw bytes, which we store as uppercase hex with
// no separators, first byte first (e.g. NTAG215: "04A1B2C3D4E5F6", 7 bytes).
// USB "keyboard" readers type the UID in many formats: hex or decimal, with or
// without separators, sometimes with the byte order reversed. normalizeUid() turns
// whatever the reader typed into the ball's canonical form.

export const UID_FORMATS = ['auto', 'hex', 'hex-reversed', 'decimal', 'decimal-reversed'];

function reverseHexBytes(hex) {
  const bytes = hex.match(/../g) || [];
  return bytes.reverse().join('');
}

function decimalToHex(digits, byteLength) {
  let n = BigInt(digits);
  let hex = n.toString(16).toUpperCase();
  const width = Math.max(byteLength * 2, hex.length + (hex.length % 2));
  return hex.padStart(width, '0');
}

/**
 * @param {string} raw      text typed by the reader (or pasted)
 * @param {object} opts
 * @param {string} opts.format    one of UID_FORMATS
 * @param {number} opts.byteLength expected UID length in bytes (7 for NTAG21x)
 * @returns {{uid: string, detected: string}} canonical uppercase hex
 * @throws Error when the text can't be a UID
 */
export function normalizeUid(raw, { format = 'auto', byteLength = 7 } = {}) {
  if (typeof raw !== 'string') throw new Error('No card ID given');
  const text = raw.trim();
  if (!text) throw new Error('No card ID given');

  const compact = text.replace(/[\s:\-]/g, '');
  const isDigits = /^\d+$/.test(compact);
  const isHex = /^[0-9a-fA-F]+$/.test(compact);
  if (!isHex) throw new Error(`"${text}" is not a card ID (expected hex or decimal digits)`);

  let kind = format;
  if (format === 'auto') {
    const hadSeparators = compact.length !== text.length;
    if (!isDigits || hadSeparators) kind = 'hex';
    else if (compact.length === byteLength * 2) kind = 'hex';
    else kind = 'decimal';
  }

  let hex;
  if (kind === 'hex' || kind === 'hex-reversed') {
    hex = compact.toUpperCase();
    if (hex.length % 2) hex = '0' + hex;
  } else if (kind === 'decimal' || kind === 'decimal-reversed') {
    if (!isDigits) throw new Error(`"${text}" has letters, so it isn't decimal`);
    hex = decimalToHex(compact, byteLength);
  } else {
    throw new Error(`Unknown UID format "${format}"`);
  }

  if (kind.endsWith('-reversed')) hex = reverseHexBytes(hex);

  if (hex.length < 8 || hex.length > 20) {
    throw new Error(`"${text}" gives a ${hex.length / 2}-byte ID; card IDs are 4, 7 or 10 bytes`);
  }
  return { uid: hex, detected: kind };
}

/** Warn when the reader looks like it only sends part of a 7-byte NTAG UID. */
export function uidWarning(uid, byteLength = 7) {
  const bytes = uid.length / 2;
  if (bytes !== byteLength) {
    return `This ID is ${bytes} bytes but the tags are ${byteLength}-byte NTAG215s. The reader may be cutting the ID short or using a different format; check Settings.`;
  }
  if (byteLength === 7 && !uid.startsWith('04')) {
    return 'NTAG215 IDs normally start with 04. If this card is an NTAG215, try a reversed format in Settings.';
  }
  return null;
}
