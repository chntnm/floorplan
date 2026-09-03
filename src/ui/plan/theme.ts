/**
 * Canvas colours.
 *
 * Konva paints into a canvas and cannot read the CSS custom properties the rest of
 * the app is themed with, so the palette is mirrored here and picked from the same
 * `prefers-color-scheme` signal. The two lists have to be kept in step by hand;
 * global.css is the source they follow.
 */

import { useEffect, useState } from 'react';

export type PlanTheme = {
  gridMinor: string;
  gridMajor: string;
  axis: string;
  wallFill: string;
  wallStroke: string;
  roomFill: string;
  roomStroke: string;
  roomLabel: string;
  openingFill: string;
  /** The door-swing symbol: the arc and leaf line, and the sector behind them. */
  swingStroke: string;
  swingFill: string;
  /** Clearance zones on the selected item. */
  zoneStroke: string;
  zoneFill: string;
  placementFill: string;
  placementStroke: string;
  draft: string;
  snap: string;
  selection: string;
  dimension: string;
  dimensionText: string;
  /** Validation warnings — overlaps, headroom. Distinct from selection blue. */
  warning: string;
};

const LIGHT: PlanTheme = {
  gridMinor: '#e2e2dd',
  gridMajor: '#cfcfc8',
  axis: '#b6b6ad',
  wallFill: '#3b3b38',
  wallStroke: '#262624',
  roomFill: 'rgba(47, 111, 94, 0.09)',
  roomStroke: 'rgba(47, 111, 94, 0.5)',
  roomLabel: '#4a4a45',
  openingFill: '#f4f4f2',
  swingStroke: '#8c8c86',
  swingFill: 'rgba(140, 140, 134, 0.10)',
  zoneStroke: 'rgba(200, 84, 31, 0.55)',
  zoneFill: 'rgba(200, 84, 31, 0.10)',
  placementFill: 'rgba(120, 120, 130, 0.35)',
  placementStroke: '#6b6b66',
  draft: '#2f6f5e',
  snap: '#c8541f',
  selection: '#1f6fd0',
  dimension: '#c8541f',
  dimensionText: '#8a3a14',
  warning: '#c0392b',
};

const DARK: PlanTheme = {
  gridMinor: '#26262b',
  gridMajor: '#33333a',
  axis: '#45454e',
  wallFill: '#b9b9c0',
  wallStroke: '#dcdce1',
  roomFill: 'rgba(77, 157, 134, 0.13)',
  roomStroke: 'rgba(77, 157, 134, 0.55)',
  roomLabel: '#c2c2c8',
  openingFill: '#17171a',
  swingStroke: '#7e7e88',
  swingFill: 'rgba(150, 150, 165, 0.12)',
  zoneStroke: 'rgba(232, 131, 74, 0.6)',
  zoneFill: 'rgba(232, 131, 74, 0.12)',
  placementFill: 'rgba(150, 150, 165, 0.32)',
  placementStroke: '#91919a',
  draft: '#4d9d86',
  snap: '#e8834a',
  selection: '#5aa2f0',
  dimension: '#e8834a',
  dimensionText: '#f0a878',
  warning: '#e5645a',
};

const QUERY = '(prefers-color-scheme: dark)';

export function usePlanTheme(): PlanTheme {
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return dark ? DARK : LIGHT;
}
