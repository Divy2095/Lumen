# Lumen

**A media processing API for developers.**

An app or website sends a video to Lumen. Lumen validates it, extracts its metadata, generates thumbnails, and transcodes it into multiple resolutions in background workers. It retries on failure and reports back when the work is done.

Developers integrate Lumen with an API key (and later an SDK) instead of building and operating their own video pipeline.

> Status: early development. 

---

## Who is who

| Term | Meaning |
|---|---|
| **Developer** (tenant) | Lumen's customer. Integrates Lumen into their product using an API key. |
| **End user** | The developer's user. Uploads a video through the developer's app. Never talks to Lumen with an API key. |
| **Job** | One unit of work: one uploaded video plus what we should do with it. |
| **Output** | A file Lumen produces for a job: a thumbnail or a transcoded rendition. |

---

## MVP scope

    Video ingestion: accept MP4 uploads with a maximum size of 100 MB.

    Job orchestration: create processing jobs and schedule background tasks.

    Metadata extraction: duration, dimensions, codecs, frame rate and other supported metadata.

    Thumbnail generation: generate preview images.

    Transcoding: generate supported lower-resolution MP4 renditions without upscaling.

    Status and asset retrieval: expose processing status and generated asset information through the API.

    API authentication: API-key authentication and project-level ownership checks before public release.

    Webhooks: signed completion and failure events with retry support.

## Future enhancements: 
HLS adaptive streaming, resumable uploads using tus, SDKs, usage analytics and a more comprehensive developer dashboard.

Background workers and durable job scheduling are foundational architecture components, not optional features.

---

## What the finished product looks like

- **A website** with an introduction to Lumen, full documentation, and integration guides.
- **A live demo** on that site where anyone can upload a short video and watch the pipeline run, with strict size and rate limits.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React + TypeScript |
| Backend | Node.js + TypeScript |
| Package manager | npm (runtime stays Node.js) |
| Database | PostgreSQL (source of truth) |
| Queue | Redis, with BullMQ |
| Video processing | FFmpeg and ffprobe |
| Resumable uploads | tus protocol |
| Local development | Docker Compose |
| CI | GitHub Actions |



---

## Repository layout
