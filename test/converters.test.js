import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fromGoogleVideoIntelligence, fromRekognition, fromTranscribe, mergeDocuments, validate } from '../dist/index.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

function assertValid(doc) {
  const result = validate(doc)
  assert.deepEqual(result.errors, [])
}

test('Google: REST operation response', () => {
  const doc = fromGoogleVideoIntelligence(fixture('google-rest.json'))
  assertValid(doc)
  assert.equal(doc.video_id, '/demo-bucket/keynote.mp4')
  assert.equal(doc.duration, 12.5)
  assert.deepEqual(doc.shots, [{ start: 0, end: 4.2 }, { start: 4.24, end: 12.5 }])
  assert.deepEqual(doc.labels.map((l) => [l.name, l.start, l.end]), [
    ['stage', 0, 12.5],
    ['microphone', 5, 6],
    ['microphone', 10, 10],
  ])
  assert.equal(doc.labels[0].category, 'event')
  // The diarization result sets speakers and does not become a third segment.
  assert.equal(doc.transcript.length, 2)
  assert.equal(doc.transcript[0].text, 'Welcome to the launch')
  assert.equal(doc.transcript[0].speaker, '1')
  assert.equal(doc.transcript[1].speaker, '2')
  assert.equal(doc.language, 'en-us')
  assert.deepEqual(doc.ocr, [{ start: 8.8, end: 11, text: 'PRO PLAN $49', confidence: 0.98 }])
  assert.equal(doc.objects[0].name, 'person')
  assert.deepEqual(doc.objects[0].boxes[1], { t: 5, x: 0.32, y: 0, w: 0.3, h: 0.9 })
  assert.deepEqual(doc.logos, [{ start: 2, end: 3.5, name: 'Google', confidence: 0.83 }])
  assert.deepEqual(doc.safety, [{ start: 7, end: 8, category: 'explicit', likelihood: 'possible' }])
  assert.equal(doc.provenance[0].source, 'google-video-intelligence')
})

test('Google: Cloud Storage output file with snake_case keys', () => {
  const doc = fromGoogleVideoIntelligence(fixture('google-gcs.json'))
  assertValid(doc)
  assert.equal(doc.duration, 12.5)
  assert.deepEqual(doc.shots, [{ start: 0, end: 4.2 }, { start: 4.24, end: 12.5 }])
  assert.deepEqual(doc.safety, [{ start: 7, end: 7, category: 'explicit', likelihood: 'likely' }])
})

test('Google: an empty input throws', () => {
  assert.throws(() => fromGoogleVideoIntelligence({}), /annotationResults/)
})

test('Rekognition: segments, labels, text, and moderation', () => {
  const doc = fromRekognition([
    fixture('rekognition-segments.json'),
    fixture('rekognition-labels.json'),
    fixture('rekognition-text.json'),
    fixture('rekognition-moderation.json'),
  ])
  assertValid(doc)
  assert.equal(doc.duration, 12.5)
  assert.deepEqual(doc.media.video, { codec: 'h264', width: 1920, height: 1080, fps: 29.97 })
  assert.deepEqual(doc.media.audio, { codec: 'aac', channels: 2, sample_rate: 48000 })
  assert.deepEqual(doc.shots, [{ start: 0, end: 4.2, confidence: 0.992 }, { start: 4.24, end: 12.5, confidence: 0.975 }])
  assert.deepEqual(doc.labels.map((l) => [l.name, l.start, l.end]), [
    ['Crowd', 0, 12.5],
    ['Person', 4.5, 5],
    ['Stage', 9, 9],
  ])
  assert.equal(doc.objects.length, 1)
  assert.equal(doc.objects[0].boxes.length, 2)
  assert.deepEqual(doc.ocr, [{ start: 8.8, end: 9.8, text: 'PRO PLAN $49', confidence: 0.991 }])
  assert.deepEqual(doc.safety, [{ start: 7, end: 7.5, category: 'Graphic Violence', parent_category: 'Violence', confidence: 0.704 }])
})

test('Transcribe: sentences and speaker labels', () => {
  const doc = fromTranscribe(fixture('transcribe.json'))
  assertValid(doc)
  assert.equal(doc.video_id, 'keynote-job')
  assert.deepEqual(doc.transcript.map((s) => [s.text, s.start, s.end, s.speaker]), [
    ['Welcome to the launch.', 0.4, 1.6, 'spk_0'],
    ['Thanks.', 5, 5.4, 'spk_1'],
  ])
})

test('Transcribe: audio segments', () => {
  const doc = fromTranscribe(fixture('transcribe-audio-segments.json'))
  assertValid(doc)
  assert.equal(doc.language, 'en-US')
  assert.equal(doc.transcript.length, 1)
  assert.equal(doc.transcript[0].words.length, 4)
  assert.equal(doc.transcript[0].words[3].text, 'launch.')
})

test('mergeDocuments joins tracks from many sources', () => {
  const doc = mergeDocuments(fromRekognition(fixture('rekognition-segments.json')), fromTranscribe(fixture('transcribe.json')))
  assertValid(doc)
  assert.equal(doc.shots.length, 2)
  assert.equal(doc.transcript.length, 2)
  assert.deepEqual(doc.provenance.map((p) => p.source), ['amazon-rekognition', 'amazon-transcribe'])
})

test('validate finds errors', () => {
  assert.equal(validate({}).valid, false)
  assert.equal(validate({ schema_version: '0.1', shots: [{ start: 5, end: 2 }] }).valid, false)
  assert.equal(validate({ schema_version: '0.1', shots: [{ start: 0, end: 2, extra: 1 }] }).valid, false)
})

test('every example is valid', () => {
  for (const file of readdirSync(new URL('../examples/', import.meta.url))) {
    if (!file.endsWith('.json')) continue
    const doc = JSON.parse(readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'))
    const result = validate(doc)
    assert.deepEqual(result.errors, [], file)
  }
})
