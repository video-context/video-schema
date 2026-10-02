// Converts Amazon Rekognition Video and Amazon Transcribe results into a Video Context document.
//
// Rekognition: pass one or more responses from GetSegmentDetection, GetLabelDetection,
// GetTextDetection, or GetContentModeration. Join the pages of a paginated response first.
// Docs: https://docs.aws.amazon.com/rekognition/latest/dg/video.html
//
// Transcribe: pass the transcript JSON file of a finished job.
// Docs: https://docs.aws.amazon.com/transcribe/latest/dg/how-input.html#how-output

import type { Label, Media, ObjectTrack, SafetyFlag, Shot, TextItem, TranscriptSegment, VideoContext, Word } from '../types.js'
import { byTime, compact, createDocument, filledTracks, mergeDetections, round, score } from '../util.js'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RekognitionOptions {
  // Detections at sampled timestamps join into one span when the gap between them is this many seconds or less.
  gap?: number
}

const ms = (value: Json): number => round(Number(value ?? 0) / 1000)

function mediaFrom(responses: Json[]): { media?: Media; duration?: number } {
  const video = responses.flatMap((r) => [r.VideoMetadata].flat()).find(Boolean)
  const audio = responses.flatMap((r) => [r.AudioMetadata].flat()).find(Boolean)
  if (!video && !audio) return {}
  const media: Media = compact({
    container: video?.Format,
    video: video
      ? compact({ codec: video.Codec, width: video.FrameWidth, height: video.FrameHeight, fps: video.FrameRate })
      : undefined,
    audio: audio ? compact({ codec: audio.Codec, channels: audio.NumberOfChannels, sample_rate: audio.SampleRate }) : undefined,
  })
  const durationMs = video?.DurationMillis ?? audio?.DurationMillis
  return { media, duration: durationMs !== undefined ? ms(durationMs) : undefined }
}

function shotsFrom(r: Json): Shot[] {
  return (r.Segments ?? [])
    .filter((s: Json) => s.Type === 'SHOT')
    .map((s: Json) => compact({ start: ms(s.StartTimestampMillis), end: ms(s.EndTimestampMillis), confidence: score(s.ShotSegment?.Confidence, 100) }))
}

// GetLabelDetection with AggregateBy=SEGMENTS gives spans. With TIMESTAMPS it gives
// samples, so the samples join into spans.
function labelsFrom(r: Json, gap: number): { labels: Label[]; objects: ObjectTrack[] } {
  const labels: Label[] = []
  const samples: Array<{ key: string; t: number; confidence?: number; category?: string }> = []
  const boxes = new Map<string, Array<{ t: number; x: number; y: number; w: number; h: number }>>()

  for (const d of r.Labels ?? []) {
    const name = d.Label?.Name
    if (!name) continue
    const category = d.Label.Categories?.[0]?.Name
    const confidence = score(d.Label.Confidence, 100)
    if (d.StartTimestampMillis !== undefined && d.EndTimestampMillis !== undefined) {
      labels.push(compact({ start: ms(d.StartTimestampMillis), end: ms(d.EndTimestampMillis), name, category, confidence }))
    } else {
      samples.push({ key: name, t: ms(d.Timestamp), confidence, category })
    }
    for (const i of d.Label.Instances ?? []) {
      const b = i.BoundingBox
      if (!b) continue
      const list = boxes.get(name) ?? []
      list.push({ t: ms(d.Timestamp ?? d.StartTimestampMillis), x: round(b.Left ?? 0), y: round(b.Top ?? 0), w: round(b.Width ?? 0), h: round(b.Height ?? 0) })
      boxes.set(name, list)
    }
  }

  const categories = new Map(samples.map((s) => [s.key, s.category]))
  for (const m of mergeDetections(samples, gap)) {
    labels.push(compact({ start: m.start, end: m.end, name: m.key, category: categories.get(m.key), confidence: m.confidence }))
  }

  // Labels with bounding boxes, such as Person or Car, also become object tracks.
  const objects: ObjectTrack[] = []
  for (const [name, list] of boxes) {
    const sorted = list.sort((a, b) => a.t - b.t)
    let current: ObjectTrack | undefined
    for (const box of sorted) {
      if (current && box.t - current.end <= gap) {
        current.end = box.t
        current.boxes!.push(box)
      } else {
        current = { start: box.t, end: box.t, name, boxes: [box] }
        objects.push(current)
      }
    }
  }
  return { labels, objects }
}

function ocrFrom(r: Json, gap: number): TextItem[] {
  const lines = (r.TextDetections ?? [])
    .filter((d: Json) => d.TextDetection?.Type === 'LINE' && d.TextDetection.DetectedText)
    .map((d: Json) => ({ key: d.TextDetection.DetectedText as string, t: ms(d.Timestamp), confidence: score(d.TextDetection.Confidence, 100) }))
  return mergeDetections(lines, gap).map((m) => compact({ start: m.start, end: m.end, text: m.key, confidence: m.confidence }))
}

function safetyFrom(r: Json, gap: number): SafetyFlag[] {
  const out: SafetyFlag[] = []
  const samples: Array<{ key: string; t: number; confidence?: number }> = []
  const parents = new Map<string, string>()
  for (const d of r.ModerationLabels ?? []) {
    const label = d.ModerationLabel
    if (!label?.Name) continue
    if (label.ParentName) parents.set(label.Name, label.ParentName)
    const confidence = score(label.Confidence, 100)
    if (d.StartTimestampMillis !== undefined && d.EndTimestampMillis !== undefined) {
      out.push(compact({ start: ms(d.StartTimestampMillis), end: ms(d.EndTimestampMillis), category: label.Name, parent_category: label.ParentName || undefined, confidence }))
    } else {
      samples.push({ key: label.Name, t: ms(d.Timestamp), confidence })
    }
  }
  for (const m of mergeDetections(samples, gap)) {
    out.push(compact({ start: m.start, end: m.end, category: m.key, parent_category: parents.get(m.key), confidence: m.confidence }))
  }
  return out
}

export function fromRekognition(responses: Json | Json[], options: RekognitionOptions = {}): VideoContext {
  const list: Json[] = [responses].flat()
  const gap = options.gap ?? 1
  const doc = createDocument()
  const { media, duration } = mediaFrom(list)
  if (duration !== undefined) doc.duration = duration
  if (media) doc.media = media

  const shots = list.flatMap(shotsFrom)
  const labelled = list.map((r) => labelsFrom(r, gap))
  const tracks = {
    shots: byTime(shots),
    labels: byTime(labelled.flatMap((l) => l.labels)),
    objects: byTime(labelled.flatMap((l) => l.objects)),
    ocr: byTime(list.flatMap((r) => ocrFrom(r, gap))),
    safety: byTime(list.flatMap((r) => safetyFrom(r, gap))),
  }
  for (const [key, items] of Object.entries(tracks)) {
    if (items.length) (doc as unknown as Record<string, unknown>)[key] = items
  }
  doc.provenance = [{ source: 'amazon-rekognition', tracks: filledTracks(doc) }]
  return doc
}

const SENTENCE_END = /[.?!]$/

export function fromTranscribe(input: Json): VideoContext {
  const results = input?.results
  if (!results?.items) throw new Error('No results.items found. Pass the Amazon Transcribe transcript JSON.')

  // Older outputs put speakers in results.speaker_labels. Newer outputs put them on each item.
  const speakerAt = new Map<string, string>()
  for (const s of results.speaker_labels?.segments ?? []) {
    for (const i of s.items ?? []) speakerAt.set(i.start_time, i.speaker_label)
  }

  // Punctuation joins the word before it.
  const words: Array<Word & { id?: number }> = []
  for (const item of results.items) {
    const alt = item.alternatives?.[0]
    if (!alt) continue
    if (item.type === 'punctuation') {
      const last = words[words.length - 1]
      if (last) last.text += alt.content
      continue
    }
    words.push(
      compact({
        id: item.id,
        start: round(Number(item.start_time)),
        end: round(Number(item.end_time)),
        text: alt.content,
        confidence: score(Number(alt.confidence)),
        speaker: item.speaker_label ?? speakerAt.get(item.start_time),
      }),
    )
  }

  const segments: TranscriptSegment[] = []
  const toSegment = (ws: Word[], text?: string): TranscriptSegment | undefined => {
    if (ws.length === 0) return undefined
    const speakers = new Set(ws.map((w) => w.speaker).filter(Boolean))
    const clean = ws.map(({ id: _id, ...w }: Word & { id?: number }) => w)
    return compact({
      start: ws[0]!.start,
      end: ws[ws.length - 1]!.end,
      text: text ?? ws.map((w) => w.text).join(' '),
      speaker: speakers.size === 1 ? [...speakers][0] : undefined,
      words: clean,
    })
  }

  if (results.audio_segments?.length && words.every((w) => w.id !== undefined)) {
    const byId = new Map(words.map((w) => [w.id, w]))
    for (const s of results.audio_segments) {
      const ws = (s.items ?? []).map((id: number) => byId.get(id)).filter(Boolean)
      const seg = toSegment(ws, s.transcript)
      if (seg) segments.push(seg)
    }
  } else {
    // Without audio segments, split at the end of each sentence or at a change of speaker.
    let current: Word[] = []
    for (const w of words) {
      if (current.length && w.speaker !== current[current.length - 1]!.speaker) {
        segments.push(toSegment(current)!)
        current = []
      }
      current.push(w)
      if (SENTENCE_END.test(w.text)) {
        segments.push(toSegment(current)!)
        current = []
      }
    }
    if (current.length) segments.push(toSegment(current)!)
  }

  const doc = createDocument()
  if (input.jobName) doc.video_id = input.jobName
  const language = results.language_code ?? input.language_code
  if (language) doc.language = language
  if (segments.length) doc.transcript = segments
  doc.provenance = [{ source: 'amazon-transcribe', tracks: filledTracks(doc) }]
  return doc
}
