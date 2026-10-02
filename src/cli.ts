#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fromRekognition, fromTranscribe } from './converters/aws.js'
import { fromGoogleVideoIntelligence } from './converters/google-video-intelligence.js'
import { mergeDocuments } from './util.js'
import { validate } from './validate.js'
import type { VideoContext } from './types.js'

const USAGE = `Usage:
  video-schema convert --from <google|rekognition|transcribe> <file.json> [more files...]
  video-schema validate <file.json>

convert writes one Video Context document to stdout. With more than one file,
the files merge into one document. Use "-" to read from stdin.`

const read = (path: string): unknown => JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'))

const converters: Record<string, (input: unknown) => VideoContext> = {
  google: fromGoogleVideoIntelligence,
  rekognition: fromRekognition,
  transcribe: fromTranscribe,
}

function main(argv: string[]): number {
  const [command, ...rest] = argv
  if (command === 'validate' && rest[0]) {
    const result = validate(read(rest[0]))
    if (result.valid) {
      console.log('valid')
      return 0
    }
    for (const e of result.errors) console.error(e)
    return 1
  }
  if (command === 'convert') {
    const i = rest.indexOf('--from')
    const kind = i >= 0 ? rest[i + 1] : undefined
    const files = rest.filter((_, n) => n !== i && n !== i + 1)
    const convert = kind ? converters[kind] : undefined
    if (!convert || files.length === 0) {
      console.error(USAGE)
      return 2
    }
    const doc = files.length === 1 ? convert(read(files[0]!)) : kind === 'rekognition' ? fromRekognition(files.map(read)) : mergeDocuments(...files.map((f) => convert(read(f))))
    console.log(JSON.stringify(doc, null, 2))
    return 0
  }
  console.error(USAGE)
  return command ? 2 : 0
}

process.exitCode = main(process.argv.slice(2))
