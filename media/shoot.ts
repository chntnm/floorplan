/**
 * Capture plumbing: screenshots and clips, scaled down on the way out.
 *
 * Captures are taken at deviceScaleFactor 2 and downscaled to a fixed width
 * rather than shot at 1x, because text rendered at 1x and enlarged by the reader
 * is the thing that makes a screenshot look like a photograph of a screen. ffmpeg
 * does the scaling — it is already a hard dependency of the GIF path, so the
 * still path may as well use the same tool and produce files that match.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/** Committed output. Referenced from README.md, so the path is part of the API. */
export const MEDIA_DIR = join(process.cwd(), 'docs', 'media');
/** Frames and full-size stills on the way to MEDIA_DIR. Gitignored. */
export const WORK_DIR = join(process.cwd(), 'media', '.work');

/** Wide enough to read a properties panel in, narrow enough to commit. */
const STILL_WIDTH = 1600;
/**
 * The clip is committed to the repository and re-committed every time it is
 * regenerated, so its size is a real cost. A shaded 3D render is close to the
 * worst case for GIF: 900px at 128 colours came to 2.5MB. 760 at 64, with a
 * coarse ordered dither that compresses instead of fighting the LZW run
 * lengths, is under a megabyte and looks the same at README width.
 */
const CLIP_WIDTH = 760;
const CLIP_COLORS = 64;
/** Above this the file grows faster than the motion improves. */
const CLIP_MAX_FPS = 10;

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

export function resetWork(): void {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
}

export type Region = { x: number; y: number; width: number; height: number };

/**
 * Photograph the whole window, one element, or a rectangle, into
 * `docs/media/<name>.png`.
 *
 * Cropping matters more here than it looks: a panel that scrolls is taller than
 * the window, so photographing the element gives a 500 × 2400 ribbon nobody can
 * read in a README. Most captures want the window; a few want a rectangle
 * measured off two elements.
 */
export async function still(
  page: Page,
  name: string,
  where?: Locator | Region,
): Promise<void> {
  const raw = join(WORK_DIR, `${name}.raw.png`);
  mkdirSync(dirname(raw), { recursive: true });
  if (!where) await page.screenshot({ path: raw });
  else if ('width' in where) await page.screenshot({ path: raw, clip: where });
  else await where.screenshot({ path: raw });

  ffmpeg([
    '-i',
    raw,
    '-vf',
    `scale='min(${STILL_WIDTH},iw)':-2:flags=lanczos`,
    join(MEDIA_DIR, `${name}.png`),
  ]);
}

/** Hold keys for a stretch of wall clock. */
export type HoldBeat = {
  hold: string[];
  /**
   * How long to hold, in milliseconds of wall clock.
   *
   * Deliberately not a frame count. The walk simulation integrates real elapsed
   * time, and a screenshot takes as long as it takes, so a beat counted in frames
   * turns a given number of degrees on one machine and a different number on the
   * next. Counted in milliseconds it is `TURN_SPEED_DEG`/`WALK_SPEED_MMS` times
   * the duration, everywhere — which is what lets a clip be aimed at a doorway.
   */
  ms: number;
  /**
   * Run once the beat's keys are released. This is where a clip asserts what it
   * just recorded — "by here the walker is in the bedroom" — which has to happen
   * mid-sequence, because a later beat can undo the thing being checked.
   */
  after?: () => Promise<void>;
};

/**
 * Drag to look, by an exact number of pixels.
 *
 * The way to aim a walker at a doorway. A turn key integrates elapsed time and so
 * lands wherever the frame rate leaves it, but mouse-look is applied per pointer
 * event: the yaw is `dx * LOOK_SENSITIVITY` degrees whatever the machine is doing,
 * which is the difference between walking through a door and into a wall.
 */
export type LookBeat = {
  look: { dx: number; dy?: number };
  /** Pointer moves to split the drag into. One frame is shot per move. */
  steps: number;
  after?: () => Promise<void>;
};

export type Beat = HoldBeat | LookBeat;

/**
 * Record a GIF of `target` while a scripted sequence of keys is held.
 *
 * Frames are screenshots rather than a recorded video: a video is the whole
 * lifetime of a browser context and would have to be trimmed by wall-clock
 * guesswork, where a frame loop starts and stops exactly where the script says.
 * The page keeps animating between screenshots, so the motion is real — it is
 * sampled irregularly, not stepped. Playback is a fixed frame rate over an
 * irregular sample, so the clip is roughly, not exactly, real time.
 */
export async function clip(
  page: Page,
  name: string,
  target: Locator,
  beats: Beat[],
): Promise<void> {
  const frames = join(WORK_DIR, name);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  let n = 0;
  /** Milliseconds of real time the frames span, excluding the `after` hooks. */
  let recorded = 0;
  const shoot = async () => {
    await target.screenshot({
      path: join(frames, `f${String(n++).padStart(4, '0')}.jpg`),
      type: 'jpeg',
      quality: 92,
    });
  };

  for (const beat of beats) {
    const beatStart = Date.now();
    if ('look' in beat) {
      const box = (await target.boundingBox())!;
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= beat.steps; i++) {
        await page.mouse.move(
          from.x + (beat.look.dx * i) / beat.steps,
          from.y + ((beat.look.dy ?? 0) * i) / beat.steps,
        );
        await shoot();
      }
      await page.mouse.up();
      recorded += Date.now() - beatStart;
      if (beat.after) await beat.after();
      continue;
    }

    for (const key of beat.hold) await page.keyboard.down(key);

    // Two timing hazards, and both of them aim the walker at the wrong wall.
    //
    // The key is released on the deadline rather than when the frame loop
    // finishes, because "shoot until the deadline passes, then release" holds for
    // up to one extra frame — at 140°/s that is ten degrees.
    //
    // And the frames are JPEG. `stepWalker` caps a step at MAX_STEP_SECONDS
    // (100ms), so any frame that costs longer than that quietly throws away the
    // difference: hold a key for 640ms of wall clock through 150ms PNG encodes
    // and the walker turns about 60°, not 90°. A JPEG of the canvas encodes in
    // well under the cap, which makes the clock and the simulation agree again.
    const until = Date.now() + beat.ms;
    let frameCost = 0;
    do {
      const started = Date.now();
      await shoot();
      frameCost = Date.now() - started;
    } while (Date.now() + frameCost <= until);

    const left = until - Date.now();
    if (left > 0) await page.waitForTimeout(left);
    for (const key of beat.hold) await page.keyboard.up(key);
    recorded += Date.now() - beatStart;
    if (beat.after) await beat.after();
  }

  // Play back at the rate the frames were actually taken, so the clip runs at the
  // speed the app runs at. A fixed frame rate over an irregular sample makes a
  // walk look like a run or a crawl depending on what the machine was doing.
  const fps = Math.max(4, Math.min(CLIP_MAX_FPS, Math.round((n / recorded) * 1000)));

  // One palette for the whole clip. A per-frame palette shimmers on the flat
  // wall fills, which is most of what is on screen here.
  ffmpeg([
    '-framerate',
    String(fps),
    '-i',
    join(frames, 'f%04d.jpg'),
    '-vf',
    `scale=${CLIP_WIDTH}:-2:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=${CLIP_COLORS}[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
    '-loop',
    '0',
    join(MEDIA_DIR, `${name}.gif`),
  ]);
}
