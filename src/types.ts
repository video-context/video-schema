// TypeScript types for schema/video-context.schema.json.
// All times are in seconds from the start of the video.

export const SCHEMA_VERSION = '0.1' as const

export interface Span {
  start: number
  end: number
}

export interface Media {
  url?: string
  container?: string
  size_bytes?: number
  bitrate?: number
  video?: {
    codec?: string
    width?: number
    height?: number
    fps?: number
    rotation?: number
    pixel_format?: string
  }
  audio?: {
    codec?: string
    channels?: number
    sample_rate?: number
  }
}

export interface Shot extends Span {
  confidence?: number
}

export interface Scene extends Span {
  label?: string
  confidence?: number
}

export interface Chapter extends Span {
  title: string
  summary?: string
}

export interface Word extends Span {
  text: string
  confidence?: number
  speaker?: string
}

export interface TranscriptSegment extends Span {
  text: string
  speaker?: string
  language?: string
  confidence?: number
  words?: Word[]
}

export interface TextItem extends Span {
  text: string
  confidence?: number
}

export interface Label extends Span {
  name: string
  category?: string
  confidence?: number
}

// x, y, w, and h are fractions of the frame size. x and y are the top-left corner.
export interface Box {
  t: number
  x: number
  y: number
  w: number
  h: number
}

export interface ObjectTrack extends Span {
  name: string
  track_id?: string
  confidence?: number
  boxes?: Box[]
}

export type Likelihood = 'very_unlikely' | 'unlikely' | 'possible' | 'likely' | 'very_likely'

export interface SafetyFlag extends Span {
  category: string
  parent_category?: string
  likelihood?: Likelihood
  confidence?: number
}

export interface Provenance {
  source: string
  model?: string
  tracks?: string[]
  created_at?: string
}

export interface VideoContext {
  schema_version: typeof SCHEMA_VERSION
  video_id?: string
  duration?: number
  language?: string
  summary?: string
  media?: Media
  shots?: Shot[]
  scenes?: Scene[]
  chapters?: Chapter[]
  transcript?: TranscriptSegment[]
  ocr?: TextItem[]
  labels?: Label[]
  objects?: ObjectTrack[]
  logos?: Label[]
  safety?: SafetyFlag[]
  keyframes?: number[]
  provenance?: Provenance[]
  extensions?: Record<string, unknown>
}

export type Track = Exclude<keyof VideoContext, 'schema_version' | 'video_id' | 'duration' | 'language' | 'summary' | 'media' | 'provenance' | 'extensions'>
