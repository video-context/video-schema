import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { VideoContext } from './types.js'

const schemaUrl = new URL('../schema/video-context.schema.json', import.meta.url)
export const schema = JSON.parse(readFileSync(schemaUrl, 'utf8'))

const ajv = new Ajv2020({ allErrors: true, strict: false })
;(addFormats as unknown as (a: Ajv2020) => void)(ajv)
const check = ajv.compile(schema)

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

// Checks a document against the schema, and checks that each span ends at or after its start.
export function validate(doc: unknown): ValidationResult {
  const errors: string[] = []
  if (!check(doc)) {
    for (const e of check.errors ?? []) errors.push(`${e.instancePath || '/'} ${e.message}`)
  }
  if (doc && typeof doc === 'object') {
    for (const [track, items] of Object.entries(doc as Record<string, unknown>)) {
      if (!Array.isArray(items)) continue
      items.forEach((item, i) => {
        if (item && typeof item === 'object' && 'start' in item && 'end' in item && (item as { end: number }).end < (item as { start: number }).start) {
          errors.push(`/${track}/${i} end is before start`)
        }
      })
    }
  }
  return { valid: errors.length === 0, errors }
}

export function isVideoContext(doc: unknown): doc is VideoContext {
  return validate(doc).valid
}
