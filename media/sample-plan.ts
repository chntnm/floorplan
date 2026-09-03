import type { Page } from '@playwright/test';

/**
 * The floor plan the import capture imports.
 *
 * `e2e/fixtures.ts` builds a white PNG with a diagonal, which is the right fixture
 * for a test asserting pixel dimensions and the wrong one to photograph: the
 * calibration gate's whole subject is a drawing with a stated dimension on it, and
 * a blank rectangle shows none of that.
 *
 * Drawn with the browser's own 2D canvas rather than assembled byte by byte,
 * because this one needs text and arcs. Nothing about the app is being tested
 * here — it is a stand-in for the estate agent's PDF you would actually drop in.
 */
export async function samplePlanPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const W = 1400;
    const H = 980;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const c = canvas.getContext('2d')!;

    c.fillStyle = '#fdfcfa';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#1b1b1b';
    c.fillStyle = '#1b1b1b';
    c.lineCap = 'butt';

    const wall = (x1: number, y1: number, x2: number, y2: number, w = 16) => {
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
    };

    // Outer shell, broken where the front door and the windows go.
    const L = 160;
    const R = 1240;
    const T = 130;
    const B = 800;

    wall(L, T, 470, T);
    wall(560, T, R, T); // front door gap
    wall(R, T, R, 330);
    wall(R, 430, R, B); // window gap, east
    wall(R, B, 830, B);
    wall(720, B, L, B); // window gap, south
    wall(L, B, L, T);

    // Partition, with a doorway through it.
    wall(700, T, 700, 420);
    wall(700, 520, 700, B);

    // Door leaves and their swings.
    const swing = (hx: number, hy: number, r: number, from: number, to: number) => {
      c.lineWidth = 3;
      c.beginPath();
      c.arc(hx, hy, r, from, to);
      c.stroke();
    };
    c.lineWidth = 6;
    c.beginPath();
    c.moveTo(470, T);
    c.lineTo(470, T + 90);
    c.stroke();
    swing(470, T, 90, 0, Math.PI / 2);

    c.beginPath();
    c.moveTo(700, 420);
    c.lineTo(700 - 100, 420);
    c.stroke();
    swing(700, 420, 100, Math.PI, Math.PI * 1.5);

    // Windows: a thin pane inside the gap in the wall.
    c.lineWidth = 3;
    const pane = (x1: number, y1: number, x2: number, y2: number) => {
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
    };
    pane(R - 5, 330, R - 5, 430);
    pane(R + 5, 330, R + 5, 430);
    pane(720, B - 5, 830, B - 5);
    pane(720, B + 5, 830, B + 5);

    // The stated dimension the calibration line is drawn across.
    c.lineWidth = 1.5;
    const dimY = B + 90;
    c.beginPath();
    c.moveTo(L, dimY);
    c.lineTo(R, dimY);
    c.moveTo(L, dimY - 12);
    c.lineTo(L, dimY + 12);
    c.moveTo(R, dimY - 12);
    c.lineTo(R, dimY + 12);
    c.stroke();
    c.font = '30px Georgia, serif';
    c.textAlign = 'center';
    c.fillText('9.00 m', (L + R) / 2, dimY - 20);

    c.font = '26px Georgia, serif';
    c.fillText('LIVING / DINING', 430, 470);
    c.fillText('BEDROOM', 970, 470);

    c.textAlign = 'left';
    c.font = '22px Georgia, serif';
    c.fillStyle = '#555';
    c.fillText('GROUND FLOOR — SCALE 1:50', L, 70);

    return canvas.toDataURL('image/png');
  });

  return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}
