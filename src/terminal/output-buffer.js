// Ring buffer de bytes: o cursor nunca volta, mesmo quando o historico antigo sai da memoria.
export class OutputBuffer {
  constructor(maxBytes = 1_048_576) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("Buffer deve conter pelo menos 4 bytes.");
    this.storage = Buffer.alloc(maxBytes);
    this.capacity = maxBytes;
    this.endOffset = 0;
  }

  get startOffset() { return Math.max(0, this.endOffset - this.capacity); }
  get size() { return Math.min(this.endOffset, this.capacity); }

  append(text) {
    const bytes = Buffer.from(text, "utf8");
    const nextEnd = this.endOffset + bytes.length;
    const kept = bytes.subarray(Math.max(0, bytes.length - this.capacity));
    const position = (nextEnd - kept.length) % this.capacity;
    const first = Math.min(kept.length, this.capacity - position);
    kept.copy(this.storage, position, 0, first);
    kept.copy(this.storage, 0, first);
    this.endOffset = nextEnd;
  }

  read(afterOffset = 0, maxBytes = 65_536) {
    if (!Number.isSafeInteger(afterOffset) || afterOffset < 0 || afterOffset > this.endOffset) {
      throw new Error("Cursor invalido para esta sessao.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("maxBytes deve ser inteiro >= 4.");
    let from = Math.max(afterOffset, this.startOffset);
    const isContinuation = (offset) => (this.storage[offset % this.capacity] & 0xc0) === 0x80;
    // Nunca entrega metade de um caractere UTF-8 quando o anel ou a pagina corta uma sequencia.
    while (from < this.endOffset && isContinuation(from)) from++;
    let to = Math.min(this.endOffset, from + maxBytes);
    while (to < this.endOffset && to > from && isContinuation(to)) to--;
    const bytes = Buffer.alloc(to - from);
    const position = from % this.capacity;
    const first = Math.min(bytes.length, this.capacity - position);
    this.storage.copy(bytes, 0, position, position + first);
    this.storage.copy(bytes, first, 0, bytes.length - first);
    return {
      output: bytes.toString("utf8"), cursor: to, startOffset: this.startOffset,
      endOffset: this.endOffset, truncatedBefore: afterOffset < this.startOffset,
      hasMore: to < this.endOffset, bytes: bytes.length
    };
  }
}
