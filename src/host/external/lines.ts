/**
 * Stream framing for external runs: a UTF-8-safe stdout line splitter and a
 * bounded stderr tail.
 */

import { StringDecoder } from 'node:string_decoder'

/** Longest single stdout line kept (in UTF-16 code units, ≈ bytes for JSON); longer lines are dropped. */
export const MAX_LINE_LENGTH = 8 * 1024 * 1024

/** Bytes of stderr kept for the Host log. */
export const STDERR_TAIL_BYTES = 16 * 1024

/**
 * Splits a byte stream into lines. Multi-byte UTF-8 characters split across
 * chunks are decoded intact; `\r\n` and `\n` both end a line (the `\r` is
 * removed). A line longer than the cap is dropped whole and reported once
 * through `onOverflow`, and the splitter resynchronizes at the next newline.
 */
export class LineSplitter {
  readonly #decoder = new StringDecoder('utf8')
  readonly #onLine: (line: string) => void
  readonly #onOverflow: (() => void) | undefined
  readonly #maxLength: number
  #parts: string[] = []
  #length = 0
  #discarding = false
  #ended = false

  /**
   * @param onLine - receives each complete line without its line ending.
   * @param options - the per-line cap and an overflow callback.
   */
  constructor(onLine: (line: string) => void, options: { maxLength?: number; onOverflow?: () => void } = {}) {
    this.#onLine = onLine
    this.#onOverflow = options.onOverflow
    this.#maxLength = options.maxLength ?? MAX_LINE_LENGTH
  }

  /**
   * Feed one chunk.
   * @param chunk - raw bytes or already-decoded text.
   */
  push(chunk: Uint8Array | string): void {
    if (this.#ended) return
    this.#text(typeof chunk === 'string' ? chunk : this.#decoder.write(Buffer.from(chunk)))
  }

  /** Flush a final unterminated line. Later pushes are ignored. */
  end(): void {
    if (this.#ended) return
    this.#text(this.#decoder.end())
    this.#ended = true
    if (!this.#discarding && this.#length > 0) this.#emit()
    this.#parts = []
    this.#length = 0
  }

  #text(text: string): void {
    let start = 0
    while (start <= text.length) {
      const newline = text.indexOf('\n', start)
      const piece = newline < 0 ? text.slice(start) : text.slice(start, newline)
      if (!this.#discarding) {
        this.#parts.push(piece)
        this.#length += piece.length
        if (this.#length > this.#maxLength) {
          this.#discarding = true
          this.#parts = []
          this.#length = 0
          this.#onOverflow?.()
        }
      }
      if (newline < 0) return
      if (this.#discarding) this.#discarding = false
      else this.#emit()
      start = newline + 1
    }
  }

  #emit(): void {
    let line = this.#parts.join('')
    this.#parts = []
    this.#length = 0
    if (line.endsWith('\r')) line = line.slice(0, -1)
    this.#onLine(line)
  }
}

/** Keeps the last `limit` bytes written to it. */
export class ByteTail {
  readonly #limit: number
  #chunks: Buffer[] = []
  #size = 0

  /** @param limit - bytes to keep. */
  constructor(limit = STDERR_TAIL_BYTES) {
    this.#limit = limit
  }

  /**
   * Append one chunk, dropping the oldest bytes beyond the limit.
   * @param chunk - raw bytes or text.
   */
  push(chunk: Uint8Array | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    this.#chunks.push(buffer)
    this.#size += buffer.byteLength
    while (this.#size > this.#limit && this.#chunks.length > 0) {
      const first = this.#chunks[0] as Buffer
      const excess = this.#size - this.#limit
      if (first.byteLength <= excess) {
        this.#chunks.shift()
        this.#size -= first.byteLength
      } else {
        this.#chunks[0] = first.subarray(excess)
        this.#size -= excess
      }
    }
  }

  /** The kept bytes as UTF-8 text (a character cut at the start decodes as U+FFFD). */
  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8')
  }
}
