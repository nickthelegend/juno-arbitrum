import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/*
 * The installers resolve their platform binary when imported, so they are
 * imported on first use: an image upload never depends on the video tools
 * being present, and a missing binary fails only the video that needs it.
 */
const ffmpegPath = async () => (await import("@ffmpeg-installer/ffmpeg")).default.path;
const ffprobePath = async () => (await import("@ffprobe-installer/ffprobe")).default.path;

const run = promisify(execFile);

/** Width, height and duration of a video file. */
async function probeVideo(path: string): Promise<{ width: number; height: number; durationSec: number }> {
  const { stdout } = await run(await ffprobePath(), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:stream_side_data=rotation:format=duration",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number; side_data_list?: Array<{ rotation?: number }> }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0] ?? {};
  const rotation = Math.abs(stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  const rotated = rotation === 90 || rotation === 270;
  const width = stream.width ?? 0;
  const height = stream.height ?? 0;
  return {
    width: rotated ? height : width,
    height: rotated ? width : height,
    durationSec: Number(parsed.format?.duration ?? 0) || 0,
  };
}

/**
 * A still frame and the dimensions of an uploaded video. A reel needs a
 * poster: it is what lists draw and what shows while the video buffers. The
 * frame is taken half a second in, past the black fade many clips open on.
 */
export async function videoPoster(bytes: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const dir = await mkdtemp(join(tmpdir(), "juno-poster-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "poster.jpg");
    await writeFile(input, bytes);
    const meta = await probeVideo(input);
    const at = meta.durationSec > 1 ? "0.5" : "0";
    await run(await ffmpegPath(), ["-y", "-ss", at, "-i", input, "-frames:v", "1", "-q:v", "3", output]);
    return { jpeg: await readFile(output), width: meta.width, height: meta.height };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
