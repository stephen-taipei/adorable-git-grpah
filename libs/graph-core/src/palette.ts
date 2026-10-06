/** 卡通糖果色票。index 0 固定給 default branch。 */
export const PALETTE = [
  '#4fdc9a', // mint  (main)
  '#ff7a8a', // coral
  '#62b6ff', // sky
  '#ffd25e', // sun
  '#b58cff', // grape
  '#ffa45e', // peach
  '#b6e35a', // lime
  '#ff8fd0', // pink
  '#3fd0d4', // teal
] as const;

/** 卡通描邊色（深紫黑，比純黑柔和）。 */
export const OUTLINE_COLOR = '#2b2140';

export function colorAt(index: number): string {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? PALETTE[0];
}
