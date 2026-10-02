// Converts a Google Cloud Video Intelligence API result into a Video Context document.
//
// Accepted input:
// - The REST `operations.get` response, or its `response` field (camelCase keys,
//   times as strings such as "1.500s").
// - The JSON file that the API writes to Cloud Storage with `outputUri`
//   (snake_case keys, times as { seconds, nanos }).
//
// Docs: https://cloud.google.com/video-intelligence/docs/reference/rest/v1/videos/annotate

import type { Label, Likelihood, ObjectTrack, SafetyFlag, TextItem, TranscriptSegment, VideoContext, Word } from '../types.js'
import { byTime, compact, createDocument, filledTracks, mergeDetections, round, score } from '../util.js'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

export interface GoogleOptions {
  // Two explicit-content frames join into one span when the gap between them is this many seconds or less.
  safetyGap?: number
  // Frame-level labels join into one span when the gap between them is this many seconds or less.
  labelGap?: number
}

const LIKELIHOODS: Likelihood[] = ['very_unlikely', 'unlikely', 'possible', 'likely', 'very_likely']

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

// Changes snake_case keys to camelCase, so that both output formats read the same way.
function normalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), normalize(v)]))
  }
  return value
}

// Reads a Duration: "1.5s", "1.5", { seconds: "1", nanos: 500000000 }, or a missing value (0).
export function seconds(value: Json): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseFloat(value.replace(/s$/, '')) || 0
  return Number(value.seconds ?? 0) + Number(value.nanos ?? 0) / 1e9
}

function span(segment: Json): { start: number; end: number } {
  return { start: round(seconds(segment?.startTimeOffset)), end: round(seconds(segment?.endTimeOffset)) }
}

function likelihood(value: Json): Likelihood | undefined {
  if (typeof value === 'number') return LIKELIHOODS[value - 1]
  if (typeof value === 'string') {
    const name = value.toLowerCase() as Likelihood
    return LIKELIHOODS.includes(name) ? name : undefined
  }
  return undefined
}

function labelsFrom(annotations: Json[] | undefined, gap: number): Label[] {
  const out: Label[] = []
  for (const a of annotations ?? []) {
    const name = a.entity?.description
    if (!name) continue
    const category = a.categoryEntities?.[0]?.description
    for (const s of a.segments ?? []) {
      out.push(compact({ ...span(s.segment), name, category, confidence: score(s.confidence) }))
    }
    if (a.frames?.length) {
      const detections = a.frames.map((f: Json) => ({ key: name, t: seconds(f.timeOffset), confidence: score(f.confidence) }))
      for (const m of mergeDetections(detections, gap)) {
        out.push(compact({ start: round(m.start), end: round(m.end), name, category, confidence: m.confidence }))
      }
    }
  }
  return out
}

function words(alt: Json): Word[] {
  return (alt.words ?? []).map((w: Json) =>
    compact({
      start: round(seconds(w.startTime)),
      end: round(seconds(w.endTime)),
      text: w.word ?? '',
      confidence: score(w.confidence),
      speaker: w.speakerTag ? String(w.speakerTag) : undefined,
    }),
  )
}

function transcriptFrom(transcriptions: Json[] | undefined): TranscriptSegment[] {
  const items = (transcriptions ?? [])
    .map((t: Json) => ({ language: t.languageCode as string | undefined, alt: t.alternatives?.[0] }))
    .filter((t) => t.alt)

  // With speaker diarization, the API adds one more result that repeats every
  // word with a speakerTag. Use it to set speakers, and do not output it as a segment.
  const speakerOf = new Map<number, string>()
  const last = items[items.length - 1]
  const others = items.slice(0, -1).reduce((n, t) => n + (t.alt.words?.length ?? 0), 0)
  const lastWords = last?.alt.words ?? []
  if (items.length > 1 && lastWords.length > 0 && lastWords.length >= others && lastWords.every((w: Json) => w.speakerTag)) {
    for (const w of lastWords) speakerOf.set(round(seconds(w.startTime)), String(w.speakerTag))
    items.pop()
  }

  const out: TranscriptSegment[] = []
  for (const { language, alt } of items) {
    const ws = words(alt).map((w) => compact({ ...w, speaker: w.speaker ?? speakerOf.get(w.start) }))
    const text = (alt.transcript ?? '').trim()
    if (!text || ws.length === 0) continue
    const speakers = new Set(ws.map((w) => w.speaker).filter(Boolean))
    out.push(
      compact({
        start: ws[0]!.start,
        end: ws[ws.length - 1]!.end,
        text,
        speaker: speakers.size === 1 ? [...speakers][0] : undefined,
        language,
        confidence: score(alt.confidence),
        words: ws,
      }),
    )
  }
  return out
}

function ocrFrom(annotations: Json[] | undefined): TextItem[] {
  const out: TextItem[] = []
  for (const a of annotations ?? []) {
    if (!a.text) continue
    for (const s of a.segments ?? []) out.push(compact({ ...span(s.segment), text: a.text, confidence: score(s.confidence) }))
  }
  return out
}

function objectsFrom(annotations: Json[] | undefined): ObjectTrack[] {
  return (annotations ?? [])
    .filter((a: Json) => a.entity?.description)
    .map((a: Json) => {
      const boxes = (a.frames ?? []).map((f: Json) => {
        const b = f.normalizedBoundingBox ?? {}
        const left = b.left ?? 0
        const top = b.top ?? 0
        return {
          t: round(seconds(f.timeOffset)),
          x: round(left),
          y: round(top),
          w: round(Math.max(0, (b.right ?? 0) - left)),
          h: round(Math.max(0, (b.bottom ?? 0) - top)),
        }
      })
      const bounds = a.segment ? span(a.segment) : { start: boxes[0]?.t ?? 0, end: boxes[boxes.length - 1]?.t ?? 0 }
      return compact({
        ...bounds,
        name: a.entity.description,
        track_id: a.trackId !== undefined ? String(a.trackId) : undefined,
        confidence: score(a.confidence),
        boxes: boxes.length ? boxes : undefined,
      })
    })
}

function logosFrom(annotations: Json[] | undefined): Label[] {
  const out: Label[] = []
  for (const a of annotations ?? []) {
    const name = a.entity?.description
    if (!name) continue
    const tracks = a.tracks?.length ? a.tracks : (a.segments ?? []).map((s: Json) => ({ segment: s }))
    for (const t of tracks) out.push(compact({ ...span(t.segment), name, confidence: score(t.confidence) }))
  }
  return out
}

function safetyFrom(explicit: Json, gap: number): SafetyFlag[] {
  const frames = (explicit?.frames ?? [])
    .map((f: Json) => ({ t: seconds(f.timeOffset), level: likelihood(f.pornographyLikelihood) }))
    .filter((f: { level?: Likelihood }) => f.level && LIKELIHOODS.indexOf(f.level) >= 2)
  // Each likelihood level becomes its own run of spans.
  return mergeDetections(
    frames.map((f: { t: number; level: Likelihood }) => ({ key: f.level, t: f.t })),
    gap,
  ).map((m) => ({ start: round(m.start), end: round(m.end), category: 'explicit', likelihood: m.key as Likelihood }))
}

export function fromGoogleVideoIntelligence(input: Json, options: GoogleOptions = {}): VideoContext {
  const data = normalize(input)
  const results: Json[] = data.response?.annotationResults ?? data.annotationResults ?? []
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('No annotationResults found. Pass the operation response or the output JSON file.')
  }
  const labelGap = options.labelGap ?? 1
  const safetyGap = options.safetyGap ?? 1

  const doc = createDocument()
  const first = results[0]
  if (first.inputUri) doc.video_id = first.inputUri
  if (first.segment && seconds(first.segment.startTimeOffset) === 0) {
    const end = seconds(first.segment.endTimeOffset)
    if (end > 0) doc.duration = round(end)
  }

  const shots = results.flatMap((r) => (r.shotAnnotations ?? []).map(span))
  const labels = results.flatMap((r) => [
    ...labelsFrom(r.segmentLabelAnnotations, labelGap),
    ...labelsFrom(r.shotLabelAnnotations, labelGap),
    ...labelsFrom(r.frameLabelAnnotations, labelGap),
  ])
  const seen = new Set<string>()
  const uniqueLabels = labels.filter((l) => {
    const key = `${l.name}|${l.start}|${l.end}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const tracks = {
    shots: byTime(shots),
    labels: byTime(uniqueLabels),
    transcript: byTime(results.flatMap((r) => transcriptFrom(r.speechTranscriptions))),
    ocr: byTime(results.flatMap((r) => ocrFrom(r.textAnnotations))),
    objects: byTime(results.flatMap((r) => objectsFrom(r.objectAnnotations))),
    logos: byTime(results.flatMap((r) => logosFrom(r.logoRecognitionAnnotations))),
    safety: byTime(results.flatMap((r) => safetyFrom(r.explicitAnnotation, safetyGap))),
  }
  for (const [key, items] of Object.entries(tracks)) {
    if (items.length) (doc as unknown as Record<string, unknown>)[key] = items
  }

  const language = doc.transcript?.find((t) => t.language)?.language
  if (language) doc.language = language
  doc.provenance = [{ source: 'google-video-intelligence', tracks: filledTracks(doc) }]
  return doc
}
