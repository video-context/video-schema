# Video Schema

**An open JSON schema for video data.** One document describes one video: shots, scenes, chapters, a transcript, on-screen text (OCR), labels, objects, logos, safety flags, and keyframes. Every item has a start and an end time in seconds.

The package also converts the output of video AI services into this schema:

| Source | Function | CLI |
| --- | --- | --- |
| Google Cloud Video Intelligence API | `fromGoogleVideoIntelligence()` | `--from google` |
| Amazon Rekognition Video | `fromRekognition()` | `--from rekognition` |
| Amazon Transcribe | `fromTranscribe()` | `--from transcribe` |

Use it to move from one video API to another, to compare video models on one format, or to give an AI agent video data that it can read.

[Video Context](https://videocontextapi.com) maintains this schema. It is the same shape that the Video Context API returns.

## Why a schema for video data

Each video API has its own output format. Google uses `annotationResults` with protobuf durations. Amazon Rekognition uses milliseconds and returns labels at sampled timestamps. Amazon Transcribe returns a flat list of words and punctuation.

If you change the model, you must change your code. If you use two models, you must join two formats. This schema gives you one stable format:

- **One time unit.** All times are seconds, as numbers.
- **Spans, not samples.** Detections at sampled timestamps join into `start` and `end` spans.
- **Scores from 0 to 1.** Confidence values from 0 to 100 change to 0 to 1.
- **Normalized boxes.** Bounding boxes use `x`, `y`, `w`, and `h` as fractions of the frame.
- **Provenance.** Each document records which source filled which track.

## Example

This is an illustrative document. See [`examples/keynote.json`](examples/keynote.json) for the full file.

```json
{
  "schema_version": "0.1",
  "video_id": "vid_8f2c",
  "duration": 1843.2,
  "summary": "Product launch keynote for the v4 release.",
  "scenes": [
    { "start": 0.0, "end": 41.6, "label": "Cold open, city b-roll" },
    { "start": 41.6, "end": 212.9, "label": "CEO on stage, intro" }
  ],
  "transcript": [
    { "start": 42.3, "end": 45.9, "speaker": "spk_0", "text": "Welcome, everyone, to the v4 launch." }
  ],
  "ocr": [{ "start": 88.4, "end": 93.0, "text": "Pro plan · $49/mo", "confidence": 0.97 }],
  "provenance": [{ "source": "google-video-intelligence", "tracks": ["scenes", "transcript", "ocr"] }]
}
```

## Install

```sh
npm install github:video-context/video-schema
```

The JSON Schema file is [`schema/video-context.schema.json`](schema/video-context.schema.json). It uses JSON Schema draft 2020-12, so you can use it from any language.

## Use

### Convert from the command line

```sh
# Google Video Intelligence: the operation response or the output file in Cloud Storage
npx video-schema convert --from google annotate-result.json > video.json

# Amazon Rekognition Video: one or more Get* responses join into one document
npx video-schema convert --from rekognition segments.json labels.json text.json > video.json

# Amazon Transcribe: the transcript JSON of a finished job
npx video-schema convert --from transcribe transcript.json > transcript.json

# Check a document against the schema
npx video-schema validate video.json
```

### Convert in code

```ts
import { fromGoogleVideoIntelligence, fromRekognition, fromTranscribe, mergeDocuments, validate } from '@video-context/schema'

const visual = fromRekognition([segments, labels, text])
const speech = fromTranscribe(transcript)
const video = mergeDocuments(visual, speech)

const { valid, errors } = validate(video)
```

## The schema

| Key | What it holds |
| --- | --- |
| `schema_version` | Always `"0.1"` for this version. Required. |
| `video_id`, `duration`, `language`, `summary` | Facts about the full video. |
| `media` | Container, codec, size, frame rate, and audio facts. |
| `shots` | Camera shots, from cut to cut. |
| `scenes` | Groups of shots, with an optional label. |
| `chapters` | Large sections, with a title. |
| `transcript` | Speech segments, with optional speakers and word timings. |
| `ocr` | Text on screen. |
| `labels` | What the video shows, such as `beach` or `football`. |
| `objects` | Objects and people, with optional bounding boxes over time. |
| `logos` | Brand logos. |
| `safety` | Content that can need a review, with a likelihood or a confidence. |
| `keyframes` | The times of the encoded keyframes. |
| `provenance` | The source of each track. |
| `extensions` | Data that the schema does not define, under a key for each source. |

## What the converters map

### Google Cloud Video Intelligence

| Google field | Schema key |
| --- | --- |
| `shotAnnotations` | `shots` |
| `segmentLabelAnnotations`, `shotLabelAnnotations`, `frameLabelAnnotations` | `labels` |
| `speechTranscriptions` (with `speakerTag`) | `transcript` |
| `textAnnotations` | `ocr` |
| `objectAnnotations` | `objects` |
| `logoRecognitionAnnotations` | `logos` |
| `explicitAnnotation` | `safety` |

### Amazon Rekognition Video and Amazon Transcribe

| AWS response | Schema key |
| --- | --- |
| `GetSegmentDetection` (`SHOT` segments) | `shots`, `media`, `duration` |
| `GetLabelDetection` | `labels`, and `objects` for labels with bounding boxes |
| `GetTextDetection` (`LINE` items) | `ocr` |
| `GetContentModeration` | `safety` |
| Amazon Transcribe output | `transcript` |

## Related

- [video-tools-mcp](https://github.com/video-context/video-tools-mcp): an MCP server that gives AI agents local video tools and returns this schema.
- [awesome-video-understanding](https://github.com/video-context/awesome-video-understanding): a list of video understanding APIs, models, tools, and datasets.
- [Video Context](https://videocontextapi.com): a video understanding API for apps and AI agents.
- [Migrate from the Google Video Intelligence API](https://videocontextapi.com/compare/google-video-intelligence-api-alternative/)

## Contribute

We want converters for more sources, such as Azure AI Video Indexer, Twelve Labs, Whisper, and PySceneDetect. To add a converter:

1. Add a file in `src/converters/`.
2. Add a real or documented sample output in `test/fixtures/`.
3. Add a test that validates the converted document.
4. Run `npm test`.

## License

MIT
