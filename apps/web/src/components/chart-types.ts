export interface ChartSeries {
  id: string;
  shortCode: string;
  name: string;
  color: string;
  kind: 'model' | 'index' | 'monkey';
  /** Marks as [unix seconds, total paise as a string]. Converted to floats only for drawing. */
  points: [number, string][];
}
