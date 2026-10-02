import type { Span, Track, VideoContext } from './types.js'
import { SCHEMA_VERSION } from './types.js'

// Rounds a time to the millisecond, so that documents stay small and stable.
export function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

// Clamps a score to the range 0 to 1. Returns undefined for a missing score.
export function score(value: number | undefined, scale = 1): number | undefined {
  if (value === undefined || value === null || Number.isNaN(value)) return undefined
  return Math.round(Math.min(1, Math.max(0, value / scale)) * 10000) / 10000
}

// Removes keys whose value is undefined, so that the output matches the schema.
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

// Sorts items by start time, then by end time.
export function byTime<T extends Span>(items: T[]): T[] {
  return items.sort((a, b) => a.start - b.start || a.end - b.end)
}

// Joins detections of the same key into spans. Two detections join when the gap
// between them is `gap` seconds or less. Use this for services that report a
// label at sampled timestamps instead of as a span.
export function mergeDetections<T extends { key: string; t: number; confidence?: number }>(
  detections: T[],
  gap: number,
): Array<{ key: string; start: number; end: number; confidence?: number }> {
  const sorted = [...detections].sort((a, b) => a.key.localeCompare(b.key) || a.t - b.t)
  const spans: Array<{ key: string; start: number; end: number; confidence?: number }> = []
  for (const d of sorted) {
    const last = spans[spans.length - 1]
    if (last && last.key === d.key && d.t - last.end <= gap) {
      last.end = d.t
      if (d.confidence !== undefined) last.confidence = Math.max(last.confidence ?? 0, d.confidence)
    } else {
      spans.push({ key: d.key, start: d.t, end: d.t, confidence: d.confidence })
    }
  }
  return spans
}

// Makes a new document with the schema version set.
export function createDocument(init: Omit<Partial<VideoContext>, 'schema_version'> = {}): VideoContext {
  return { schema_version: SCHEMA_VERSION, ...init }
}

const MERGE_TRACKS: Track[] = ['shots', 'scenes', 'chapters', 'transcript', 'ocr', 'labels', 'objects', 'logos', 'safety', 'keyframes']

// Merges documents from different sources into one document. The first value
// wins for scalar fields. Tracks from all documents join and sort by time.
export function mergeDocuments(...docs: VideoContext[]): VideoContext {
  const out = createDocument()
  for (const doc of docs) {
    for (const key of ['video_id', 'duration', 'language', 'summary'] as const) {
      if (out[key] === undefined && doc[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = doc[key]
    }
    if (doc.media) out.media = { ...doc.media, ...out.media }
    for (const track of MERGE_TRACKS) {
      const items = doc[track] as unknown[] | undefined
      if (!items?.length) continue
      ;(out as unknown as Record<string, unknown[]>)[track] = [...((out[track] as unknown[]) ?? []), ...items]
    }
    if (doc.provenance) out.provenance = [...(out.provenance ?? []), ...doc.provenance]
    if (doc.extensions) out.extensions = { ...out.extensions, ...doc.extensions }
  }
  for (const track of MERGE_TRACKS) {
    const items = out[track]
    if (!items) continue
    if (track === 'keyframes') out.keyframes = [...new Set(out.keyframes)].sort((a, b) => a - b)
    else byTime(items as Span[])
  }
  return out
}

// Lists the tracks that a document fills. Use it to set provenance.tracks.
export function filledTracks(doc: VideoContext): string[] {
  return MERGE_TRACKS.filter((t) => (doc[t] as unknown[] | undefined)?.length)
}
