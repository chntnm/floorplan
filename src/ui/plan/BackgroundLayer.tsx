import { useEffect, useState } from 'react';
import { Image as KonvaImage, Layer } from 'react-konva';
import type Konva from 'konva';
import type { Background } from '../../core/document';
import { effectiveMmPerPx } from '../../core/calibration';
import { docToScreen, screenToDoc, type Viewport } from '../../core/viewport';
import { assetUrl } from '../../state/assets';
import { moveBackground } from '../../state/actions';

type Props = {
  background: Background | undefined;
  viewport: Viewport;
  /** True only when the background is unlocked and the select tool is active. */
  interactive: boolean;
};

/**
 * Decode an asset into an image element the canvas can paint.
 *
 * The URL is minted from bytes the runtime store holds *now*, so it survives a
 * save-reload-open cycle: the alternative — keeping the `blob:` URL made at import
 * time — looks correct until the page is reloaded and then silently renders nothing.
 */
function useAssetImage(assetId: string | undefined): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!assetId) {
      setImage(null);
      return;
    }
    const url = assetUrl(assetId);
    if (!url) {
      setImage(null);
      return;
    }

    let live = true;
    const img = new window.Image();
    img.onload = () => {
      if (live) setImage(img);
    };
    // A background that fails to decode is not worth a dialog — the properties panel
    // already reports a missing plan, and the walls drawn over it still work.
    img.onerror = () => {
      if (live) setImage(null);
    };
    img.src = url;

    return () => {
      live = false;
    };
  }, [assetId]);

  return image;
}

/**
 * The imported floor plan, underneath everything else.
 *
 * Below the grid rather than above it: the grid is what you snap to, and a plan at
 * 45% opacity sitting on top of it makes the lines you are actually aiming at
 * harder to see.
 *
 * The Konva node carries the whole image-pixel to screen map — position, rotation
 * and `mmPerPx * scale` — so the raster is never resampled into document space. That
 * is also what makes recalibration cheap: one number changes and the node redraws.
 */
export function BackgroundLayer({ background, viewport, interactive }: Props) {
  const image = useAssetImage(background?.assetId);
  if (!background || !image) return null;

  const origin = docToScreen(viewport, background.transform.position);
  const pxPerImagePx = effectiveMmPerPx(background) * viewport.scale;

  const onDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    moveBackground(screenToDoc(viewport, { x: node.x(), y: node.y() }));
  };

  return (
    <Layer listening={interactive}>
      <KonvaImage
        image={image}
        x={origin.x}
        y={origin.y}
        scaleX={pxPerImagePx}
        scaleY={pxPerImagePx}
        rotation={background.transform.rotationDeg}
        opacity={background.opacity}
        draggable={interactive}
        onDragEnd={onDragEnd}
        listening={interactive}
      />
    </Layer>
  );
}
