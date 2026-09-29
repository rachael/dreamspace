// Speech-to-text proxy: POST /api/stt (raw audio body) -> whisper-server (whisper.cpp) -> {text}.
//
// whisper-server must be started with --convert (ffmpeg on PATH) so it accepts the webm/opus (Chrome, Quest) and
// fragmented mp4/aac (iOS Safari MediaRecorder) that browsers record:
//   whisper-server -m models/ggml-base.en.bin --host 127.0.0.1 --port 8178 --convert
// It takes multipart form data with the audio in a field named `file` (any other field name -> 400) and answers
// {"text":" Make the fog a little darker.\n"}. Silence comes back as "[BLANK_AUDIO]", which we turn into "".

const DEFAULT_URL = 'http://127.0.0.1:8178';

export function whisperUrl() {
  return String(process.env.WHISPER_URL || DEFAULT_URL).replace(/\/+$/, '');
}

const EXT = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/mp4': 'mp4', 'video/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
};

/** Pick a file extension from the Content-Type (whisper-server's --convert sniffs the data, so this is a hint). */
function extensionFor(contentType = '', buf) {
  const base = String(contentType).split(';')[0].trim().toLowerCase();
  if (EXT[base]) return EXT[base];
  if (buf && buf.length >= 12) {
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'wav';
    if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
    if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  }
  return 'webm';
}

/**
 * Strip whisper's non-speech annotations: "[BLANK_AUDIO]", "[Music]", "(wind blowing)", "*sighs*".
 * A transcript that is only annotations becomes "".
 */
export function cleanTranscript(raw) {
  let s = String(raw ?? '');
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\*[^*]*\*/g, ' ').replace(/♪+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  return s;
}

let healthCache = { at: 0, ok: false, pending: null };

/** Is whisper-server answering GET /health? Cached for `maxAgeMs`. Never throws. */
export async function whisperAvailable({ timeoutMs = 1500, maxAgeMs = 3000 } = {}) {
  const now = Date.now();
  if (now - healthCache.at < maxAgeMs) return healthCache.ok;
  if (healthCache.pending) return healthCache.pending;
  healthCache.pending = (async () => {
    let ok = false;
    try {
      const r = await fetch(`${whisperUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      ok = r.ok;
      await r.body?.cancel?.();
    } catch { ok = false; }
    healthCache = { at: Date.now(), ok, pending: null };
    return ok;
  })();
  return healthCache.pending;
}

export class SttError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

/**
 * Transcribe one clip. Returns the cleaned text ("" for silence).
 * Throws SttError(503) when whisper-server is unreachable, SttError(502) when it answers with an error.
 */
export async function transcribe(buf, { contentType = '', timeoutMs = 30000, prompt } = {}) {
  if (!buf || !buf.length) throw new SttError('empty audio', 400);
  const ext = extensionFor(contentType, buf);
  const mime = String(contentType).split(';')[0].trim() || 'application/octet-stream';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  if (prompt) form.append('prompt', String(prompt).slice(0, 400));
  let res;
  try {
    res = await fetch(`${whisperUrl()}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    healthCache = { at: Date.now(), ok: false, pending: null };
    const code = e?.cause?.code || e?.name || '';
    if (code === 'TimeoutError' || code === 'AbortError') throw new SttError('speech-to-text took too long', 504);
    throw new SttError('speech-to-text is not running (start whisper-server)', 503);
  }
  const body = await res.text();
  if (!res.ok) throw new SttError(`whisper-server answered ${res.status}: ${body.slice(0, 200).trim()}`, 502);
  let data;
  try { data = JSON.parse(body); } catch { data = { text: body }; }
  if (data && typeof data.error === 'string') throw new SttError(`whisper-server: ${data.error.slice(0, 200)}`, 502);
  return cleanTranscript(data?.text ?? '');
}
